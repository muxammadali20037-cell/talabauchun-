import { z } from "zod";
import type { Deps } from "../deps";
import type { Sql, Tx } from "../db/index";
import { AI_TASKS } from "../ai/client";
import { AppError, notFound } from "../lib/errors";
import { enqueueMessage } from "../telegram/outbox";
import { refundPayment } from "../billing/stars";

/**
 * Operator views are aggregates: counts, rates, latencies and costs. Nothing
 * here reads a student's private files or answers; moderation only sees the
 * question a user reported.
 */
export async function audit(sql: Sql | Tx, actorId: string, action: string, target: { type: string; id: string } | null, data: Record<string, unknown> = {}, ip?: string) {
  await sql`insert into audit_events (actor_id, action, target_type, target_id, data, ip) values (${actorId}, ${action}, ${target?.type ?? null}, ${target?.id ?? null}, ${sql.json(data as never)}, ${ip ?? null})`;
}

const num = (v: unknown) => (v == null ? null : Number(v));

export async function overview(deps: Deps) {
  const sql = deps.sql;
  const [users] = await sql<Record<string, string>[]>`
    select count(*) filter (where deleted_at is null) as total,
      count(*) filter (where created_at > now() - interval '7 days' and deleted_at is null) as new_7d,
      (select count(distinct user_id) from user_activity where day >= current_date) as active_1d,
      (select count(distinct user_id) from user_activity where day > current_date - 7) as active_7d,
      (select count(distinct user_id) from user_activity where day > current_date - 30) as active_30d
    from users`;
  const [ws] = await sql<Record<string, string>[]>`select count(*) filter (where kind = 'group') as groups, count(*) filter (where kind = 'personal') as personal from workspaces where deleted_at is null`;
  const jobs = await sql<{ kind: string; status: string; n: string }[]>`
    select kind, status, count(*) as n from generation_jobs where created_at > now() - interval '24 hours' group by 1, 2 order by 1, 2`;
  const queue = await sql<{ status: string; n: string; oldest_sec: string | null }[]>`
    select status, count(*) as n, extract(epoch from now() - min(created_at))::int as oldest_sec from generation_jobs
    where status not in ('completed','failed','cancelled') group by 1`;
  const timing = await sql<{ kind: string; n: string; wait_avg: string; wait_p95: string; run_avg: string; run_p95: string }[]>`
    select kind, count(*) as n,
      round(avg(extract(epoch from started_at - created_at))::numeric, 2) as wait_avg,
      round(percentile_cont(0.95) within group (order by extract(epoch from started_at - created_at))::numeric, 2) as wait_p95,
      round(avg(extract(epoch from finished_at - started_at))::numeric, 2) as run_avg,
      round(percentile_cont(0.95) within group (order by extract(epoch from finished_at - started_at))::numeric, 2) as run_p95
    from generation_jobs where finished_at > now() - interval '24 hours' and started_at is not null and status = 'completed' group by 1 order by 1`;
  const failures = await sql<{ kind: string; error_code: string | null; n: string }[]>`
    select kind, error_code, count(*) as n from generation_jobs where status = 'failed' and finished_at > now() - interval '7 days' group by 1, 2 order by 3 desc limit 20`;
  const providers = await sql<{ model: string | null; calls: string; errors: string; cost: string | null; p95_ms: string | null }[]>`
    select model, count(*) as calls, count(*) filter (where not ok) as errors, sum(cost_usd)::text as cost,
      percentile_cont(0.95) within group (order by latency_ms)::int as p95_ms
    from usage_events where kind = 'ai_tokens' and created_at > now() - interval '24 hours' group by 1 order by 2 desc`;
  const [cost] = await sql<Record<string, string | null>[]>`
    select sum(cost_usd) filter (where created_at > now() - interval '1 day') as d1, sum(cost_usd) filter (where created_at > now() - interval '7 days') as d7,
      sum(cost_usd) filter (where created_at > now() - interval '30 days') as d30, sum(quantity) filter (where kind = 'ocr_page' and created_at > now() - interval '30 days') as ocr_pages_30d
    from usage_events`;
  const [credits] = await sql<Record<string, string | null>[]>`
    select sum(amount) filter (where entry_type = 'grant' and created_at > now() - interval '30 days') as granted_30d,
      sum(amount) filter (where entry_type = 'purchase' and created_at > now() - interval '30 days') as purchased_30d,
      -sum(amount) filter (where entry_type in ('reserve','release') and created_at > now() - interval '30 days') as spent_30d,
      sum(amount) as outstanding
    from credit_ledger`;
  const payments = await sql<{ status: string; n: string; stars: string | null }[]>`
    select status, count(*) as n, sum(amount)::text as stars from payments where created_at > now() - interval '30 days' group by 1`;
  const [support] = await sql<Record<string, string>[]>`select count(*) filter (where status in ('open','in_progress')) as open, count(*) filter (where kind = 'paysupport' and status in ('open','in_progress')) as pay_open from support_tickets`;
  const [reports] = await sql<{ open: string }[]>`select count(*) as open from question_reports where status = 'open'`;
  const [outbox] = await sql<Record<string, string>[]>`select count(*) filter (where status in ('pending','sending')) as pending, count(*) filter (where status in ('failed','dead') and created_at > now() - interval '1 day') as failed_1d from notifications`;
  return {
    users: Object.fromEntries(Object.entries(users!).map(([k, v]) => [k, num(v)])),
    workspaces: { groups: num(ws!.groups), personal: num(ws!.personal) },
    jobs24h: jobs.map((j) => ({ ...j, n: Number(j.n) })),
    successRate24h: (() => {
      const done = jobs.filter((j) => j.status === "completed").reduce((s, j) => s + Number(j.n), 0);
      const failed = jobs.filter((j) => j.status === "failed").reduce((s, j) => s + Number(j.n), 0);
      return done + failed ? Math.round((done / (done + failed)) * 1000) / 10 : null;
    })(),
    queue: queue.map((q) => ({ status: q.status, n: Number(q.n), oldestSec: num(q.oldest_sec) })),
    timing: timing.map((t) => ({ kind: t.kind, n: Number(t.n), waitAvgSec: num(t.wait_avg), waitP95Sec: num(t.wait_p95), runAvgSec: num(t.run_avg), runP95Sec: num(t.run_p95) })),
    failures7d: failures.map((f) => ({ ...f, n: Number(f.n) })),
    providers24h: providers.map((p) => ({ model: p.model, calls: Number(p.calls), errors: Number(p.errors), costUsd: num(p.cost), p95Ms: num(p.p95_ms) })),
    aiCostUsd: { d1: num(cost!.d1) ?? 0, d7: num(cost!.d7) ?? 0, d30: num(cost!.d30) ?? 0 },
    ocrPages30d: num(cost!.ocr_pages_30d) ?? 0,
    credits: Object.fromEntries(Object.entries(credits!).map(([k, v]) => [k, num(v) ?? 0])),
    payments30d: payments.map((p) => ({ status: p.status, n: Number(p.n), stars: num(p.stars) ?? 0 })),
    support: { open: num(support!.open), payOpen: num(support!.pay_open) },
    reportsOpen: num(reports!.open),
    outbox: { pending: num(outbox!.pending), failed1d: num(outbox!.failed_1d) },
  };
}

