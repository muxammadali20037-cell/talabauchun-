import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps } from "../src/deps";
import { AiClient } from "../src/ai/client";
import { enqueueJob, getJob, jobView, JobWorker } from "../src/jobs/queue";
import { getBalance } from "../src/billing/credits";
import { createDocumentFromFile } from "../src/ingest/documents";
import { createQuiz } from "../src/quiz/service";
import { loadConfig } from "../src/config";
import { createTestDeps, makeUser } from "./helpers/deps";
import { fixture } from "./helpers/fixtures";
import { testWorker } from "./helpers/worker";
import { resumableJob } from "./helpers/resumable-job";

const here = path.dirname(fileURLToPath(import.meta.url));
const TSX = path.resolve(here, "../../../node_modules/.pnpm/node_modules/tsx/dist/cli.mjs");

let deps: Deps;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
});
afterAll(async () => cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await sleep(100);
  }
}

describe("worker restart (acceptance 15)", () => {
  it("a worker killed with SIGKILL mid-job: the lease expires, another worker resumes from the checkpoint and the credits are settled once", async () => {
    const user = await makeUser(deps);
    const balance0 = await getBalance(deps.sql, user.id);
    const { job } = await deps.sql.begin((tx) =>
      enqueueJob(tx, { kind: "test_resumable", userId: user.id, workspaceId: user.personal_workspace_id, idempotencyKey: `resume-${Date.now()}`, stages: ["extracting", "generating"], credits: 3 }),
    );
    expect(await getBalance(deps.sql, user.id)).toBe(balance0 - 3);

    const child = spawn(process.execPath, [TSX, path.join(here, "helpers/crash-worker.ts")], { env: { ...process.env, DATABASE_URL: deps.cfg.DATABASE_URL, LEASE_SEC: "2" }, stdio: "ignore" });
    const step1By = await until(async () => (await getJob(deps.sql, job.id))?.checkpoint.step1By as number | undefined);
    expect(step1By).not.toBe(process.pid);
    // hard crash of the process doing the work (tsx runs the script in a child of `child`)
    process.kill(step1By, "SIGKILL");
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));

    const worker = new JobWorker(deps.sql, { test_resumable: resumableJob({ holdMs: 0 }) }, { concurrency: 1, leaseSec: 2 });
    // while the dead worker's lease is still valid nobody else may take the job (no double work)
    const early = await getJob(deps.sql, job.id);
    if (early!.lease_expires_at && new Date(early!.lease_expires_at as unknown as string) > new Date()) expect(await worker.runOnce()).toBe(false);
    await until(async () => (await worker.runOnce()) || null, 10_000);

    const done = (await getJob(deps.sql, job.id))!;
    expect(done.status).toBe("completed");
    expect(done.attempts).toBe(2);
    expect(done.result).toEqual({ step1By, finishedBy: process.pid });
    // reserved 3, used 1: exactly one capture and one release of the remainder
    const ledger = await deps.sql<{ entry_type: string; amount: number }[]>`select entry_type, amount from credit_ledger where job_id = ${job.id} order by id`;
    expect(ledger).toEqual([{ entry_type: "reserve", amount: -3 }, { entry_type: "release", amount: 2 }, { entry_type: "capture", amount: 0 }]);
    expect(await getBalance(deps.sql, user.id)).toBe(balance0 - 1);
  }, 40_000);

  it("a job whose worker dies on its last allowed attempt is failed with a clear code and its credits come back", async () => {
    const user = await makeUser(deps);
    const balance0 = await getBalance(deps.sql, user.id);
    const { job } = await deps.sql.begin((tx) =>
      enqueueJob(tx, { kind: "test_resumable", userId: user.id, workspaceId: user.personal_workspace_id, idempotencyKey: `dead-${Date.now()}`, stages: ["extracting", "generating"], credits: 2, maxAttempts: 1 }),
    );
    // state left behind by a crashed worker: claimed (attempt 1 of 1), lease already expired
    await deps.sql`update generation_jobs set status = 'extracting', attempts = 1, locked_by = 'dead-host:1', lease_expires_at = now() - interval '1 second' where id = ${job.id}`;
    const worker = new JobWorker(deps.sql, { test_resumable: resumableJob({ holdMs: 0 }) }, { concurrency: 1, leaseSec: 2 });
    expect(await worker.runOnce()).toBe(false);
    const j = (await getJob(deps.sql, job.id))!;
    expect(jobView(j)).toMatchObject({ status: "failed", errorCode: "worker_lost" });
    expect(await getBalance(deps.sql, user.id)).toBe(balance0);
  });
});

/** Local stand-in for the Anthropic Messages endpoint returning 429s or hanging (tests only). */
function fakeAnthropic(mode: { kind: "429" } | { kind: "hang" }) {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    req.resume();
    if (mode.kind === "hang") return; // never answers: the client's timeout fires
    res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "5", "x-should-retry": "true" });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }));
  });
  return {
    async start() {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    hits: () => hits,
  };
}

