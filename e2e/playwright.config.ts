import { defineConfig } from "@playwright/test";

const PORT = 8095;
export const BASE = `http://127.0.0.1:${PORT}`;
export const TEST_BOT_TOKEN = "123456789:E2E-token-for-hmac-only";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../docs/evidence/e2e/test-results",
  use: {
    baseURL: BASE,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" },
    locale: "uz-UZ",
    trace: "retain-on-failure",
  },
  webServer: {
    // fresh database + storage for every run, then API + worker in one process
    command:
      'psql -U postgres -h localhost -q -c "drop database if exists talaba_e2e with (force)" -c "create database talaba_e2e" && rm -rf ../.data/e2e-storage && node ../node_modules/.pnpm/node_modules/tsx/dist/cli.mjs ../apps/server/src/all-in-one.ts',
    url: `${BASE}/readyz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATABASE_URL: "postgres://postgres@localhost:5432/talaba_e2e",
      STORAGE_DIR: "../.data/e2e-storage",
      TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
      TELEGRAM_BOT_USERNAME: "talaba_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "e2e-secret",
      TELEGRAM_API_BASE: "http://127.0.0.1:9",
      PUBLIC_BASE_URL: BASE,
      MINIAPP_DIST_DIR: "../apps/miniapp/dist",
      LOG_LEVEL: process.env.E2E_LOG ?? "silent",
      WORKER_CONCURRENCY: "2",
      ADMIN_TELEGRAM_IDS: "4500001",
    },
  },
});
