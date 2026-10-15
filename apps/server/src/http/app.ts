import path from "node:path";
import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { z, ZodError } from "zod";
import { isLang, LANGS } from "@talaba/shared";
import type { Deps } from "../deps";
import { integrationStatus } from "../config";
import { validateInitData } from "../auth/init-data";
import { createSession, resolveSession, revokeSession } from "../auth/sessions";
import { getUserById, upsertTelegramUser, type UserRow } from "../auth/users";
import { getBalance } from "../billing/credits";
import { AppError, unauthorized } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { addDocumentVersion, createDocumentFromFile, createDocumentFromText, createDocumentFromUrl, deleteDocument, getDocument, getPageText, listDocuments } from "../ingest/documents";
import { getJob, jobView, requestCancel } from "../jobs/queue";
import { retrieve, describeLocator } from "../search/retrieve";
import * as quiz from "../quiz/service";
import * as practice from "../quiz/practice";
import * as rooms from "../rooms/service";
import type { RoomHub } from "../rooms/hub";
import { registerTelegramWebhook } from "../telegram/webhook";
import { registerDeckRoutes } from "./deck-routes";
import { registerGroupRoutes } from "./group-routes";
import { registerAdminRoutes } from "./admin-routes";
import { registerMetrics } from "./metrics";
import { registerStudyRoutes } from "./study-routes";
import { registerBillingRoutes } from "./billing-routes";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
    sessionToken?: string;
  }
}

const uuid = z.string().uuid();

