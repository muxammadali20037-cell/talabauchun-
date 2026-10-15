import { TELEGRAM, translate, type Lang } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AppError, notFound } from "../lib/errors";
import { randomToken, sha256, shuffle } from "../lib/crypto";
import { describeLocator } from "../search/retrieve";
import { startGroupLink } from "../telegram/links";
import { TelegramError } from "../telegram/api";
import { enqueueMessage } from "../telegram/outbox";
import { escapeHtml } from "../telegram/ui";

const LINK_TTL_MIN = 30;

type RunRow = {
  id: string; quiz_version_id: string; host_id: string; chat_id: string | null; chat_title: string | null; status: string; anonymous: boolean;
  open_period: number; question_ids: string[]; current_index: number; next_send_at: Date | null; skipped_question_ids: string[]; option_orders: Record<string, string[]>;
};

/**
 * Host prepares a native Telegram quiz for a group. Only published,
 * single-answer questions that fit Telegram's poll limits are used; others
 * are reported as "Mini App only". Returns a startgroup link the host taps to
 * pick the group (an explicit user action — the bot never posts on its own).
 */
export async function createGroupRun(deps: Deps, user: UserRow, quizId: string, p: { anonymous: boolean; openPeriod: number }) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "viewer");
  const [q] = await deps.sql<{ published_version_id: string | null; title: string }[]>`select published_version_id, title from quizzes where id = ${quizId}`;
  if (!q?.published_version_id) throw new AppError("quiz_not_published", 409);
  const qs = await deps.sql<{ id: string; type: string; payload: { nativePollOk?: boolean }; n_correct: number }[]>`
    select q.id, q.type, q.payload, cardinality(k.correct_option_ids) as n_correct from questions q join private_answer_keys k on k.question_id = q.id
    where q.quiz_version_id = ${q.published_version_id} and q.status = 'published' order by q.position`;
  const usable = qs.filter((x) => x.type === "single" && x.n_correct === 1 && x.payload?.nativePollOk);
  const skipped = qs.filter((x) => !usable.includes(x)).map((x) => x.id);
  if (!usable.length) throw new AppError("no_native_compatible_questions", 409, "use a live room instead", { skipped: skipped.length });
  const openPeriod = Math.min(Math.max(p.openPeriod, 10), 600);
  const token = randomToken(16);
  const orders: Record<string, string[]> = {};
  for (const x of usable) {
    const opts = await deps.sql<{ id: string; type: string }[]>`select o.id, q.type from options o join questions q on q.id = o.question_id where o.question_id = ${x.id} order by o.position`;
    orders[x.id] = opts[0]?.type === "true_false" ? opts.map((o) => o.id) : shuffle(opts.map((o) => o.id));
  }
  const [run] = await deps.sql<{ id: string }[]>`
    insert into group_quiz_runs (quiz_version_id, host_id, anonymous, open_period, question_ids, skipped_question_ids, option_orders, link_token_hash, link_expires_at)
    values (${q.published_version_id}, ${user.id}, ${p.anonymous}, ${openPeriod}, ${usable.map((x) => x.id)}, ${skipped}, ${deps.sql.json(orders as never)},
            ${sha256(token)}, now() + make_interval(mins => ${LINK_TTL_MIN})) returning id`;
  return { runId: run!.id, link: startGroupLink(deps.cfg, `g${token}`), questions: usable.length, skipped: skipped.length, expiresInMin: LINK_TTL_MIN };
}

export async function getRun(deps: Deps, runId: string): Promise<RunRow> {
  const [r] = await deps.sql<RunRow[]>`select id, quiz_version_id, host_id, chat_id::text as chat_id, chat_title, status, anonymous, open_period, question_ids, current_index, next_send_at, skipped_question_ids, option_orders from group_quiz_runs where id = ${runId}`;
  if (!r) throw notFound("group run");
  return r;
}

/** Called when the bot receives "/start g<token>" in a group from the host. */
export async function linkRunToChat(deps: Deps, p: { token: string; fromTelegramId: string; chatId: string; chatTitle: string }) {
  const [run] = await deps.sql<{ id: string; host_tg: string; status: string; expired: boolean; quiz_title: string; n: number; open_period: number; language: Lang }[]>`
    select r.id, u.telegram_id::text as host_tg, r.status, r.link_expires_at < now() as expired, z.title as quiz_title, cardinality(r.question_ids) as n, r.open_period, u.language
    from group_quiz_runs r join users u on u.id = r.host_id join quiz_versions v on v.id = r.quiz_version_id join quizzes z on z.id = v.quiz_id
    where r.link_token_hash = ${sha256(p.token)}`;
  if (!run || run.expired || run.status !== "pending_group") return { ok: false as const, reason: "invalid_link" };
  if (run.host_tg !== p.fromTelegramId) return { ok: false as const, reason: "not_host" };
  await deps.sql`update group_quiz_runs set chat_id = ${p.chatId}, chat_title = ${p.chatTitle}, status = 'ready', link_token_hash = null where id = ${run.id}`;
  return { ok: true as const, runId: run.id, title: run.quiz_title, n: run.n, openPeriod: run.open_period, lang: run.language };
}

