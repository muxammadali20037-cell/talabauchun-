import { QuizSettings } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AppError, notFound } from "../lib/errors";
import { shuffle } from "../lib/crypto";
import { describeLocator } from "../search/retrieve";
import type { Lang } from "@talaba/shared";

export type AttemptMode = "bot_practice" | "app_practice" | "mistakes";

type AttemptRow = {
  id: string; quiz_version_id: string; user_id: string; mode: string; question_ids: string[]; option_orders: Record<string, string[]>;
  current_index: number; score: number; max_score: number; status: string; started_at: Date; finished_at: Date | null;
};

async function pickVersion(deps: Deps, user: UserRow, quizId: string) {
  const { role } = await requireObjectRole(deps.sql, user, "quiz", quizId, "viewer");
  const [q] = await deps.sql<{ published_version_id: string | null; draft_version_id: string | null; settings: QuizSettings; title: string }[]>`
    select published_version_id, draft_version_id, settings, title from quizzes where id = ${quizId}`;
  if (!q) throw notFound("quiz");
  if (q.published_version_id) return { versionId: q.published_version_id, isDraft: false, settings: QuizSettings.parse(q.settings ?? {}), title: q.title };
  // Owners/editors may self-practice an unpublished draft (only questions that passed checks).
  if (q.draft_version_id && (role === "owner" || role === "editor")) return { versionId: q.draft_version_id, isDraft: true, settings: QuizSettings.parse(q.settings ?? {}), title: q.title };
  throw new AppError("quiz_not_published", 409);
}

export async function startAttempt(deps: Deps, user: UserRow, quizId: string, mode: AttemptMode, opts: { questionIds?: string[] } = {}) {
  const v = await pickVersion(deps, user, quizId);
  const statuses = v.isDraft ? ["draft", "approved"] : ["published"];
  let qs: { id: string }[] = await deps.sql<{ id: string }[]>`
    select id from questions where quiz_version_id = ${v.versionId} and status in ${deps.sql(statuses)}
      and exists (select 1 from options o where o.question_id = questions.id) order by position`;
  if (opts.questionIds) {
    const want = new Set(opts.questionIds);
    qs = qs.filter((q) => want.has(q.id));
  }
  if (!qs.length) throw new AppError("quiz_empty", 409);
  const ids = v.settings.shuffleQuestions ? shuffle(qs.map((q) => q.id)) : qs.map((q) => q.id);
  const orders: Record<string, string[]> = {};
  for (const id of ids) {
    const opts = await deps.sql<{ id: string }[]>`select id from options where question_id = ${id} order by position`;
    orders[id] = v.settings.shuffleOptions ? shuffle(opts.map((o) => o.id)) : opts.map((o) => o.id);
  }
  const [a] = await deps.sql<AttemptRow[]>`
    insert into attempts (quiz_version_id, user_id, mode, question_ids, option_orders, max_score)
    values (${v.versionId}, ${user.id}, ${mode}, ${ids}, ${deps.sql.json(orders as never)}, ${ids.length * 100}) returning *`;
  return { attemptId: a!.id, total: ids.length, title: v.title, isDraft: v.isDraft };
}

async function loadAttempt(deps: Deps, user: UserRow, attemptId: string): Promise<AttemptRow> {
  const [a] = await deps.sql<AttemptRow[]>`select * from attempts where id = ${attemptId}`;
  if (!a || a.user_id !== user.id) throw notFound("attempt");
  return a;
}

/** Current question in display order — no answer key. */
export async function attemptState(deps: Deps, user: UserRow, attemptId: string) {
  const a = await loadAttempt(deps, user, attemptId);
  const [title] = await deps.sql<{ title: string; quiz_id: string }[]>`select z.title, z.id as quiz_id from quiz_versions v join quizzes z on z.id = v.quiz_id where v.id = ${a.quiz_version_id}`;
  const answered = await deps.sql<{ question_id: string; selected_option_ids: string[]; is_correct: boolean }[]>`select question_id, selected_option_ids, is_correct from attempt_answers where attempt_id = ${a.id}`;
  const idx = a.current_index;
  const qid = a.question_ids[idx];
  let question = null;
  if (a.status === "active" && qid) {
    const [q] = await deps.sql<{ id: string; text: string; type: string }[]>`select id, text, type from questions where id = ${qid}`;
    const opts = await deps.sql<{ id: string; text: string }[]>`select id, text from options where question_id = ${qid}`;
    const byId = new Map(opts.map((o) => [o.id, o]));
    question = { id: q!.id, text: q!.text, type: q!.type, multiple: q!.type === "multiple", options: (a.option_orders[qid] ?? []).map((id) => byId.get(id)).filter(Boolean) as { id: string; text: string }[] };
  }
  return {
    attemptId: a.id, quizId: title?.quiz_id, title: title?.title ?? "", status: a.status, index: idx, total: a.question_ids.length,
    score: a.score, maxScore: a.max_score, question, answeredIds: answered.map((x) => x.question_id),
    alreadyAnswered: qid ? answered.find((x) => x.question_id === qid) ?? null : null,
  };
}

/**
 * Grades by option ids (never by display position) against the private key.
 * A second answer to the same question returns the stored result and adds no points.
 */