/** Product metrics, measured from stored events; targets (set by an admin) are shown next to them, never mixed in. */
export async function productMetrics(deps: Deps) {
  const sql = deps.sql;
  const [first] = await sql<{ users: string; median_min: string | null; p75_min: string | null }[]>`
    with firsts as (
      select u.id, u.created_at, least(
        (select min(v.created_at) from quiz_versions v join quizzes q on q.id = v.quiz_id where q.owner_id = u.id and v.published_at is not null),
        (select min(a.finished_at) from attempts a where a.user_id = u.id and a.finished_at is not null),
        (select min(e.created_at) from exports e join decks d on d.id = e.deck_id where d.owner_id = u.id and e.status = 'ready')) as first_at
      from users u where u.created_at > now() - interval '30 days' and u.deleted_at is null)
    select count(*) filter (where first_at is not null) as users,
      round((percentile_cont(0.5) within group (order by extract(epoch from first_at - created_at) / 60))::numeric, 1) as median_min,
      round((percentile_cont(0.75) within group (order by extract(epoch from first_at - created_at) / 60))::numeric, 1) as p75_min
    from firsts where first_at is not null`;
  const [counts] = await sql<Record<string, string>[]>`
    select (select count(*) from quizzes where published_version_id is not null and updated_at > now() - interval '30 days') as published_quizzes_30d,
      (select count(*) from questions where status in ('approved','published') and created_at > now() - interval '30 days') as approved_questions_30d,
      (select count(*) from attempts where finished_at > now() - interval '30 days') as finished_attempts_30d,
      (select count(*) from rooms where created_at > now() - interval '30 days') as rooms_30d,
      (select count(*) from group_quiz_runs where created_at > now() - interval '30 days') as group_runs_30d`;
  const exportsByFormat = await sql<{ format: string; ready: string; failed: string }[]>`
    select format, count(*) filter (where status = 'ready') as ready, count(*) filter (where status = 'failed') as failed
    from exports where created_at > now() - interval '30 days' group by 1`;
  const [reuse] = await sql<{ shared: string; reused: string }[]>`
    with uses as (
      select v.quiz_id, count(*) as n from rooms r join quiz_versions v on v.id = r.quiz_version_id where r.created_at > now() - interval '30 days' group by 1
      union all
      select v.quiz_id, count(*) from group_quiz_runs g join quiz_versions v on v.id = g.quiz_version_id where g.created_at > now() - interval '30 days' group by 1)
    select count(distinct quiz_id) as shared, count(distinct quiz_id) filter (where n >= 2) as reused from uses`;
  const retention = await sql<{ d: number; cohort: string; retained: string }[]>`
    select d, count(*) as cohort, count(*) filter (where exists (select 1 from user_activity a where a.user_id = u.id and a.day = u.created_at::date + d)) as retained
    from users u cross join (values (1), (7), (30)) as w(d)
    where u.deleted_at is null and u.created_at::date + d < current_date and u.created_at > now() - interval '120 days'
    group by d order by d`;
  const [cost] = await sql<{ cost: string | null; jobs: string }[]>`
    select (select sum(cost_usd) from usage_events where created_at > now() - interval '30 days') as cost,
      (select count(*) from generation_jobs where status = 'completed' and finished_at > now() - interval '30 days') as jobs`;
  const [targets] = await sql<{ data: Record<string, number> }[]>`select data from feature_flags where key = 'targets'`;
  return {
    measured: {
      firstUsefulResult: { users: Number(first!.users), medianMinutes: num(first!.median_min), p75Minutes: num(first!.p75_min) },
      ...Object.fromEntries(Object.entries(counts!).map(([k, v]) => [k, Number(v)])),
      exports30d: exportsByFormat.map((e) => ({ format: e.format, ready: Number(e.ready), failed: Number(e.failed), successRate: Number(e.ready) + Number(e.failed) ? Math.round((Number(e.ready) / (Number(e.ready) + Number(e.failed))) * 1000) / 10 : null })),
      groupReuse30d: { sharedQuizzes: Number(reuse!.shared), reusedQuizzes: Number(reuse!.reused) },
      retention: retention.map((r) => ({ day: r.d, cohort: Number(r.cohort), retained: Number(r.retained), rate: Number(r.cohort) ? Math.round((Number(r.retained) / Number(r.cohort)) * 1000) / 10 : null })),
      costPerCompletedJobUsd: Number(cost!.jobs) ? Math.round((Number(cost!.cost ?? 0) / Number(cost!.jobs)) * 10000) / 10000 : null,
    },
    targets: targets?.data ?? null,
  };
}