describe("AI provider 429 / timeout (acceptance 15)", () => {
  it("429: the SDK retries a bounded number of times, the job retries with back-off up to max_attempts, then fails as ai_rate_limited and releases the credits", async () => {
    const fake = fakeAnthropic({ kind: "429" });
    const url = await fake.start();
    try {
      const cfg = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: deps.cfg.DATABASE_URL, STORAGE_DIR: deps.cfg.STORAGE_DIR, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key", AI_BASE_URL: url, AI_MAX_RETRIES: "2", AI_TIMEOUT_MS: "5000" } as never);
      const aiDeps: Deps = { ...deps, ai: new AiClient(cfg, deps.sql) };
      const user = await makeUser(aiDeps);
      const doc = await createDocumentFromFile(aiDeps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
      const worker = testWorker(aiDeps);
      await worker.drain();
      const balance0 = await getBalance(deps.sql, user.id);
      const q = await createQuiz(aiDeps, user, { method: "from_source", documentIds: [doc.documentId], settings: { count: 4 }, useAi: true, idempotencyKey: `ai429-${Date.now()}` });
      expect(await getBalance(deps.sql, user.id)).toBeLessThan(balance0);

      await worker.runOnce();
      let j = (await getJob(deps.sql, q.jobId))!;
      expect(j).toMatchObject({ status: "queued", error_code: "ai_rate_limited", attempts: 1 });
      expect(new Date(j.run_after as unknown as string).getTime()).toBeGreaterThan(Date.now()); // back-off, not a hot loop
      expect(fake.hits()).toBe(3); // 1 call + AI_MAX_RETRIES (2)

      for (let i = 0; i < 2; i++) {
        await deps.sql`update generation_jobs set run_after = now() where id = ${q.jobId}`;
        await worker.runOnce();
      }
      j = (await getJob(deps.sql, q.jobId))!;
      expect(jobView(j)).toMatchObject({ status: "failed", errorCode: "ai_rate_limited", attempts: 3 });
      expect(fake.hits()).toBe(9); // bounded: 3 attempts × 3 requests, then it stops
      await deps.sql`update generation_jobs set run_after = now() where id = ${q.jobId}`;
      await worker.runOnce();
      expect(fake.hits()).toBe(9);
      expect(await getBalance(deps.sql, user.id)).toBe(balance0);
      const failedCalls = await deps.sql<{ n: number }[]>`select count(*)::int as n from usage_events where user_id = ${user.id} and kind = 'ai_tokens' and not ok`;
      expect(failedCalls[0]!.n).toBe(3); // metered per logical call, visible to operators
    } finally {
      await fake.stop();
    }
  }, 60_000);

  it("timeout: a provider that never answers surfaces as a retryable ai timeout instead of hanging the worker", async () => {
    const fake = fakeAnthropic({ kind: "hang" });
    const url = await fake.start();
    try {
      const cfg = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: deps.cfg.DATABASE_URL, STORAGE_DIR: deps.cfg.STORAGE_DIR, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key", AI_BASE_URL: url, AI_MAX_RETRIES: "0", AI_TIMEOUT_MS: "300" } as never);
      const ai = new AiClient(cfg, deps.sql);
      const { z } = await import("zod");
      const t0 = Date.now();
      const err = await ai.structured({ task: "tutor", tier: "fast", system: "s", user: "u", schema: z.object({ a: z.string() }) }).catch((e) => e);
      expect(err).toMatchObject({ code: "timeout", retryable: true });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await fake.stop();
    }
  });
});

describe("lease ownership", () => {
  it("a worker whose lease was taken over writes nothing: no completion, no second credit settlement", async () => {
    const user = await makeUser(deps);
    const { job } = await deps.sql.begin((tx) =>
      enqueueJob(tx, { kind: "test_slow_owner", userId: user.id, workspaceId: user.personal_workspace_id, idempotencyKey: `owner-${Date.now()}`, stages: ["generating"], credits: 2 }),
    );
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new JobWorker(deps.sql, { test_slow_owner: async () => { await gate; return { result: { by: "slow" }, creditsUsed: 1 }; } }, { concurrency: 1, leaseSec: 60 });
    const running = slow.runOnce();
    await until(async () => (await getJob(deps.sql, job.id))?.locked_by);
    // simulate the lease expiring and a second worker taking the job and finishing it
    await deps.sql`update generation_jobs set lease_expires_at = now() - interval '1 second' where id = ${job.id}`;
    const fast = new JobWorker(deps.sql, { test_slow_owner: async () => ({ result: { by: "fast" }, creditsUsed: 1 }) }, { concurrency: 1, leaseSec: 60 });
    expect(await fast.runOnce()).toBe(true);
    release();
    await running;
    const j = (await getJob(deps.sql, job.id))!;
    expect(j.result).toEqual({ by: "fast" });
    const settled = await deps.sql`select entry_type from credit_ledger where job_id = ${job.id} and entry_type in ('capture','release')`;
    expect(settled.map((r) => r.entry_type).sort()).toEqual(["capture", "release"]);
  });
});
