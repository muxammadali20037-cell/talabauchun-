import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { Deps } from "../deps";
import type { Tx } from "../db/index";
import type { UserRow } from "../auth/users";
import { enqueueJob, JobError, type JobHandler } from "../jobs/queue";
import { enqueueMessage } from "../telegram/outbox";
import { AppError } from "../lib/errors";
import { translate } from "@talaba/shared";

export function deletionLogPath(deps: Pick<Deps, "cfg">) {
  return deps.cfg.DELETION_LOG_PATH || path.join(path.resolve(deps.cfg.STORAGE_DIR), "..", "deletion-log.jsonl");
}

/** One request at a time per kind; the job does the work and the bot tells the user when it is done. */
export async function requestDataJob(deps: Deps, user: UserRow, kind: "export" | "delete", opts: { confirm?: string } = {}) {
  if (kind === "delete" && opts.confirm !== "DELETE") throw new AppError("confirmation_required", 400, "type DELETE to confirm");
  return deps.sql.begin(async (tx) => {
    const [open] = await tx<{ id: string }[]>`select id from data_requests where user_id = ${user.id} and kind = ${kind} and status in ('pending','processing') for update`;
    if (open) return { requestId: open.id, duplicate: true };
    const [r] = await tx<{ id: string }[]>`insert into data_requests (user_id, kind) values (${user.id}, ${kind}) returning id`;
    await enqueueJob(tx, {
      kind: kind === "export" ? "data_export" : "data_delete", userId: user.id, workspaceId: user.personal_workspace_id, targetId: r!.id,
      idempotencyKey: `data:${r!.id}`, stages: kind === "export" ? ["extracting", "rendering"] : ["extracting"], maxAttempts: 5,
      notifyChatId: user.telegram_id,
    });
    await tx`insert into audit_events (actor_id, action, target_type, target_id) values (${user.id}, ${"account." + kind + "_requested"}, 'data_request', ${r!.id})`;
    return { requestId: r!.id, duplicate: false };
  });
}

export async function listDataRequests(deps: Deps, user: UserRow) {
  const rows = await deps.sql<{ id: string; kind: string; status: string; created_at: Date; finished_at: Date | null; result: { storageKey?: string; bytes?: number; filename?: string } | null; error: string | null }[]>`
    select id, kind, status, created_at, finished_at, result, error from data_requests where user_id = ${user.id} order by created_at desc limit 10`;
  return rows.map((r) => {
    let download: { url: string; filename: string; expiresAt: string } | null = null;
    // export archives are kept 7 days, then removed by cleanupExpiredExports (worker, hourly)
    if (r.kind === "export" && r.status === "done" && r.result?.storageKey && r.finished_at && Date.now() - r.finished_at.getTime() < 7 * 86400_000) {
      const filename = r.result.filename ?? "talaba-ai-export.zip";
      const { exp, sig } = deps.storage.sign(r.result.storageKey, filename, 600);
      download = { url: `/files/${r.result.storageKey}?name=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}`, filename, expiresAt: new Date(exp * 1000).toISOString() };
    }
    return { id: r.id, kind: r.kind, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at, bytes: r.result?.bytes ?? null, error: r.error, download };
  });
}

/** Deletes data-export archives older than 7 days (files and the stored key). Runs hourly in the worker. */
export async function cleanupExpiredExports(deps: Deps, now = new Date()): Promise<number> {
  const old = await deps.sql<{ id: string; key: string }[]>`
    select id, result->>'storageKey' as key from data_requests
    where kind = 'export' and status = 'done' and result ? 'storageKey' and finished_at < ${new Date(now.getTime() - 7 * 86400_000)}`;
  for (const r of old) {
    await deps.storage.delete(r.key).catch(() => {});
    await deps.sql`update data_requests set result = result - 'storageKey' where id = ${r.id}`;
  }
  return old.length;
}

// ───────────── export ─────────────
type Row = Record<string, unknown>;

