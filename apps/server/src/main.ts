import { loadConfig, integrationStatus } from "./config";
import { consoleLogger, createDeps } from "./bootstrap";
import { migrate } from "./db/migrate";
import { buildApp } from "./http/app";
import { RoomHub } from "./rooms/hub";
import { runPolling } from "./telegram/polling";

/** API server: HTTP + Telegram webhook + room WebSockets. Background jobs run in worker-main.ts. */
const cfg = loadConfig();
const log = consoleLogger(cfg.LOG_LEVEL);
const deps = createDeps(cfg, log);
if (process.env.MIGRATE_ON_START !== "false") await migrate(deps.sql);
const hub = new RoomHub(deps);
await hub.start();
const app = await buildApp(deps, { hub });
await app.listen({ port: cfg.PORT, host: cfg.HOST });
log.info({ port: cfg.PORT, integrations: integrationStatus(cfg) }, "TALABA AI server started");

const polling = new AbortController();
if (process.env.TELEGRAM_MODE === "polling") void runPolling(deps, polling.signal);

const shutdown = async () => {
  polling.abort();
  await app.close();
  await hub.stop();
  await deps.sql.end({ timeout: 5 });
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