export async function startRun(deps: Deps, runId: string, fromTelegramId: string) {
  const [ok] = await deps.sql<{ id: string }[]>`
    update group_quiz_runs r set status = 'running', next_send_at = now()
    from users u where r.id = ${runId} and u.id = r.host_id and u.telegram_id = ${fromTelegramId} and r.status = 'ready' returning r.id`;
  return !!ok;
}

function pollExplanation(explanation: string | null, where: string | null): string | undefined {
  const parts = [explanation?.replace(/\s+/g, " ").trim(), where ? `📖 ${where}` : null].filter(Boolean) as string[];
  if (!parts.length) return undefined;
  let text = parts.join("\n");
  if (text.length > TELEGRAM.pollExplanationMax) text = text.slice(0, TELEGRAM.pollExplanationMax - 1) + "…";
  return text;
}

/**
 * Scheduler tick (worker): sends the next poll of each due run, or the final
 * results after the last poll closed. Rows are claimed with SKIP LOCKED so
 * parallel workers never send the same poll twice; 429 reschedules by retry_after.
 */
export async function tickGroupRuns(deps: Deps) {
  if (!deps.tg) return 0;
  let processed = 0;
  const due = await deps.sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`select id from group_quiz_runs where status = 'running' and next_send_at <= now() order by next_send_at limit 10 for update skip locked`;
    if (rows.length) await tx`update group_quiz_runs set next_send_at = now() + interval '30 seconds' where id in ${tx(rows.map((r) => r.id))}`;
    return rows;
  });
  for (const { id } of due) {
    const run = await getRun(deps, id);
    const next = run.current_index + 1;
    try {
      if (next < run.question_ids.length) {
        await sendPoll(deps, run, next);
        await deps.sql`update group_quiz_runs set current_index = ${next}, next_send_at = now() + make_interval(secs => ${run.open_period + 3}) where id = ${id}`;
      } else {
        await finishRun(deps, run);
      }
      processed++;
    } catch (e) {
      if (e instanceof TelegramError && e.code === 429) {
        await deps.sql`update group_quiz_runs set next_send_at = now() + make_interval(secs => ${Math.max(1, e.retryAfter ?? 5)}) where id = ${id}`;
      } else if (e instanceof TelegramError && (e.code === 403 || e.code === 400)) {
        await deps.sql`update group_quiz_runs set status = 'failed', error = ${e.description.slice(0, 300)} where id = ${id}`;
        await notifyHostNoPermission(deps, run);
      } else {
        await deps.sql`update group_quiz_runs set next_send_at = now() + interval '10 seconds' where id = ${id}`;
      }
    }
  }
  return processed;
}

