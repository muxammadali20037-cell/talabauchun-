import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/helpers/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