/** Everything the service stores about the user, as JSON plus their original uploaded files. */
export async function buildExport(deps: Deps, userId: string): Promise<Buffer> {
  const sql = deps.sql;
  const zip = new JSZip();
  const [user] = await sql<Row[]>`select id, telegram_id::text, username, first_name, last_name, language, timezone, created_at from users where id = ${userId}`;
  const add = (name: string, data: unknown) => zip.file(name, JSON.stringify(data, null, 2));
  add("profile.json", { user, profile: (await sql<Row[]>`select * from profiles where user_id = ${userId}`)[0] ?? null });
  add("workspaces.json", await sql<Row[]>`select w.id, w.name, w.kind, m.role, m.created_at as joined_at from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = ${userId}`);
  const docs = await sql<{ id: string; title: string; source_kind: string; created_at: Date; storage_key: string | null; original_filename: string | null; version_no: number }[]>`
    select d.id, d.title, d.source_kind, d.created_at, v.storage_key, v.original_filename, v.version_no
    from documents d join document_versions v on v.document_id = d.id where d.owner_id = ${userId} and d.deleted_at is null order by d.created_at, v.version_no`;
  add("documents.json", docs.map(({ storage_key: _k, ...d }) => d));
  for (const d of docs) {
    if (!d.storage_key || !(await deps.storage.exists(d.storage_key))) continue;
    const safe = (d.original_filename ?? `${d.title}.bin`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    zip.file(`files/${d.id}/v${d.version_no}-${safe}`, await deps.storage.get(d.storage_key));
  }
  const quizzes = await sql<Row[]>`select id, title, language, topic, settings, created_at, published_version_id, draft_version_id from quizzes where owner_id = ${userId} and deleted_at is null`;
  for (const quiz of quizzes) {
    const vid = (quiz.published_version_id ?? quiz.draft_version_id) as string | null;
    quiz.questions = vid
      ? await sql<Row[]>`select q.text, q.type, q.explanation, q.topic, q.difficulty,
          (select json_agg(json_build_object('text', o.text, 'correct', o.id = any(k.correct_option_ids)) order by o.position) from options o where o.question_id = q.id) as options,
          sr.quote as source_quote, sr.document_title as source_document, sr.locator as source_locator
        from questions q left join private_answer_keys k on k.question_id = q.id left join source_references sr on sr.id = q.source_ref_id
        where q.quiz_version_id = ${vid} order by q.position`
      : [];
  }
  add("quizzes.json", quizzes);
  add("attempts.json", await sql<Row[]>`select a.id, a.mode, a.score, a.max_score, a.started_at, a.finished_at, z.title as quiz_title from attempts a join quiz_versions v on v.id = a.quiz_version_id join quizzes z on z.id = v.quiz_id where a.user_id = ${userId}`);
  add("flashcards.json", await sql<Row[]>`select front, back, collection, due_at, reps, created_at from flashcards where owner_id = ${userId} and deleted_at is null`);
  add("study_plans.json", await sql<Row[]>`select p.title, p.exam_date::text, p.daily_minutes, p.topics, (select json_agg(json_build_object('title', t.title, 'status', t.status, 'due_at', t.due_at)) from tasks t where t.plan_id = p.id) as tasks from study_plans p where p.user_id = ${userId}`);
  add("decks.json", await sql<Row[]>`select d.title, d.theme, d.created_at, (select json_agg(s.content order by s.position) from slides s where s.deck_id = d.id) as slides from decks d where d.owner_id = ${userId} and d.deleted_at is null`);
  add("comments.json", await sql<Row[]>`select body, target_type, created_at from comments where author_id = ${userId}`);
  add("payments.json", await sql<Row[]>`select plan_code, amount, currency, credits, status, created_at, paid_at, refunded_at from payments where user_id = ${userId}`);
  add("credits.json", await sql<Row[]>`select entry_type, amount, reason, created_at from credit_ledger where user_id = ${userId} order by id`);
  add("support.json", await sql<Row[]>`select kind, body, status, resolution, created_at from support_tickets where user_id = ${userId}`);
  zip.file("README.txt", "TALABA AI — your data export.\nprofile.json, workspaces.json: account and memberships\ndocuments.json + files/: your uploads (original files)\nquizzes.json: your quizzes with answers and source quotes\nattempts.json, flashcards.json, study_plans.json, decks.json, comments.json\npayments.json, credits.json: purchases and credit history\nsupport.json: your support requests\n");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ───────────── deletion ─────────────
async function purgeDocument(deps: Deps, tx: Tx, documentId: string): Promise<string[]> {
  const keys = (await tx<{ storage_key: string | null }[]>`select storage_key from document_versions where document_id = ${documentId}`).map((k) => k.storage_key).filter((k): k is string => !!k);
  const versions = tx`select id from document_versions where document_id = ${documentId}`;
  await tx`delete from chunks where document_version_id in (${versions})`;
  await tx`delete from pages where document_version_id in (${versions})`;
  await tx`delete from sections where document_version_id in (${versions})`;
  await tx`update document_versions set storage_key = null, status = 'deleted', metadata = '{}'::jsonb, original_filename = null where document_id = ${documentId}`;
  await tx`update source_references set quote = '', locator = '{}'::jsonb, document_title = null where document_id = ${documentId}`;
  await tx`update stat_facts set definition = null, sample_info = null where document_version_id in (${versions})`;
  await tx`update documents set title = '[deleted]', author = null, deleted_at = coalesce(deleted_at, now()), current_version_id = null where id = ${documentId}`;
  return keys;
}

/** Removes the content of a workspace the user alone controls (their personal space, or a group nobody else is in). */
async function purgeWorkspace(deps: Deps, tx: Tx, workspaceId: string): Promise<string[]> {
  const keys: string[] = [];
  for (const d of await tx<{ id: string }[]>`select id from documents where workspace_id = ${workspaceId}`) keys.push(...(await purgeDocument(deps, tx, d.id)));
  // quizzes: hidden and anonymised; question text stays only where other people's results depend on it
  await tx`update quizzes set title = '[deleted]', description = null, visibility = 'private', deleted_at = coalesce(deleted_at, now()) where workspace_id = ${workspaceId}`;
  await tx`update invitations set revoked_at = now() where workspace_id = ${workspaceId} and revoked_at is null`;
  await tx`delete from questions q using quiz_versions v, quizzes z where q.quiz_version_id = v.id and v.quiz_id = z.id and z.workspace_id = ${workspaceId}
    and not exists (select 1 from attempt_answers aa join attempts a on a.id = aa.attempt_id where aa.question_id = q.id and a.user_id <> z.owner_id)
    and not exists (select 1 from room_answers ra where ra.question_id = q.id)
    and not exists (select 1 from telegram_polls tp where tp.question_id = q.id)`;
  await tx`update source_references set quote = '', locator = '{}'::jsonb, document_title = null where workspace_id = ${workspaceId}`;
  const exportKeys = await tx<{ storage_key: string }[]>`select av.storage_key from exports e join artifact_versions av on av.id = e.artifact_version_id join decks d on d.id = e.deck_id where d.workspace_id = ${workspaceId}`;
  keys.push(...exportKeys.map((k) => k.storage_key));
  await tx`delete from slides where deck_id in (select id from decks where workspace_id = ${workspaceId})`;
  await tx`delete from exports where deck_id in (select id from decks where workspace_id = ${workspaceId})`;
  await tx`update decks set title = '[deleted]', outline = null, settings = '{}'::jsonb, deleted_at = coalesce(deleted_at, now()) where workspace_id = ${workspaceId}`;
  await tx`delete from stat_facts where workspace_id = ${workspaceId}`;
  await tx`delete from comments where workspace_id = ${workspaceId}`;
  await tx`delete from tasks where workspace_id = ${workspaceId}`;
  await tx`update generation_jobs set input = '{}'::jsonb, checkpoint = '{}'::jsonb, result = null where workspace_id = ${workspaceId}`;
  return keys;
}

/**
 * Account deletion. Removed: uploads (files, text, search index), personal
 * quizzes/decks/cards/plans/attempts, comments, sessions, profile and the
 * Telegram identity. Kept, without the person: payment and credit records
 * (accounting), aggregate usage metrics, other people's results that include a
 * question they played, and material already handed over to a group.
 */
export async function deleteAccount(deps: Deps, userId: string, requestId: string | null) {
  const storageKeys: string[] = [];
  const [u] = await deps.sql<{ telegram_id: string | null; deleted_at: Date | null }[]>`select telegram_id::text, deleted_at from users where id = ${userId}`;
  if (!u) throw new JobError("user_missing");
  await deps.sql.begin(async (tx) => {
    await tx`select id from users where id = ${userId} for update`;
    const owned = await tx<{ id: string; kind: string; others: number; next_owner: string | null }[]>`
      select w.id, w.kind,
        (select count(*)::int from memberships m2 where m2.workspace_id = w.id and m2.user_id <> ${userId}) as others,
        (select m3.user_id from memberships m3 where m3.workspace_id = w.id and m3.user_id <> ${userId} order by case m3.role when 'owner' then 0 when 'editor' then 1 else 2 end, m3.created_at limit 1) as next_owner
      from workspaces w join memberships m on m.workspace_id = w.id and m.user_id = ${userId} and m.role = 'owner' where w.deleted_at is null`;
    for (const w of owned) {
      if (w.kind === "personal" || w.others === 0) {
        storageKeys.push(...(await purgeWorkspace(deps, tx, w.id)));
        await tx`update workspaces set name = '[deleted]', deleted_at = now() where id = ${w.id}`;
      } else {
        // the group continues: ownership passes to the most senior remaining member
        const owners = await tx<{ n: number }[]>`select count(*)::int as n from memberships where workspace_id = ${w.id} and role = 'owner' and user_id <> ${userId}`;
        if (!owners[0]!.n && w.next_owner) await tx`update memberships set role = 'owner' where workspace_id = ${w.id} and user_id = ${w.next_owner}`;
        await tx`update workspaces set owner_id = ${w.next_owner ?? userId} where id = ${w.id} and owner_id = ${userId}`;
      }
    }
    await tx`delete from memberships where user_id = ${userId}`;
    // personal learning data
    await tx`delete from attempts where user_id = ${userId}`;
    await tx`delete from room_answers where user_id = ${userId}`;
    await tx`update room_members set display_name = 'Deleted user' where user_id = ${userId}`;
    await tx`delete from poll_answers where user_id = ${userId}`;
    if (u.telegram_id) await tx`delete from poll_answers where telegram_user_id = ${u.telegram_id}`;
    await tx`delete from review_events where user_id = ${userId}`;
    await tx`delete from flashcards where owner_id = ${userId}`;
    await tx`delete from study_plans where user_id = ${userId}`;
    await tx`delete from game_sessions where user_id = ${userId}`;
    await tx`delete from question_reports where reporter_id = ${userId}`;
    await tx`update comments set body = '[deleted]' where author_id = ${userId}`;
    await tx`update tasks set assignee_id = null where assignee_id = ${userId}`;
    await tx`update support_tickets set body = '[deleted]' where user_id = ${userId}`;
    await tx`delete from notifications where user_id = ${userId} and status in ('pending','sending','failed')`;
    await tx`update notifications set payload = '{}'::jsonb, result = null where user_id = ${userId}`;
    await tx`delete from bot_states where user_id = ${userId}`;
    await tx`delete from profiles where user_id = ${userId}`;
    await tx`delete from user_activity where user_id = ${userId}`;
    await tx`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`;
    await tx`update data_requests set result = null where user_id = ${userId} and kind = 'export'`;
    await tx`update users set telegram_id = null, username = null, first_name = '', last_name = null, telegram_language = null, bot_chat_open = false,
      deleted_at = coalesce(deleted_at, now()), updated_at = now() where id = ${userId}`;
    await tx`insert into audit_events (actor_id, action, target_type, target_id) values (null, 'account.deleted', 'user', ${userId})`;
  });
  const exportKeys = await deps.sql<{ k: string }[]>`select result->>'storageKey' as k from data_requests where user_id = ${userId} and kind = 'export' and result ? 'storageKey'`;
  for (const k of [...storageKeys, ...exportKeys.map((e) => e.k)]) await deps.storage.delete(k).catch(() => {});
  const log = deletionLogPath(deps);
  await mkdir(path.dirname(log), { recursive: true });
  await appendFile(log, JSON.stringify({ userId, requestId, at: new Date().toISOString() }) + "\n");
  return { storageFilesRemoved: storageKeys.length };
}

/** After restoring a backup older than some deletions, run them again (the log lives outside the backup). */
export async function reapplyDeletions(deps: Deps): Promise<string[]> {
  const raw = await readFile(deletionLogPath(deps), "utf8").catch(() => "");
  const done: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const { userId } = JSON.parse(line) as { userId: string };
    const [u] = await deps.sql<{ telegram_id: string | null; first_name: string }[]>`select telegram_id::text, first_name from users where id = ${userId}`;
    if (!u || (u.telegram_id === null && u.first_name === "")) continue;
    await deleteAccount(deps, userId, null);
    done.push(userId);
  }
  return done;
}

export function accountJobHandlers(deps: Deps): Record<string, JobHandler> {
  const finish = async (requestId: string, status: "done" | "failed", result: Record<string, unknown> | null, error: string | null) => {
    await deps.sql`update data_requests set status = ${status}, result = ${result ? deps.sql.json(result as never) : null}, error = ${error}, finished_at = now() where id = ${requestId}`;
  };
  return {
    data_export: async (ctx) => {
      const requestId = ctx.job.target_id!;
      await deps.sql`update data_requests set status = 'processing' where id = ${requestId}`;
      await ctx.stage("extracting");
      const zip = await buildExport(deps, ctx.job.user_id);
      await ctx.stage("rendering");
      const key = deps.storage.newKey(ctx.job.workspace_id, "zip");
      await deps.storage.put(key, zip);
      const filename = `talaba-ai-export-${new Date().toISOString().slice(0, 10)}.zip`;
      await finish(requestId, "done", { storageKey: key, bytes: zip.length, filename }, null);
      const [u] = await deps.sql<{ telegram_id: string | null; language: string }[]>`select telegram_id::text, language from users where id = ${ctx.job.user_id}`;
      if (u?.telegram_id) await enqueueMessage(deps.sql, { chatId: Number(u.telegram_id), userId: ctx.job.user_id, method: "sendMessage", payload: { text: translate(u.language as never, "account.exportReady") }, dedupeKey: `export:${requestId}` });
      return { result: { bytes: zip.length } };
    },
    data_delete: async (ctx) => {
      const requestId = ctx.job.target_id!;
      await deps.sql`update data_requests set status = 'processing' where id = ${requestId}`;
      await ctx.stage("extracting");
      const [u] = await deps.sql<{ telegram_id: string | null; language: string }[]>`select telegram_id::text, language from users where id = ${ctx.job.user_id}`;
      const r = await deleteAccount(deps, ctx.job.user_id, requestId);
      await finish(requestId, "done", r, null);
      // last message: sent to the chat id captured before the identity was removed
      if (u?.telegram_id && deps.tg) await deps.tg.call("sendMessage", { chat_id: Number(u.telegram_id), text: translate(u.language as never, "account.deleted") }).catch(() => {});
      return { result: r };
    },
  };
}
