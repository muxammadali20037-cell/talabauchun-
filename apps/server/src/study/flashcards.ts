import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole, requireWorkspaceRole } from "../access/policy";
import { AppError, notFound } from "../lib/errors";
import { chunksForScope, describeLocator } from "../search/retrieve";
import { findDefinitions, capitalize } from "../quiz/terms";
import { splitKeep } from "../quiz/text";

/**
 * SM-2 spaced repetition (grades 0–5). Returns the next state; a lapse
 * (grade < 3) restarts the interval but keeps the card's history.
 */
export function sm2(prev: { ease: number; intervalDays: number; reps: number; lapses: number }, grade: number) {
  const g = Math.max(0, Math.min(5, Math.round(grade)));
  let { ease, intervalDays, reps, lapses } = prev;
  if (g < 3) {
    reps = 0;
    intervalDays = 1;
    lapses += 1;
  } else {
    reps += 1;
    intervalDays = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(intervalDays * ease);
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - g) * (0.08 + (5 - g) * 0.02)));
  return { ease: Math.round(ease * 100) / 100, intervalDays, reps, lapses };
}

type CardRow = { id: string; front: string; back: string; collection: string; due_at: Date; reps: number; lapses: number; ease: number; interval_days: number; quote: string | null; locator: Record<string, unknown> | null; document_title: string | null };

/** Cards from a quiz: front = question, back = correct answer; the evidence snapshot travels with the card. */
export async function cardsFromQuiz(deps: Deps, user: UserRow, quizId: string) {
  await requireObjectRole(deps.sql, user, "quiz", quizId, "viewer");
  const [q] = await deps.sql<{ title: string; version: string | null }[]>`select title, coalesce(published_version_id, draft_version_id) as version from quizzes where id = ${quizId}`;
  if (!q?.version) throw notFound("quiz");
  const rows = await deps.sql<{ stable_id: string; text: string; source_ref_id: string | null; answers: string[] }[]>`
    select q.stable_id, q.text, q.source_ref_id,
      array(select o.text from options o where o.id = any(k.correct_option_ids) order by o.position) as answers
    from questions q join private_answer_keys k on k.question_id = q.id
    where q.quiz_version_id = ${q.version} and q.status in ('draft','approved','published') and q.evidence_status = 'verified'`;
  let created = 0;
  for (const r of rows) {
    const res = await deps.sql`
      insert into flashcards (workspace_id, owner_id, collection, front, back, source_ref_id, question_stable_id)
      values (${user.personal_workspace_id}, ${user.id}, ${q.title.slice(0, 120)}, ${r.text}, ${r.answers.join("; ")}, ${r.source_ref_id}, ${r.stable_id})
      on conflict (owner_id, question_stable_id) do nothing returning id`;
    created += res.length;
  }
  return { created, skipped: rows.length - created };
}

/** Cards from definitions found in a document (term ↔ definition), each with its exact sentence as source. */
export async function cardsFromDocument(deps: Deps, user: UserRow, documentId: string) {
  const { workspaceId } = await requireObjectRole(deps.sql, user, "document", documentId, "viewer");
  const chunks = await chunksForScope(deps, { userId: user.id, documentIds: [documentId], maxChunks: 400 });
  const defs = findDefinitions(chunks.map((c) => c.text));
  let created = 0;
  for (const d of defs) {
    const chunk = chunks[d.chunkIndex]!;
    const sentence = splitKeep(chunk.text).find((s) => s === d.sentence) ?? d.sentence;
    const exists = await deps.sql`select 1 from flashcards where owner_id = ${user.id} and document_id = ${documentId} and front = ${capitalize(d.term)} and deleted_at is null`;
    if (exists.length) continue;
    const [ref] = await deps.sql<{ id: string }[]>`
      insert into source_references (workspace_id, document_id, document_version_id, chunk_id, document_title, locator, quote, verified, verification)
      values (${workspaceId}, ${chunk.documentId}, ${chunk.documentVersionId}, ${chunk.chunkId}, ${chunk.documentTitle}, ${deps.sql.json(chunk.locator as never)}, ${sentence}, true, 'exact_quote') returning id`;
    await deps.sql`insert into flashcards (workspace_id, owner_id, collection, front, back, source_ref_id, document_id)
      values (${user.personal_workspace_id}, ${user.id}, ${chunk.documentTitle.slice(0, 120)}, ${capitalize(d.term)}, ${d.definition}, ${ref!.id}, ${documentId})`;
    created++;
  }
  return { created, found: defs.length };
}

