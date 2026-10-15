// After a restore: re-run account deletions recorded after the backup was taken.
import { loadConfig } from "../config";
import { consoleLogger, createDeps } from "../bootstrap";
import { reapplyDeletions } from "../account/data";

const cfg = loadConfig();
const deps = createDeps(cfg, consoleLogger(cfg.LOG_LEVEL));
const done = await reapplyDeletions(deps);
console.log(JSON.stringify({ reapplied: done.length, users: done }));
await deps.sql.end({ timeout: 5 });
