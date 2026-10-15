import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../src/config";
import type { Deps } from "../../src/deps";
import { LocalStorage } from "../../src/storage/local";
import { upsertTelegramUser } from "../../src/auth/users";
import { createTestDb } from "./db";

export const TEST_BOT_TOKEN = "123456789:TEST-token-for-hmac-only";

export async function createTestDeps(env: Record<string, string> = {}): Promise<{ deps: Deps; cleanup: () => Promise<void>; cfg: Config }> {
  const db = await createTestDb();
  const storageDir = mkdtempSync(path.join(tmpdir(), "talaba-storage-"));
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: db.url,
    STORAGE_DIR: storageDir,
    TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: "talaba_test_bot",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret-test",
    PUBLIC_BASE_URL: "https://talaba.example",
    LOG_LEVEL: "silent",
    ...env,
  } as NodeJS.ProcessEnv);
  const quiet = { info: () => {}, warn: () => {}, error: (...a: unknown[]) => { if (process.env.TEST_DEBUG) console.error(...a); } };
  const deps: Deps = { cfg, sql: db.sql, storage: new LocalStorage(storageDir, cfg.SIGNING_SECRET), tg: null, ai: null, embedder: null, log: quiet };
  return { deps, cfg, cleanup: db.drop };
}

let tgSeq = 1000;
export async function makeUser(deps: Deps, overrides: { first_name?: string; language_code?: string; id?: number } = {}) {
  return upsertTelegramUser(deps.sql, deps.cfg, { id: overrides.id ?? tgSeq++ + Math.floor(Math.random() * 1e6), first_name: overrides.first_name ?? "Test", language_code: overrides.language_code ?? "uz" }, { privateChat: true });
}