export async function listCards(deps: Deps, user: UserRow, opts: { due?: boolean; limit?: number; collection?: string }) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const rows = await deps.sql<CardRow[]>`
    select f.id, f.front, f.back, f.collection, f.due_at, f.reps, f.lapses, f.ease, f.interval_days, sr.quote, sr.locator, sr.document_title
    from flashcards f left join source_references sr on sr.id = f.source_ref_id
    where f.owner_id = ${user.id} and f.deleted_at is null
      and (${opts.due ?? false} = false or f.due_at <= now())
      and (${opts.collection ?? null}::text is null or f.collection = ${opts.collection ?? null})
    order by f.due_at limit ${limit}`;
  const [c] = await deps.sql<{ total: number; due: number }[]>`
    select count(*)::int as total, count(*) filter (where due_at <= now())::int as due from flashcards where owner_id = ${user.id} and deleted_at is null`;
  return {
    items: rows.map((r) => ({ id: r.id, front: r.front, back: r.back, collection: r.collection, dueAt: r.due_at, reps: r.reps, lapses: r.lapses, source: r.quote ? { quote: r.quote, documentTitle: r.document_title, where: describeLocator((r.locator ?? {}) as never, user.language) } : null })),
    total: c?.total ?? 0,
    due: c?.due ?? 0,
  };
}

export async function reviewCard(deps: Deps, user: UserRow, cardId: string, grade: number) {
  if (!Number.isInteger(grade) || grade < 0 || grade > 5) throw new AppError("invalid_grade", 400);
  return deps.sql.begin(async (tx) => {
    const [c] = await tx<{ ease: number; interval_days: number; reps: number; lapses: number }[]>`
      select ease, interval_days, reps, lapses from flashcards where id = ${cardId} and owner_id = ${user.id} and deleted_at is null for update`;
    if (!c) throw notFound("card");
    const next = sm2({ ease: c.ease, intervalDays: c.interval_days, reps: c.reps, lapses: c.lapses }, grade);
    const due = new Date(Date.now() + next.intervalDays * 86_400_000);
    await tx`update flashcards set ease = ${next.ease}, interval_days = ${next.intervalDays}, reps = ${next.reps}, lapses = ${next.lapses}, due_at = ${due} where id = ${cardId}`;
    await tx`insert into review_events (user_id, flashcard_id, grade, next_due_at) values (${user.id}, ${cardId}, ${grade}, ${due})`;
    return { ...next, dueAt: due };
  });
}

export async function deleteCard(deps: Deps, user: UserRow, cardId: string) {
  const r = await deps.sql`update flashcards set deleted_at = now() where id = ${cardId} and owner_id = ${user.id} returning id`;
  if (!r.length) throw notFound("card");
}

export async function createCard(deps: Deps, user: UserRow, p: { front: string; back: string; collection?: string; workspaceId?: string }) {
  if (p.workspaceId) await requireWorkspaceRole(deps.sql, user, p.workspaceId, "editor");
  const [r] = await deps.sql<{ id: string }[]>`insert into flashcards (workspace_id, owner_id, collection, front, back)
    values (${p.workspaceId ?? user.personal_workspace_id}, ${user.id}, ${(p.collection ?? "default").slice(0, 120)}, ${p.front.slice(0, 1000)}, ${p.back.slice(0, 2000)}) returning id`;
  return { id: r!.id };
}
