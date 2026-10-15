// Applies webhook, commands, menu button and descriptions to the bot (run after each deploy that changes them).
import { loadConfig } from "../config";
import { consoleLogger, createDeps } from "../bootstrap";
import { configureTelegram } from "../telegram/setup";

const cfg = loadConfig();
const deps = createDeps(cfg, consoleLogger(cfg.LOG_LEVEL));
const result = await configureTelegram(deps, { webhook: process.env.TELEGRAM_MODE !== "polling" });
console.log(JSON.stringify(result, null, 2));
await deps.sql.end({ timeout: 5 });