export async function buildApp(deps: Deps, opts: { hub?: RoomHub; logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: deps.cfg.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.x-telegram-bot-api-secret-token"] },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!req.url.startsWith("/api/")) {
      // Telegram Web clients embed the Mini App in an iframe; only Telegram origins may frame it.
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' wss: https:; frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'self'",
      );
    } else reply.header("cache-control", "no-store");
  });

  // Limits are per session (hashed bearer token) when present, so a whole class behind one
  // campus NAT address is not throttled as a single client; anonymous calls fall back to IP.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? "s:" + sha256Hex(h.slice(7)).slice(0, 32) : "ip:" + req.ip;
    },
  });
  await app.register(multipart, { limits: { fileSize: deps.cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, ...(err.details ? { details: err.details } : {}) } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "validation_error", details: { issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) } } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413 || (err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") return reply.status(413).send({ error: { code: "file_too_large", details: { maxMb: deps.cfg.MAX_UPLOAD_MB } } });
    if (status === 429) return reply.status(429).send({ error: { code: "rate_limited" } });
    if (status && status < 500) return reply.status(status).send({ error: { code: "bad_request" } });
    req.log.error({ err }, "unhandled error");
    if (process.env.TEST_DEBUG) console.error(err);
    return reply.status(500).send({ error: { code: "internal_error" } });
  });

  const auth = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw unauthorized();
    req.user = await resolveSession(deps.sql, token);
    req.sessionToken = token;
  };
  const me = (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
    return req.user;
  };

  // ── health ──
  registerMetrics(app, deps, { connections: () => opts.hub?.connectionCount() ?? 0 });
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await deps.sql`select 1`;
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // ── auth ──
  app.post("/api/auth/telegram", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ initData: z.string().min(10).max(8192) }).parse(req.body);
    if (!deps.cfg.TELEGRAM_BOT_TOKEN) throw new AppError("telegram_not_configured", 503);
    const v = validateInitData(body.initData, deps.cfg.TELEGRAM_BOT_TOKEN, deps.cfg.TELEGRAM_INITDATA_MAX_AGE_SEC);
    const user = await upsertTelegramUser(deps.sql, deps.cfg, v.user);
    const session = await createSession(deps.sql, deps.cfg, user.id, "telegram_webapp", sha256Hex(v.hash));
    return { token: session.token, expiresAt: session.expiresAt, user: publicUser(user), startParam: v.startParam };
  });

  app.post("/api/auth/dev", async (req) => {
    if (!deps.cfg.DEV_AUTH_ENABLED || deps.cfg.NODE_ENV === "production") throw new AppError("not_found", 404);
    const body = z.object({ telegramId: z.number().int().positive(), firstName: z.string().default("Dev"), languageCode: z.string().optional() }).parse(req.body);
    const user = await upsertTelegramUser(deps.sql, deps.cfg, { id: body.telegramId, first_name: body.firstName, language_code: body.languageCode });
    const session = await createSession(deps.sql, deps.cfg, user.id, "dev");
    return { token: session.token, expiresAt: session.expiresAt, user: publicUser(user), startParam: null };
  });

  app.post("/api/auth/logout", { preHandler: auth }, async (req) => {
    await revokeSession(deps.sql, req.sessionToken!);
    return { ok: true };
  });

  // ── me / profile ──
  app.get("/api/me", { preHandler: auth }, async (req) => {
    const user = me(req);
    const [profile] = await deps.sql`select university, faculty, course, specialty, nickname, notifications_enabled, quiet_hours_start, quiet_hours_end from profiles where user_id = ${user.id}`;
    const status = integrationStatus(deps.cfg);
    return {
      user: publicUser(user),
      profile: profile ?? null,
      balance: await getBalance(deps.sql, user.id),
      features: { ai: deps.cfg.aiEnabled, semanticSearch: !!deps.embedder, payments: deps.cfg.PAYMENTS_ENABLED, botUsername: deps.cfg.TELEGRAM_BOT_USERNAME ?? null },
      ...(user.platform_role === "admin" ? { integrations: status } : {}),
    };
  });

  app.patch("/api/me", { preHandler: auth }, async (req) => {
    const user = me(req);
    const body = z
      .object({
        language: z.enum(LANGS).optional(),
        eduRole: z.enum(["student", "teacher"]).nullable().optional(),
        timezone: z.string().max(64).optional(),
        onboardingGoal: z.enum(["presentation", "quiz", "book", "question"]).optional(),
        onboarded: z.boolean().optional(),
        profile: z
          .object({
            university: z.string().max(200).nullable().optional(),
            faculty: z.string().max(200).nullable().optional(),
            course: z.number().int().min(1).max(8).nullable().optional(),
            specialty: z.string().max(200).nullable().optional(),
            nickname: z.string().max(40).nullable().optional(),
            notificationsEnabled: z.boolean().optional(),
            quietHoursStart: z.number().int().min(0).max(23).nullable().optional(),
            quietHoursEnd: z.number().int().min(0).max(23).nullable().optional(),
          })
          .optional(),
      })
      .parse(req.body);
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: body.timezone });
      } catch {
        throw new AppError("invalid_timezone", 400);
      }
    }
    await deps.sql`update users set
      language = coalesce(${body.language ?? null}, language),
      language_confirmed = language_confirmed or ${body.language != null},
      edu_role = ${body.eduRole === undefined ? deps.sql`edu_role` : body.eduRole},
      timezone = coalesce(${body.timezone ?? null}, timezone),
      onboarding_goal = coalesce(${body.onboardingGoal ?? null}, onboarding_goal),
      onboarded_at = case when ${body.onboarded ?? false} then coalesce(onboarded_at, now()) else onboarded_at end,
      updated_at = now()
      where id = ${user.id}`;
    if (body.profile) {
      const p = body.profile;
      await deps.sql`update profiles set
        university = ${p.university === undefined ? deps.sql`university` : p.university},
        faculty = ${p.faculty === undefined ? deps.sql`faculty` : p.faculty},
        course = ${p.course === undefined ? deps.sql`course` : p.course},
        specialty = ${p.specialty === undefined ? deps.sql`specialty` : p.specialty},
        nickname = ${p.nickname === undefined ? deps.sql`nickname` : p.nickname},
        notifications_enabled = coalesce(${p.notificationsEnabled ?? null}, notifications_enabled),
        quiet_hours_start = ${p.quietHoursStart === undefined ? deps.sql`quiet_hours_start` : p.quietHoursStart},
        quiet_hours_end = ${p.quietHoursEnd === undefined ? deps.sql`quiet_hours_end` : p.quietHoursEnd},
        updated_at = now() where user_id = ${user.id}`;
    }
    return { user: publicUser((await getUserById(deps.sql, user.id))!) };
  });

  // ── home dashboard: last work, nearest deadlines, due review cards ──
  app.get("/api/home", { preHandler: auth }, async (req) => {
    const user = me(req);
    const recent = await deps.sql<{ kind: string; id: string; title: string; updatedAt: Date; status: string | null }[]>`
      (select 'quiz' as kind, q.id, q.title, q.updated_at as "updatedAt", null::text as status from quizzes q
        where q.owner_id = ${user.id} and q.deleted_at is null order by q.updated_at desc limit 5)
      union all
      (select 'document', d.id, d.title, d.updated_at, null from documents d where d.owner_id = ${user.id} and d.deleted_at is null order by d.updated_at desc limit 5)
      union all
      (select 'deck', k.id, k.title, k.updated_at, k.status from decks k where k.owner_id = ${user.id} and k.deleted_at is null order by k.updated_at desc limit 5)
      order by "updatedAt" desc limit 8`;
    const deadlines = await deps.sql<{ id: string; title: string; dueAt: Date }[]>`
      select t.id, t.title, t.due_at as "dueAt" from tasks t
      where t.status in ('todo','in_progress') and t.due_at is not null and t.due_at > now() - interval '1 day'
        and (t.assignee_id = ${user.id} or (t.assignee_id is null and t.workspace_id in (select workspace_id from memberships where user_id = ${user.id})))
      order by t.due_at limit 5`;
    const [cards] = await deps.sql<{ n: number }[]>`select count(*)::int as n from flashcards where owner_id = ${user.id} and deleted_at is null and due_at <= now()`;
    return { recent, deadlines, dueCards: cards?.n ?? 0 };
  });

  app.get("/api/workspaces", { preHandler: auth }, async (req) => {
    const items = await deps.sql<{ id: string; name: string; kind: string; role: string; members: number }[]>`
      select w.id, w.name, w.kind, m.role, (select count(*)::int from memberships x where x.workspace_id = w.id) as members
      from memberships m join workspaces w on w.id = m.workspace_id
      where m.user_id = ${me(req).id} and w.deleted_at is null and w.kind = 'group' order by w.created_at desc limit 100`;
    return { items };
  });

  app.get("/api/rooms", { preHandler: auth }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const items = await deps.sql`
      select r.id, r.title, r.status, m.role, r.created_at, (select count(*)::int from room_members x where x.room_id = r.id and x.role <> 'host') as participants
      from room_members m join rooms r on r.id = m.room_id where m.user_id = ${me(req).id} order by r.created_at desc limit ${q.limit}`;
    return { items };
  });

  // ── documents ──
  app.get("/api/documents", { preHandler: auth }, async (req) => {
    const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().optional(), workspaceId: uuid.optional() }).parse(req.query);
    return listDocuments(deps, me(req), q);
  });
  app.post("/api/documents/upload", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const file = await req.file();
    if (!file) throw new AppError("file_missing", 400);
    const data = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    return createDocumentFromFile(deps, { user: me(req), filename: file.filename, data, via: "miniapp", title: fields.title?.value, workspaceId: fields.workspaceId?.value });
  });
  app.post("/api/documents/text", { preHandler: auth }, async (req) => {
    const body = z.object({ title: z.string().max(200), text: z.string().min(1).max(2_000_000), workspaceId: uuid.optional() }).parse(req.body);
    return createDocumentFromText(deps, { user: me(req), ...body, via: "miniapp" });
  });
  app.post("/api/documents/url", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ url: z.string().url().max(2000), workspaceId: uuid.optional() }).parse(req.body);
    return createDocumentFromUrl(deps, { user: me(req), ...body, via: "miniapp" });
  });
  app.get("/api/documents/:id", { preHandler: auth }, async (req) => getDocument(deps, me(req), uuid.parse((req.params as { id: string }).id)));
  app.get("/api/documents/:id/pages/:n", { preHandler: auth }, async (req) => {
    const p = z.object({ id: uuid, n: z.coerce.number().int().min(1) }).parse(req.params);
    return getPageText(deps, me(req), p.id, p.n);
  });
  app.delete("/api/documents/:id", { preHandler: auth }, async (req) => {
    await deleteDocument(deps, me(req), uuid.parse((req.params as { id: string }).id));
    return { ok: true };
  });
  app.post("/api/documents/:id/versions", { preHandler: auth }, async (req) => {
    const file = await req.file();
    if (!file) throw new AppError("file_missing", 400);
    return addDocumentVersion(deps, me(req), uuid.parse((req.params as { id: string }).id), file.filename, await file.toBuffer());
  });
  app.get("/api/search", { preHandler: auth }, async (req) => {
    const q = z.object({ q: z.string().min(2).max(500), documentIds: z.string().optional() }).parse(req.query);
    const user = me(req);
    const ids = q.documentIds ? q.documentIds.split(",").filter((x) => uuid.safeParse(x).success) : undefined;
    const hits = await retrieve(deps, { query: q.q, userId: user.id, documentIds: ids, limit: 10 });
    return { items: hits.map((h) => ({ ...h, where: describeLocator(h.locator, user.language) })), notFound: hits.length === 0 };
  });

  // ── jobs ──
  app.get("/api/jobs/:id", { preHandler: auth }, async (req) => {
    const job = await getJob(deps.sql, uuid.parse((req.params as { id: string }).id));
    if (!job || job.user_id !== me(req).id) throw new AppError("not_found", 404);
    return jobView(job);
  });
  app.post("/api/jobs/:id/cancel", { preHandler: auth }, async (req) => {
    const id = uuid.parse((req.params as { id: string }).id);
    const job = await getJob(deps.sql, id);
    if (!job || job.user_id !== me(req).id) throw new AppError("not_found", 404);
    await requestCancel(deps.sql, id);
    return { ok: true };
  });

  // ── quizzes ──
  app.post("/api/quizzes/estimate", { preHandler: auth }, async (req) => {
    const body = z.object({ method: z.enum(["from_source", "from_questions", "from_qa", "from_mistakes"]), settings: z.record(z.string(), z.unknown()).optional(), useAi: z.boolean().optional(), questionsCount: z.number().int().optional() }).parse(req.body);
    return quiz.estimateQuiz(deps, me(req), body as never);
  });
  app.post("/api/quizzes", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => quiz.createQuiz(deps, me(req), req.body));
  app.get("/api/quizzes", { preHandler: auth }, async (req) => {
    const q = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().optional() }).parse(req.query);
    return quiz.listQuizzes(deps, me(req), q);
  });
  const qid = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);
  const questionId = (req: FastifyRequest) => uuid.parse((req.params as { qid: string }).qid);
  app.get("/api/quizzes/:id/editor", { preHandler: auth }, async (req) => quiz.getQuizForEditor(deps, me(req), qid(req)));
  app.get("/api/quizzes/:id/preview", { preHandler: auth }, async (req) => quiz.getQuizPreview(deps, me(req), qid(req)));
  app.patch("/api/quizzes/:id", { preHandler: auth }, async (req) => {
    await quiz.renameQuiz(deps, me(req), qid(req), z.object({ title: z.string() }).parse(req.body).title);
    return { ok: true };
  });
  app.put("/api/quizzes/:id/questions/:qid", { preHandler: auth }, async (req) => quiz.updateQuestion(deps, me(req), qid(req), questionId(req), req.body));
  app.post("/api/quizzes/:id/questions", { preHandler: auth }, async (req) => quiz.addQuestion(deps, me(req), qid(req), req.body));
  app.delete("/api/quizzes/:id/questions/:qid", { preHandler: auth }, async (req) => {
    await quiz.removeQuestion(deps, me(req), qid(req), questionId(req));
    return { ok: true };
  });
  app.post("/api/quizzes/:id/questions/:qid/confirm-evidence", { preHandler: auth }, async (req) => ({ checks: await quiz.confirmEvidence(deps, me(req), qid(req), questionId(req)) }));
  app.post("/api/quizzes/:id/approve", { preHandler: auth }, async (req) => quiz.approveQuestions(deps, me(req), qid(req), z.object({ questionIds: z.array(uuid).min(1).max(200) }).parse(req.body).questionIds));
  app.post("/api/quizzes/:id/publish", { preHandler: auth }, async (req) => quiz.publishQuiz(deps, me(req), qid(req)));
  app.post("/api/questions/:qid/report", { preHandler: auth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ reason: z.enum(["wrong_key", "ambiguous", "bad_source", "typo", "other"]), comment: z.string().max(1000).optional() }).parse(req.body);
    await quiz.reportQuestion(deps, me(req), questionId(req), body.reason, body.comment);
    return { ok: true };
  });

  // ── practice attempts ──
  app.post("/api/quizzes/:id/attempts", { preHandler: auth }, async (req) => practice.startAttempt(deps, me(req), qid(req), "app_practice"));
  app.get("/api/attempts/:id", { preHandler: auth }, async (req) => practice.attemptState(deps, me(req), qid(req)));
  app.post("/api/attempts/:id/answer", { preHandler: auth }, async (req) => {
    const body = z.object({ questionId: uuid, optionIds: z.array(uuid).min(1).max(12) }).parse(req.body);
    return practice.answerAttempt(deps, me(req), qid(req), body.questionId, body.optionIds, me(req).language);
  });
  app.post("/api/attempts/:id/finish", { preHandler: auth }, async (req) => practice.finishAttempt(deps, me(req), qid(req)));
  app.post("/api/attempts/:id/mistakes", { preHandler: auth }, async (req) => practice.startMistakesAttempt(deps, me(req), qid(req)));

  // ── live rooms ──
  app.post("/api/rooms", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ quizId: uuid, settings: z.record(z.string(), z.unknown()).optional() }).parse(req.body);
    return rooms.createRoom(deps, me(req), body.quizId, body.settings);
  });
  app.post("/api/rooms/join", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const body = z.object({ inviteToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(), code: z.string().regex(/^[A-Za-z0-9]{4,10}$/).optional(), nickname: z.string().max(40).optional() }).parse(req.body);
    return rooms.joinRoom(deps, me(req), body);
  });
  app.get("/api/rooms/:id", { preHandler: auth }, async (req) => {
    const roomId = qid(req);
    await rooms.requireMember(deps.sql, roomId, me(req).id);
    return rooms.viewFor(await rooms.loadSharedState(deps.sql, roomId), me(req).id, deps.cfg.SIGNING_SECRET);
  });
  app.post("/api/rooms/:id/host", { preHandler: auth }, async (req) => {
    const body = z.object({ action: z.enum(["start", "next", "reveal", "pause", "resume", "finish"]) }).parse(req.body);
    return rooms.hostAction(deps, me(req), qid(req), body.action);
  });
  app.post("/api/rooms/:id/answer", { preHandler: auth }, async (req) => {
    const body = z.object({ questionId: uuid, optionIds: z.array(uuid).min(1).max(12) }).parse(req.body);
    return rooms.submitAnswer(deps, me(req), qid(req), body.questionId, body.optionIds);
  });
  app.post("/api/rooms/:id/invite", { preHandler: auth }, async (req) => rooms.rotateInvite(deps, me(req), qid(req)));
  app.delete("/api/rooms/:id/invite", { preHandler: auth }, async (req) => {
    await rooms.revokeInvites(deps, me(req), qid(req));
    return { ok: true };
  });
  app.get("/api/rooms/:id/results", { preHandler: auth }, async (req) => rooms.roomResults(deps, me(req), qid(req)));
  if (opts.hub) {
    const hub = opts.hub;
    app.get("/ws/rooms", { websocket: true }, (socket) => hub.handle(socket));
  }

  // ── private file downloads (short-lived signed links issued after authorization) ──
  app.get("/files/:a/:b", async (req, reply) => {
    const p = req.params as { a: string; b: string };
    const q = z.object({ name: z.string().max(200), exp: z.coerce.number(), sig: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.query);
    const key = `${p.a}/${p.b}`;
    if (!deps.storage.verify(key, q.name, q.exp, q.sig)) throw new AppError("link_expired", 403);
    if (!(await deps.storage.exists(key))) throw new AppError("not_found", 404);
    const ext = q.name.split(".").pop()?.toLowerCase();
    const type = ext === "pdf" ? "application/pdf" : ext === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/octet-stream";
    reply.header("content-type", type);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(q.name)}`);
    reply.header("cache-control", "private, no-store");
    return reply.send(deps.storage.stream(key));
  });

  await registerTelegramWebhook(app, deps);
  await registerDeckRoutes(app, deps, { auth, me });
  await registerGroupRoutes(app, deps, { auth, me });
  await registerStudyRoutes(app, deps, { auth, me });
  await registerBillingRoutes(app, deps, { auth, me });
  await registerAdminRoutes(app, deps, { auth, me });

  // ── Mini App static files ──
  const dist = path.resolve(process.cwd(), deps.cfg.MINIAPP_DIST_DIR);
  if (existsSync(dist)) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: "/app/",
      index: ["index.html"],
      cacheControl: false,
      // @fastify/static v10 passes the Fastify reply here
      setHeaders: (reply: { header: (k: string, v: string) => void }, filePath: string) => {
        reply.header("cache-control", filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
      },
    } as never);
    app.get("/", async (_req, reply) => reply.redirect("/app/"));
  }
  return app;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    language: isLang(u.language) ? u.language : "uz",
    languageConfirmed: u.language_confirmed,
    eduRole: u.edu_role,
    platformRole: u.platform_role,
    timezone: u.timezone,
    onboardingGoal: u.onboarding_goal,
    onboarded: !!u.onboarded_at,
    personalWorkspaceId: u.personal_workspace_id,
  };
}

export type RouteHelpers = { auth: (req: FastifyRequest) => Promise<void>; me: (req: FastifyRequest) => UserRow };
export type { FastifyReply };
