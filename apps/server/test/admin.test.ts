import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { signInitData } from "../src/auth/init-data";
import { AiClient, AiError } from "../src/ai/client";
import { createDocumentFromFile } from "../src/ingest/documents";
import { approveQuestions, createQuiz, getQuizForEditor, publishQuiz, reportQuestion } from "../src/quiz/service";
import { getBalance } from "../src/billing/credits";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { fixture } from "./helpers/fixtures";
import { anthropicStub } from "./helpers/ai-stub";
import { testWorker } from "./helpers/worker";
import { z } from "zod";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
const ADMIN_TG = 991001;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps({ ADMIN_TELEGRAM_IDS: String(ADMIN_TG), METRICS_TOKEN: "metrics-token-for-tests-123" }));
  app = await buildApp(deps, { logger: false });
});
afterAll(async () => {
  await app.close();
  await cleanup();
});

async function login(id: number, first_name = "U", ageSec = 0) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: "AAH" + id, user: JSON.stringify({ id, first_name, language_code: "uz" }) }, TEST_BOT_TOKEN);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  return { token: res.json().token as string, userId: res.json().user.id as string };
}

describe("admin access (acceptance 14/18 for operators)", () => {
  it("non-admins get 403 on every admin route; admins can read; mutations need a fresh session and are audited", async () => {
    const student = await login(700001, "Talaba");
    for (const url of ["/api/admin/overview", "/api/admin/metrics", "/api/admin/jobs", "/api/admin/payments", "/api/admin/audit", "/api/admin/users?q=a"]) {
      expect((await app.inject({ method: "GET", url, headers: auth(student.token) })).statusCode, url).toBe(403);
    }
    expect((await app.inject({ method: "PUT", url: "/api/admin/flags/pricing", headers: auth(student.token), payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/overview" })).statusCode).toBe(401);

    const admin = await login(ADMIN_TG, "Admin");
    const ov = await app.inject({ method: "GET", url: "/api/admin/overview", headers: auth(admin.token) });
    expect(ov.statusCode).toBe(200);
    expect(ov.json().users.total).toBeGreaterThanOrEqual(2);
    expect(ov.json().users.active_1d).toBeGreaterThanOrEqual(2);
    const m = await app.inject({ method: "GET", url: "/api/admin/metrics", headers: auth(admin.token) });
    expect(m.statusCode).toBe(200);
    expect(m.json().targets).toBeNull();
    expect(m.json().measured.retention).toBeInstanceOf(Array);

    // a session from initData signed 30 minutes ago (still accepted for sign-in) can read but not change anything,
    // and signing in again with that same initData does not make it fresh
    const old = await login(ADMIN_TG, "Admin", 30 * 60);
    expect((await app.inject({ method: "GET", url: "/api/admin/flags", headers: auth(old.token) })).statusCode).toBe(200);
    const stale = await app.inject({ method: "PUT", url: "/api/admin/flags/targets", headers: auth(old.token), payload: { enabled: true, data: { d7RetentionPct: 25 } } });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe("admin_reauth_required");

    const fresh = await login(ADMIN_TG, "Admin");
    const ok = await app.inject({ method: "PUT", url: "/api/admin/flags/targets", headers: { ...auth(fresh.token), "x-forwarded-for": "203.0.113.7" }, payload: { enabled: true, data: { d7RetentionPct: 25, firstResultMinutes: 10 } } });
    expect(ok.statusCode).toBe(200);
    const [a] = await deps.sql<{ action: string; ip: string; actor_id: string }[]>`select action, ip, actor_id from audit_events where action = 'flag.set' order by id desc limit 1`;
    expect(a).toMatchObject({ action: "flag.set", ip: "203.0.113.7", actor_id: fresh.userId });
    // targets are reported next to the measured values, not mixed in
    expect((await app.inject({ method: "GET", url: "/api/admin/metrics", headers: auth(fresh.token) })).json().targets).toEqual({ d7RetentionPct: 25, firstResultMinutes: 10 });
  });

  it("model config: switch a task's model, disable it (AI calls refuse cleanly), and roll back", async () => {
    const admin = await login(ADMIN_TG, "Admin");
    const stub = anthropicStub(() => ({ ok: true }));
    const ai = new AiClient(deps.cfg, deps.sql, stub.client);
    const call = () => ai.structured({ task: "tutor", tier: "fast", system: "s", user: "u", schema: z.object({ ok: z.boolean() }) });

    let r = await app.inject({ method: "PUT", url: "/api/admin/models/tutor", headers: auth(admin.token), payload: { model: "claude-sonnet-5-5", effort: "low" } });
    expect(r.statusCode).toBe(200);
    await new Promise((res) => setTimeout(res, 10));
    (ai as unknown as { modelCache: null }).modelCache = null;
    await call();
    expect(stub.calls.at(-1)!.model).toBe("claude-sonnet-5-5");

    r = await app.inject({ method: "PUT", url: "/api/admin/models/tutor", headers: auth(admin.token), payload: { model: "claude-sonnet-5-5", enabled: false } });
    (ai as unknown as { modelCache: null }).modelCache = null;
    await expect(call()).rejects.toBeInstanceOf(AiError);

    r = await app.inject({ method: "POST", url: "/api/admin/models/tutor/rollback", headers: auth(admin.token) });
    expect(r.json()).toEqual({ task: "tutor", restored: "claude-sonnet-5-5" });
    (ai as unknown as { modelCache: null }).modelCache = null;
    await call();
    expect(stub.calls.at(-1)!.model).toBe("claude-sonnet-5-5");
    r = await app.inject({ method: "POST", url: "/api/admin/models/tutor/rollback", headers: auth(admin.token) });
    // second rollback returns to the previous state again (the disabled one) – a toggle, never a lost setting
    expect(r.json().restored).toBe("claude-sonnet-5-5");
    expect((await app.inject({ method: "PUT", url: "/api/admin/models/not_a_task", headers: auth(admin.token), payload: { model: "claude-haiku-5-5" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/admin/models/tutor", headers: auth(admin.token), payload: { model: "gpt-x" } })).statusCode).toBe(400);
    const list = (await app.inject({ method: "GET", url: "/api/admin/models", headers: auth(admin.token) })).json();
    expect(list.map((x: { task: string }) => x.task)).toContain("quiz_generate");
  });

  it("moderation, support reply through the bot outbox, credit adjustment (idempotent) and failed-job retry", async () => {
    const admin = await login(ADMIN_TG, "Admin");
    const author = await login(700010, "Muallif");
    const reporter = await login(700011, "Kuzatuvchi");
    const { getUserById } = await import("../src/auth/users");
    const au = (await getUserById(deps.sql, author.userId))!;
    const ru = (await getUserById(deps.sql, reporter.userId))!;
    const doc = await createDocumentFromFile(deps, { user: au, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
    const worker = testWorker(deps);
    await worker.drain();
    const q = await createQuiz(deps, au, { method: "from_source", documentIds: [doc.documentId], settings: { count: 3 }, useAi: false, idempotencyKey: "admin-test-quiz-1" });
    await worker.drain();
    const ed = await getQuizForEditor(deps, au, q.quizId);
    await approveQuestions(deps, au, q.quizId, ed.questions.map((x: { id: string }) => x.id));
    await publishQuiz(deps, au, q.quizId);
    await deps.sql`update quizzes set visibility = 'link' where id = ${q.quizId}`;
    const pub = await getQuizForEditor(deps, au, q.quizId);
    // a user who never saw the question cannot report it; a member who did can
    await expect(reportQuestion(deps, ru, pub.questions[0]!.id, "wrong_key")).rejects.toThrow();
    await reportQuestion(deps, au, pub.questions[0]!.id, "wrong_key", "kalit xato");

    const reports = (await app.inject({ method: "GET", url: "/api/admin/reports", headers: auth(admin.token) })).json();
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ reason: "wrong_key", quiz_id: q.quizId });
    const res = await app.inject({ method: "POST", url: `/api/admin/reports/${reports[0].id}/resolve`, headers: auth(admin.token), payload: { status: "resolved", unpublishQuiz: true, note: "kalit tekshirilmoqda" } });
    expect(res.statusCode).toBe(200);
    expect((await deps.sql<{ visibility: string }[]>`select visibility from quizzes where id = ${q.quizId}`)[0]!.visibility).toBe("private");

    // support: the user wrote to /support; the reply is queued to their chat via the outbox
    const [t] = await deps.sql<{ id: string }[]>`insert into support_tickets (user_id, kind, body) values (${author.userId}, 'support', 'PDF ochilmayapti') returning id::text`;
    const rep = await app.inject({ method: "POST", url: `/api/admin/tickets/${t!.id}/reply`, headers: auth(admin.token), payload: { text: "Fayl qayta yuklandi, tekshirib koʻring.", status: "resolved" } });
    expect(rep.json()).toEqual({ ok: true, delivered: true });
    const [n] = await deps.sql<{ chat_id: string; payload: { text: string } }[]>`select chat_id::text, payload from notifications where user_id = ${author.userId} order by created_at desc limit 1`;
    expect(n).toMatchObject({ chat_id: "700010", payload: { text: `#${t!.id}: Fayl qayta yuklandi, tekshirib koʻring.` } });

    // credits: an adjustment with the same key applies once
    const before = await getBalance(deps.sql, author.userId);
    for (let i = 0; i < 2; i++) await app.inject({ method: "POST", url: `/api/admin/users/${author.userId}/credits`, headers: auth(admin.token), payload: { amount: 25, reason: "kompensatsiya: OCR xatosi", idempotencyKey: "comp-ticket-1" } });
    expect(await getBalance(deps.sql, author.userId)).toBe(before + 25);

    // failed job retry: from its checkpoint, without charging the student again
    await deps.sql`update generation_jobs set status = 'failed', error_code = 'ai_rate_limited', finished_at = now() where target_id = ${q.quizId}`;
    const [job] = await deps.sql<{ id: string }[]>`select id from generation_jobs where target_id = ${q.quizId}`;
    const listed = (await app.inject({ method: "GET", url: "/api/admin/jobs?status=failed", headers: auth(admin.token) })).json();
    expect(listed.map((j: { id: string }) => j.id)).toContain(job!.id);
    const balBefore = await getBalance(deps.sql, author.userId);
    expect((await app.inject({ method: "POST", url: `/api/admin/jobs/${job!.id}/retry`, headers: auth(admin.token) })).json()).toEqual({ queued: true });
    expect((await app.inject({ method: "POST", url: `/api/admin/jobs/${job!.id}/retry`, headers: auth(admin.token) })).statusCode).toBe(409);
    await worker.drain();
    expect((await deps.sql<{ status: string }[]>`select status from generation_jobs where id = ${job!.id}`)[0]!.status).toBe("completed");
    expect(await getBalance(deps.sql, author.userId)).toBe(balBefore);

    const audit = (await app.inject({ method: "GET", url: "/api/admin/audit", headers: auth(admin.token) })).json();
    expect(audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(["report.resolve", "ticket.reply", "credits.adjust", "job.retry"]));
    expect(audit.filter((a: { action: string }) => a.action === "credits.adjust").length).toBe(1);
  });

  it("/metrics: Prometheus text for the token or an admin session only", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const student = await login(700002, "S");
    expect((await app.inject({ method: "GET", url: "/metrics", headers: auth(student.token) })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer metrics-token-for-tests-123" } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("# TYPE talaba_http_request_duration_seconds histogram");
    expect(r.body).toMatch(/talaba_http_request_duration_seconds_count\{method="GET",route="\/api\/admin\/overview",status="2xx"\} \d+/);
    expect(r.body).toContain("talaba_outbox_pending");
    const admin = await login(ADMIN_TG, "Admin");
    expect((await app.inject({ method: "GET", url: "/metrics", headers: auth(admin.token) })).statusCode).toBe(200);
  });
});