// ───────────── jobs ─────────────
export async function listJobs(deps: Deps, q: { status?: string; kind?: string; limit?: number }) {
  return deps.sql`select j.id, j.kind, j.status, j.error_code, j.attempts, j.max_attempts, j.created_at, j.started_at, j.finished_at, j.workspace_id,
      (select message from job_events e where e.job_id = j.id and e.type = 'error' order by e.id desc limit 1) as last_error
    from generation_jobs j where (${q.status ?? null}::text is null or j.status = ${q.status ?? null}) and (${q.kind ?? null}::text is null or j.kind = ${q.kind ?? null})
    order by j.created_at desc limit ${Math.min(q.limit ?? 50, 200)}`;
}

/** Re-runs a failed job from its checkpoint. No new credit reservation: an operator retry is never charged to the student. */
export async function retryJob(deps: Deps, adminId: string, jobId: string, ip?: string) {
  return deps.sql.begin(async (tx) => {
    const [j] = await tx<{ status: string; kind: string }[]>`select status, kind from generation_jobs where id = ${jobId} for update`;
    if (!j) throw notFound("job");
    if (j.status !== "failed") throw new AppError("job_not_failed", 409);
    await tx`update generation_jobs set status = 'queued', attempts = 0, error_code = null, error_message = null, finished_at = null, run_after = now(),
      credit_reservation_id = null, locked_by = null, lease_expires_at = null, updated_at = now() where id = ${jobId}`;
    await tx`insert into job_events (job_id, type, status, message) values (${jobId}, 'admin_retry', 'queued', ${adminId})`;
    await audit(tx, adminId, "job.retry", { type: "job", id: jobId }, { kind: j.kind }, ip);
    await tx`select pg_notify('jobs', ${jobId})`;
    return { queued: true };
  });
}

