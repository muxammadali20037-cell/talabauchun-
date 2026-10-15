import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config";
import { createDb } from "./db/index";
import type { Deps, Logger } from "./deps";
import { LocalStorage } from "./storage/local";
import { TelegramApi } from "./telegram/api";
import { AiClient } from "./ai/client";
import { VoyageEmbedder } from "./search/embeddings";

export function createDeps(cfg: Config, log: Logger): Deps {
  const sql = createDb(cfg.DATABASE_URL, cfg.DATABASE_POOL_MAX);
  const storageDir = path.resolve(cfg.STORAGE_DIR);
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  return {
    cfg,
    sql,
    storage: new LocalStorage(storageDir, cfg.SIGNING_SECRET),
    tg: cfg.TELEGRAM_BOT_TOKEN ? new TelegramApi(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_API_BASE) : null,
    ai: cfg.aiEnabled ? new AiClient(cfg, sql) : null,
    embedder: cfg.EMBEDDINGS_PROVIDER === "voyage" && cfg.VOYAGE_API_KEY ? new VoyageEmbedder(cfg.VOYAGE_API_KEY, cfg.EMBEDDINGS_MODEL) : null,
    log,
  };
}

export function consoleLogger(level: string): Logger {
  const silent = level === "silent";
  const write = (lvl: string) => (o: object | string, m?: string) => {
    if (silent) return;
    const line = typeof o === "string" ? { msg: o } : { ...o, msg: m };
    process.stdout.write(JSON.stringify({ level: lvl, time: new Date().toISOString(), ...line }) + "\n");
  };
  return { info: write("info"), warn: write("warn"), error: write("error") };
}