async function sendPoll(deps: Deps, run: RunRow, index: number) {
  const qid = run.question_ids[index]!;
  const [q] = await deps.sql<{ text: string; explanation: string | null; quote: string | null; locator: Record<string, unknown> | null; language: Lang }[]>`
    select q.text, q.explanation, sr.quote, sr.locator, q.language from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${qid}`;
  const opts = await deps.sql<{ id: string; text: string }[]>`select id, text from options where question_id = ${qid}`;
  const [key] = await deps.sql<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${qid}`;
  const order = run.option_orders[qid] ?? opts.map((o) => o.id);
  const byId = new Map(opts.map((o) => [o.id, o.text]));
  const correct = order.map((id, i) => (key?.correct_option_ids.includes(id) ? i : -1)).filter((i) => i >= 0);
  const lang = (["uz", "uz-Cyrl", "ru", "en"].includes(q!.language) ? q!.language : "uz") as Lang;
  const where = q!.locator ? describeLocator(q!.locator as never, lang) : null;
  const msg = await deps.tg!.call<{ message_id: number; poll?: { id: string } }>("sendPoll", {
    chat_id: run.chat_id,
    question: `${index + 1}/${run.question_ids.length}. ${q!.text}`.slice(0, TELEGRAM.pollQuestionMax),
    options: order.map((id) => ({ text: byId.get(id)!.slice(0, TELEGRAM.pollOptionMax) })),
    type: "quiz",
    is_anonymous: run.anonymous,
    allows_multiple_answers: false,
    correct_option_ids: correct,
    ...(pollExplanation(q!.explanation, where) ? { explanation: pollExplanation(q!.explanation, where) } : {}),
    open_period: run.open_period,
    protect_content: false,
  });
  if (!msg.poll?.id) throw new TelegramError("sendPoll", 500, "no poll in response");
  await deps.sql`insert into telegram_polls (poll_id, run_id, question_id, chat_id, message_id, option_ids, correct_indices, closes_at)
    values (${msg.poll.id}, ${run.id}, ${qid}, ${run.chat_id}, ${msg.message_id}, ${order}, ${correct}, now() + make_interval(secs => ${run.open_period}))
    on conflict (poll_id) do nothing`;
}

/** poll_answer update: only for non-anonymous polls sent by this bot; one answer per user (quizzes do not allow revoting). */
export async function recordPollAnswer(deps: Deps, a: { poll_id: string; user?: { id: number; first_name?: string; last_name?: string }; option_ids: number[] }) {
  if (!a.user) return false; // anonymous voter chat: never turned into a personal result
  const [poll] = await deps.sql<{ correct_indices: number[] }[]>`select correct_indices from telegram_polls where poll_id = ${a.poll_id}`;
  if (!poll) return false; // not a poll this bot manages
  if (!a.option_ids.length) {
    await deps.sql`delete from poll_answers where poll_id = ${a.poll_id} and telegram_user_id = ${String(a.user.id)}`;
    return true;
  }
  const isCorrect = a.option_ids.length === poll.correct_indices.length && a.option_ids.every((i) => poll.correct_indices.includes(i));
  const [u] = await deps.sql<{ id: string }[]>`select id from users where telegram_id = ${String(a.user.id)}`;
  await deps.sql`insert into poll_answers (poll_id, telegram_user_id, user_id, display_name, option_indices, is_correct)
    values (${a.poll_id}, ${String(a.user.id)}, ${u?.id ?? null}, ${[a.user.first_name, a.user.last_name].filter(Boolean).join(" ").slice(0, 60) || null}, ${a.option_ids}, ${isCorrect})
    on conflict (poll_id, telegram_user_id) do nothing`;
  return true;
}

/** poll update (closed/stopped polls sent by the bot): keeps aggregate counts, used for anonymous runs. */
export async function recordPollState(deps: Deps, p: { id: string; is_closed: boolean; total_voter_count: number; options: { voter_count: number }[] }) {
  await deps.sql`update telegram_polls set final_counts = ${p.options.map((o) => o.voter_count)}, total_voters = ${p.total_voter_count},
    closed_at = case when ${p.is_closed} then coalesce(closed_at, now()) else closed_at end where poll_id = ${p.id}`;
}

export async function runResults(deps: Deps, runId: string) {
  const run = await getRun(deps, runId);
  const polls = await deps.sql<{ poll_id: string; question_id: string; correct_indices: number[]; final_counts: number[] | null; total_voters: number | null }[]>`
    select poll_id, question_id, correct_indices, final_counts, total_voters from telegram_polls where run_id = ${runId} order by sent_at`;
  const people = run.anonymous
    ? []
    : await deps.sql<{ telegram_user_id: string; name: string | null; correct: number; answered: number }[]>`
        select a.telegram_user_id::text, max(a.display_name) as name, count(*) filter (where a.is_correct)::int as correct, count(*)::int as answered
        from poll_answers a join telegram_polls p on p.poll_id = a.poll_id where p.run_id = ${runId}
        group by a.telegram_user_id order by correct desc, answered desc`;
  const perQuestion = polls.map((p) => ({
    questionId: p.question_id,
    voters: p.total_voters,
    correctShare: p.final_counts && p.total_voters ? Math.round((p.correct_indices.reduce((s, i) => s + (p.final_counts![i] ?? 0), 0) / p.total_voters) * 100) : null,
  }));
  return { run: { id: run.id, status: run.status, anonymous: run.anonymous, chatTitle: run.chat_title, questions: run.question_ids.length, skipped: run.skipped_question_ids.length }, people, perQuestion };
}

async function finishRun(deps: Deps, run: RunRow) {
  const [host] = await deps.sql<{ language: Lang; title: string }[]>`
    select u.language, z.title from users u, quiz_versions v join quizzes z on z.id = v.quiz_id where u.id = ${run.host_id} and v.id = ${run.quiz_version_id}`;
  const lang = host?.language ?? "uz";
  const res = await runResults(deps, run.id);
  const board = run.anonymous
    ? translate(lang, "bot.groupAnonymousNote")
    : res.people
        .slice(0, 10)
        .map((p, i) => `${i + 1}. ${escapeHtml(p.name ?? "—")} — ${p.correct}/${run.question_ids.length}`)
        .join("\n");
  const n = run.anonymous ? Math.max(0, ...res.perQuestion.map((q) => q.voters ?? 0)) : res.people.length;
  await enqueueMessage(deps.sql, {
    chatId: run.chat_id!,
    method: "sendMessage",
    payload: { text: translate(lang, "bot.groupResults", { title: escapeHtml(host?.title ?? ""), n, board }), parse_mode: "HTML" },
    dedupeKey: `group-results:${run.id}`,
  });
  await deps.sql`update group_quiz_runs set status = 'finished', finished_at = now(), next_send_at = null where id = ${run.id}`;
}

async function notifyHostNoPermission(deps: Deps, run: RunRow) {
  const [host] = await deps.sql<{ telegram_id: string | null; language: Lang }[]>`select telegram_id::text, language from users where id = ${run.host_id}`;
  if (!host?.telegram_id) return; // account deleted meanwhile
  await enqueueMessage(deps.sql, { chatId: host.telegram_id, userId: run.host_id, method: "sendMessage", payload: { text: translate(host.language, "bot.groupNoPermission") }, dedupeKey: `group-noperm:${run.id}` });
}