// ───────────── models & flags ─────────────
export const ModelConfigInput = z.object({
  model: z.string().regex(/^claude-[a-z0-9.-]+$/).max(80),
  effort: z.enum(["low", "medium", "high"]).nullable().optional(),
  maxTokens: z.number().int().min(256).max(64000).optional(),
  enabled: z.boolean().optional(),
});

export async function listModelConfigs(deps: Deps) {
  const rows = await deps.sql<{ task: string; model: string; effort: string | null; max_tokens: number; enabled: boolean; previous: unknown; updated_at: Date }[]>`
    select task, model, effort, max_tokens, enabled, previous, updated_at from model_configs order by task`;
  const byTask = new Map(rows.map((r) => [r.task, r]));
  return AI_TASKS.map((task) => ({ task, override: byTask.get(task) ?? null, default: { strong: deps.cfg.AI_MODEL_STRONG, fast: deps.cfg.AI_MODEL_FAST } }));
}

/** Every change keeps the previous row, so a bad model can be rolled back (or switched off) in one action. */
export async function setModelConfig(deps: Deps, adminId: string, task: string, raw: unknown, ip?: string) {
  if (!(AI_TASKS as readonly string[]).includes(task)) throw notFound("task");
  const p = ModelConfigInput.parse(raw);
  return deps.sql.begin(async (tx) => {
    const [cur] = await tx<{ model: string; effort: string | null; max_tokens: number; enabled: boolean }[]>`select model, effort, max_tokens, enabled from model_configs where task = ${task} for update`;
    const previous = cur ? { model: cur.model, effort: cur.effort, max_tokens: cur.max_tokens, enabled: cur.enabled } : null;
    await tx`insert into model_configs (task, model, effort, max_tokens, enabled, previous, updated_by, updated_at)
      values (${task}, ${p.model}, ${p.effort ?? null}, ${p.maxTokens ?? 16000}, ${p.enabled ?? true}, ${previous ? tx.json(previous as never) : null}, ${adminId}, now())
      on conflict (task) do update set model = excluded.model, effort = excluded.effort, max_tokens = excluded.max_tokens, enabled = excluded.enabled,
        previous = excluded.previous, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(tx, adminId, "model_config.set", { type: "ai_task", id: task }, { before: previous, after: p }, ip);
    return { task, previous };
  });
}

export async function rollbackModelConfig(deps: Deps, adminId: string, task: string, ip?: string) {
  return deps.sql.begin(async (tx) => {
    const [cur] = await tx<{ model: string; effort: string | null; max_tokens: number; enabled: boolean; previous: { model: string; effort: string | null; max_tokens: number; enabled: boolean } | null }[]>`
      select model, effort, max_tokens, enabled, previous from model_configs where task = ${task} for update`;
    if (!cur) throw notFound("model_config");
    if (!cur.previous) {
      // no earlier override: go back to the built-in default
      await tx`delete from model_configs where task = ${task}`;
    } else {
      const now = { model: cur.model, effort: cur.effort, max_tokens: cur.max_tokens, enabled: cur.enabled };
      await tx`update model_configs set model = ${cur.previous.model}, effort = ${cur.previous.effort}, max_tokens = ${cur.previous.max_tokens}, enabled = ${cur.previous.enabled},
        previous = ${tx.json(now as never)}, updated_by = ${adminId}, updated_at = now() where task = ${task}`;
    }
    await audit(tx, adminId, "model_config.rollback", { type: "ai_task", id: task }, { from: cur.model, to: cur.previous?.model ?? "default" }, ip);
    return { task, restored: cur.previous?.model ?? "default" };
  });
}

export async function listFlags(deps: Deps) {
  return deps.sql`select key, enabled, data, updated_at from feature_flags order by key`;
}

const FLAG_KEYS = ["pricing", "targets", "ai_generation", "web_search", "public_templates", "signup_open"] as const;
export async function setFlag(deps: Deps, adminId: string, key: string, raw: unknown, ip?: string) {
  if (!(FLAG_KEYS as readonly string[]).includes(key)) throw notFound("flag");
  const p = z.object({ enabled: z.boolean(), data: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() }).parse(raw);
  if (key === "pricing" && p.data && Object.values(p.data).some((v) => typeof v !== "number" || v < 0)) throw new AppError("bad_pricing", 400);
  await deps.sql.begin(async (tx) => {
    const [before] = await tx`select enabled, data from feature_flags where key = ${key}`;
    await tx`insert into feature_flags (key, enabled, data, updated_by, updated_at) values (${key}, ${p.enabled}, ${tx.json((p.data ?? {}) as never)}, ${adminId}, now())
      on conflict (key) do update set enabled = excluded.enabled, data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(tx, adminId, "flag.set", { type: "flag", id: key }, { before: before ?? null, after: p }, ip);
  });
  return { ok: true };
}

