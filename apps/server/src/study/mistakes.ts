import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { describeLocator } from "../search/retrieve";

/** Mistakes notebook: the latest wrong answer per question (by stable id), with the correct answer and its source. */
export async function listMistakes(deps: Deps, user: UserRow, opts: { limit?: number } = {}) {
  const rows = await deps.sql<{ question_id: string; stable_id: string; text: string; chosen: string[]; correct: string[]; quote: string | null; locator: Record<string, unknown> | null; document_title: string | null; quiz_title: string; quiz_id: string; answered_at: Date; times: number }[]>`
    with wrong as (
      select distinct on (q.stable_id) q.id as question_id, q.stable_id, q.text, aa.selected_option_ids, aa.answered_at, q.source_ref_id, v.quiz_id
      from attempt_answers aa join attempts a on a.id = aa.attempt_id join questions q on q.id = aa.question_id join quiz_versions v on v.id = q.quiz_version_id
      where a.user_id = ${user.id} and not aa.is_correct
      order by q.stable_id, aa.answered_at desc
    )
    select w.question_id, w.stable_id, w.text, w.answered_at, z.title as quiz_title, w.quiz_id,
      array(select o.text from options o where o.id = any(w.selected_option_ids)) as chosen,
      array(select o.text from options o join private_answer_keys k on k.question_id = w.question_id where o.id = any(k.correct_option_ids) order by o.position) as correct,
      sr.quote, sr.locator, sr.document_title,
      (select count(*)::int from attempt_answers x join attempts y on y.id = x.attempt_id join questions qq on qq.id = x.question_id where y.user_id = ${user.id} and not x.is_correct and qq.stable_id = w.stable_id) as times
    from wrong w join quizzes z on z.id = w.quiz_id left join source_references sr on sr.id = w.source_ref_id
    -- a question answered correctly after the last mistake leaves the notebook
    where not exists (
      select 1 from attempt_answers c join attempts ca on ca.id = c.attempt_id join questions cq on cq.id = c.question_id
      where ca.user_id = ${user.id} and c.is_correct and cq.stable_id = w.stable_id and c.answered_at > w.answered_at)
    order by w.answered_at desc limit ${Math.min(opts.limit ?? 50, 200)}`;
  return {
    items: rows.map((r) => ({
      questionId: r.question_id, stableId: r.stable_id, text: r.text, yourAnswer: r.chosen, correct: r.correct, times: r.times,
      quizId: r.quiz_id, quizTitle: r.quiz_title, answeredAt: r.answered_at,
      source: r.quote ? { quote: r.quote, documentTitle: r.document_title, where: describeLocator((r.locator ?? {}) as never, user.language) } : null,
    })),
  };
}