export async function answerAttempt(deps: Deps, user: UserRow, attemptId: string, questionId: string, optionIds: string[], lang: Lang = "uz") {
  const a = await loadAttempt(deps, user, attemptId);
  if (a.status !== "active") throw new AppError("attempt_finished", 409);
  if (!a.question_ids.includes(questionId)) throw new AppError("question_not_in_attempt", 400);
  const valid = new Set(a.option_orders[questionId] ?? []);
  if (!optionIds.length || optionIds.some((id) => !valid.has(id))) throw new AppError("invalid_option", 400);
  const [key] = await deps.sql<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${questionId}`;
  const correctSet = new Set(key?.correct_option_ids ?? []);
  const chosen = [...new Set(optionIds)];
  const isCorrect = chosen.length === correctSet.size && chosen.every((id) => correctSet.has(id));
  const points = isCorrect ? 100 : 0;
  const result = await deps.sql.begin(async (tx) => {
    const [ins] = await tx<{ id: string }[]>`
      insert into attempt_answers (attempt_id, question_id, selected_option_ids, is_correct, points)
      values (${a.id}, ${questionId}, ${chosen}, ${isCorrect}, ${points})
      on conflict (attempt_id, question_id) do nothing returning id`;
    if (ins) {
      const idx = a.question_ids.indexOf(questionId);
      await tx`update attempts set score = score + ${points}, current_index = greatest(current_index, ${idx + 1}) where id = ${a.id}`;
      return { duplicate: false, isCorrect, points };
    }
    const [prev] = await tx<{ is_correct: boolean; points: number; selected_option_ids: string[] }[]>`select is_correct, points, selected_option_ids from attempt_answers where attempt_id = ${a.id} and question_id = ${questionId}`;
    return { duplicate: true, isCorrect: prev!.is_correct, points: prev!.points };
  });
  const [q] = await deps.sql<{ explanation: string | null; quote: string | null; locator: Record<string, unknown> | null; document_title: string | null }[]>`
    select q.explanation, sr.quote, sr.locator, sr.document_title from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${questionId}`;
  const opts = await deps.sql<{ id: string; text: string; why_wrong: string | null }[]>`select id, text, why_wrong from options where question_id = ${questionId}`;
  const [fresh] = await deps.sql<{ current_index: number; score: number }[]>`select current_index, score from attempts where id = ${a.id}`;
  const done = (fresh?.current_index ?? 0) >= a.question_ids.length;
  if (done) await deps.sql`update attempts set status = 'finished', finished_at = coalesce(finished_at, now()) where id = ${a.id}`;
  return {
    ...result,
    correctOptionIds: [...correctSet],
    correctTexts: opts.filter((o) => correctSet.has(o.id)).map((o) => o.text),
    whyWrong: opts.filter((o) => chosen.includes(o.id) && !correctSet.has(o.id)).map((o) => o.why_wrong).filter(Boolean),
    explanation: q?.explanation ?? null,
    source: q?.quote ? { quote: q.quote, documentTitle: q.document_title, where: describeLocator((q.locator ?? {}) as never, lang) } : null,
    finished: done,
    score: fresh?.score ?? 0,
    nextIndex: fresh?.current_index ?? 0,
  };
}

export async function finishAttempt(deps: Deps, user: UserRow, attemptId: string) {
  const a = await loadAttempt(deps, user, attemptId);
  if (a.status === "active") await deps.sql`update attempts set status = 'finished', finished_at = now() where id = ${a.id}`;
  return attemptResults(deps, user, attemptId);
}

export async function attemptResults(deps: Deps, user: UserRow, attemptId: string) {
  const a = await loadAttempt(deps, user, attemptId);
  const answers = await deps.sql<{ question_id: string; is_correct: boolean; points: number; selected_option_ids: string[]; text: string }[]>`
    select aa.question_id, aa.is_correct, aa.points, aa.selected_option_ids, q.text from attempt_answers aa join questions q on q.id = aa.question_id where aa.attempt_id = ${a.id}`;
  const [fresh] = await deps.sql<{ score: number; status: string }[]>`select score, status from attempts where id = ${a.id}`;
  return {
    attemptId: a.id, status: fresh!.status, score: fresh!.score, maxScore: a.max_score, total: a.question_ids.length,
    correct: answers.filter((x) => x.is_correct).length, mistakes: answers.filter((x) => !x.is_correct).map((x) => ({ questionId: x.question_id, text: x.text })),
  };
}

/** Re-practice only the questions answered wrong, on the same quiz version. */
export async function startMistakesAttempt(deps: Deps, user: UserRow, attemptId: string) {
  const a = await loadAttempt(deps, user, attemptId);
  const wrong = await deps.sql<{ question_id: string }[]>`select question_id from attempt_answers where attempt_id = ${a.id} and not is_correct`;
  if (!wrong.length) throw new AppError("no_mistakes", 409);
  const [v] = await deps.sql<{ quiz_id: string }[]>`select quiz_id from quiz_versions where id = ${a.quiz_version_id}`;
  const ids = wrong.map((w) => w.question_id);
  const orders: Record<string, string[]> = {};
  for (const id of ids) orders[id] = shuffle(a.option_orders[id] ?? []);
  const [n] = await deps.sql<{ id: string }[]>`
    insert into attempts (quiz_version_id, user_id, mode, question_ids, option_orders, max_score)
    values (${a.quiz_version_id}, ${user.id}, 'mistakes', ${ids}, ${deps.sql.json(orders as never)}, ${ids.length * 100}) returning id`;
  return { attemptId: n!.id, total: ids.length, quizId: v?.quiz_id };
}

export async function activeAttempt(deps: Deps, user: UserRow, mode: AttemptMode) {
  const [a] = await deps.sql<{ id: string }[]>`select id from attempts where user_id = ${user.id} and mode = ${mode} and status = 'active' order by started_at desc limit 1`;
  return a?.id ?? null;
}