// ───────────── moderation & support ─────────────
export async function listReports(deps: Deps, status = "open") {
  return deps.sql`select r.id, r.reason, r.comment, r.status, r.created_at, q.id as question_id, q.text as question_text, z.id as quiz_id, z.title as quiz_title, z.visibility,
      (select count(*)::int from question_reports x where x.question_id = r.question_id) as reports_on_question
    from question_reports r join questions q on q.id = r.question_id join quiz_versions v on v.id = q.quiz_version_id join quizzes z on z.id = v.quiz_id
    where r.status = ${status} order by r.created_at limit 100`;
}

/** Resolving a report can also take a shared quiz out of public view; the owner keeps their private copy. */
export async function resolveReport(deps: Deps, adminId: string, reportId: string, raw: unknown, ip?: string) {
  const p = z.object({ status: z.enum(["resolved", "rejected"]), unpublishQuiz: z.boolean().optional(), note: z.string().max(500).optional() }).parse(raw);
  return deps.sql.begin(async (tx) => {
    const [r] = await tx<{ quiz_id: string }[]>`select v.quiz_id from question_reports r join questions q on q.id = r.question_id join quiz_versions v on v.id = q.quiz_version_id where r.id = ${reportId} for update of r`;
    if (!r) throw notFound("report");
    await tx`update question_reports set status = ${p.status}, resolved_at = now() where id = ${reportId}`;
    if (p.unpublishQuiz) {
      await tx`update quizzes set visibility = 'private', moderated_at = now(), moderation_note = ${p.note ?? null} where id = ${r.quiz_id}`;
      await tx`update invitations set revoked_at = now() where target_id = ${r.quiz_id} and revoked_at is null`;
    }
    await audit(tx, adminId, "report.resolve", { type: "question_report", id: reportId }, p, ip);
    return { ok: true };
  });
}

export async function listTickets(deps: Deps, status?: string) {
  return deps.sql`select t.id::text, t.kind, t.body, t.status, t.resolution, t.created_at, t.updated_at, t.replied_at, u.id as user_id, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as user_name, u.language
    from support_tickets t join users u on u.id = t.user_id where (${status ?? null}::text is null or t.status = ${status ?? null}) order by t.created_at desc limit 100`;
}

