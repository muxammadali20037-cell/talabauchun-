import type { Config } from "./config";
import type { Sql } from "./db/index";
import type { LocalStorage } from "./storage/local";
import type { TelegramApi } from "./telegram/api";
import type { AiClient } from "./ai/client";
import type { Embedder } from "./search/embeddings";

export type Logger = {
  info: (o: object | string, m?: string) => void;
  warn: (o: object | string, m?: string) => void;
  error: (o: object | string, m?: string) => void;
};

/** Everything a service needs; created once per process (and per test). */
export type Deps = {
  cfg: Config;
  sql: Sql;
  storage: LocalStorage;
  tg: TelegramApi | null;
  ai: AiClient | null;
  embedder: Embedder | null;
  log: Logger;
};
