import { loadConfig, integrationStatus } from "./config";
import { consoleLogger, createDeps } from "./bootstrap";
import { migrate } from "./db/migrate";
import { buildApp } from "./http/app";
import { RoomHub } from "./rooms/hub";
import { JobWorker } from "./jobs/queue";
import { jobHandlers } from "./jobs/handlers";
import { slideJobHandlers } from "./slides/jobs";
import { cleanupExpiredExports } from "./account/data";
import { OutboxSender } from "./telegram/outbox";
import { tickGroupRuns } from "./group/native-quiz";
import { runPolling } from "./telegram/polling";

/**
 * API + worker in one process — for local development, end-to-end tests and
 * small single-VM pilots. Production can run main.ts and worker-main.ts as
 * separate processes against the same database.
 */
const cfg = loadConfig();
const log = consoleLogger(cfg.LOG_LEVEL);
const deps = createDeps(cfg, log);
await migrate(deps.sql);
const hub = new RoomHub(deps);
await hub.start();
const app = await buildApp(deps, { hub, logger: cfg.LOG_LEVEL !== "silent" });
const worker = new JobWorker(deps.sql, jobHandlers(deps, slideJobHandlers(deps)), { concurrency: cfg.WORKER_CONCURRENCY, leaseSec: cfg.WORKER_LEASE_SEC, log: (o, m) => log.warn(o, m) });
await worker.start();
const outbox = deps.tg ? new OutboxSender(deps.sql, deps.tg, (o, m) => log.warn(o, m)) : null;
outbox?.start();
const groupTimer = setInterval(() => void tickGroupRuns(deps).catch(() => {}), 1000);
// data-export archives are offered for 7 days, then deleted
const cleanupTimer = setInterval(() => void cleanupExpiredExports(deps).catch(() => {}), 3600_000);
await app.listen({ port: cfg.PORT, host: cfg.HOST });
log.info({ port: cfg.PORT, integrations: integrationStatus(cfg) }, "TALABA AI (all-in-one) started");
const polling = new AbortController();
if (process.env.TELEGRAM_MODE === "polling") void runPolling(deps, polling.signal);

const shutdown = async () => {
  polling.abort();
  clearInterval(groupTimer);
  clearInterval(cleanupTimer);
  outbox?.stop();
  await app.close();
  await hub.stop();
  await worker.stop();
  await deps.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