/** The reply goes to the user through the bot outbox (rate limited, retried); the ticket keeps the text. */
export async function replyTicket(deps: Deps, adminId: string, ticketId: string, raw: unknown, ip?: string) {
  const p = z.object({ text: z.string().min(1).max(3500), status: z.enum(["in_progress", "resolved", "rejected"]) }).parse(raw);
  return deps.sql.begin(async (tx) => {
    const [t] = await tx<{ user_id: string; telegram_id: string | null }[]>`select t.user_id, u.telegram_id::text as telegram_id from support_tickets t join users u on u.id = t.user_id where t.id = ${ticketId} for update of t`;
    if (!t) throw notFound("ticket");
    await tx`update support_tickets set status = ${p.status}, resolution = ${p.text}, replied_at = now(), replied_by = ${adminId}, updated_at = now() where id = ${ticketId}`;
    if (t.telegram_id) await enqueueMessage(tx, { chatId: Number(t.telegram_id), userId: t.user_id, method: "sendMessage", payload: { text: `#${ticketId}: ${p.text}` }, dedupeKey: `ticket:${ticketId}:${Date.now()}` });
    await audit(tx, adminId, "ticket.reply", { type: "support_ticket", id: ticketId }, { status: p.status }, ip);
    return { ok: true, delivered: !!t.telegram_id };
  });
}

// ───────────── users, credits, payments ─────────────
export async function searchUsers(deps: Deps, q: string) {
  const term = q.trim();
  const byId = /^\d{3,15}$/.test(term) ? term : null;
  return deps.sql`select u.id, u.telegram_id::text as telegram_id, u.username, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as name, u.language, u.platform_role, u.created_at, u.deleted_at, u.bot_blocked_at,
      (select coalesce(sum(amount), 0)::int from credit_ledger l where l.user_id = u.id) as balance,
      (select e.plan_code from entitlements e where e.user_id = u.id and e.status = 'active' and (e.ends_at is null or e.ends_at > now()) order by e.created_at desc limit 1) as plan,
      (select count(*)::int from documents d where d.owner_id = u.id and d.deleted_at is null) as documents,
      (select count(*)::int from quizzes z where z.owner_id = u.id and z.deleted_at is null) as quizzes
    from users u
    where ${term === ""} or u.telegram_id::text = ${byId ?? ""} or u.username ilike ${term.replace(/[%_]/g, "") + "%"} or u.first_name ilike ${term.replace(/[%_]/g, "") + "%"}
    order by u.created_at desc limit 50`;
}

export async function adjustCredits(deps: Deps, adminId: string, userId: string, raw: unknown, ip?: string) {
  const p = z.object({ amount: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0), reason: z.string().min(3).max(200), idempotencyKey: z.string().min(8).max(100) }).parse(raw);
  return deps.sql.begin(async (tx) => {
    const [u] = await tx`select id from users where id = ${userId}`;
    if (!u) throw notFound("user");
    const r = await tx`insert into credit_ledger (user_id, entry_type, amount, reason, idempotency_key) values (${userId}, 'adjust', ${p.amount}, ${p.reason}, ${"adjust:" + p.idempotencyKey})
      on conflict (idempotency_key) do nothing returning id`;
    if (r.length) await audit(tx, adminId, "credits.adjust", { type: "user", id: userId }, { amount: p.amount, reason: p.reason }, ip);
    return { applied: r.length > 0 };
  });
}

export async function listPayments(deps: Deps, status?: string) {
  return deps.sql`select p.id, p.plan_code, p.amount, p.credits, p.status, p.created_at, p.paid_at, p.refunded_at, p.telegram_payment_charge_id, u.id as user_id,
      trim(u.first_name || ' ' || coalesce(u.last_name, '')) as user_name
    from payments p join users u on u.id = p.user_id where (${status ?? null}::text is null or p.status = ${status ?? null}) order by p.created_at desc limit 100`;
}

export async function adminRefund(deps: Deps, adminId: string, paymentId: string, ip?: string) {
  return refundPayment(deps, adminId, paymentId, ip);
}

export async function listAudit(deps: Deps, q: { action?: string; limit?: number }) {
  return deps.sql`select a.id::text, a.action, a.target_type, a.target_id, a.data, a.ip, a.created_at, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as actor
    from audit_events a left join users u on u.id = a.actor_id where (${q.action ?? null}::text is null or a.action like ${(q.action ?? "") + "%"})
    order by a.id desc limit ${Math.min(q.limit ?? 100, 500)}`;
}
