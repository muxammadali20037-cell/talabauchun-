import { loadConfig } from "./config";
import { consoleLogger, createDeps } from "./bootstrap";
import { migrate } from "./db/migrate";
import { JobWorker } from "./jobs/queue";
import { jobHandlers } from "./jobs/handlers";
import { OutboxSender } from "./telegram/outbox";
import { tickGroupRuns } from "./group/native-quiz";
import { slideJobHandlers } from "./slides/jobs";
import { cleanupExpiredExports } from "./account/data";

/**
 * Background worker: generation jobs (leases + checkpoints survive restarts),
 * Telegram outbox delivery with rate limits, and native group quiz scheduling.
 */
const cfg = loadConfig();
const log = consoleLogger(cfg.LOG_LEVEL);
const deps = createDeps(cfg, log);
await migrate(deps.sql);
const worker = new JobWorker(deps.sql, jobHandlers(deps, slideJobHandlers(deps)), { concurrency: cfg.WORKER_CONCURRENCY, leaseSec: cfg.WORKER_LEASE_SEC, log: (o, m) => log.warn(o, m) });
await worker.start();
const outbox = deps.tg ? new OutboxSender(deps.sql, deps.tg, (o, m) => log.warn(o, m)) : null;
outbox?.start();
const groupTimer = setInterval(() => void tickGroupRuns(deps).catch((e) => log.error({ err: String(e) }, "group tick failed")), 1000);
// data-export archives are offered for 7 days, then deleted
const cleanupTimer = setInterval(() => void cleanupExpiredExports(deps).catch((e) => log.error({ err: String(e) }, "export cleanup failed")), 3600_000);
log.info({ worker: worker.workerId, concurrency: cfg.WORKER_CONCURRENCY }, "worker started");

const shutdown = async () => {
  clearInterval(groupTimer);
  clearInterval(cleanupTimer);
  outbox?.stop();
  await worker.stop();
  await deps.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
