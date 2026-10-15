import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AppError, notFound } from "../lib/errors";
import { shuffle } from "../lib/crypto";
import { chunksForScope } from "../search/retrieve";
import { capitalize, findDefinitions } from "../quiz/terms";
import { randomUUID } from "node:crypto";

/**
 * “Atama–taʼrifni topish”: pairs come from definitions in the user's own
 * source (or flashcards). The answer key stays on the server; the client gets
 * shuffled terms and definitions with opaque ids and submits its pairing once.
 */
export async function startMatching(deps: Deps, user: UserRow, p: { documentId?: string; size?: number }) {
  let pairs: { term: string; definition: string }[] = [];
  if (p.documentId) {
    await requireObjectRole(deps.sql, user, "document", p.documentId, "viewer");
    const chunks = await chunksForScope(deps, { userId: user.id, documentIds: [p.documentId], maxChunks: 400 });
    pairs = findDefinitions(chunks.map((c) => c.text)).map((d) => ({ term: capitalize(d.term), definition: d.definition }));
  } else {
    pairs = await deps.sql<{ term: string; definition: string }[]>`select front as term, back as definition from flashcards where owner_id = ${user.id} and deleted_at is null and length(front) < 80 order by random() limit 12`;
  }
  const size = Math.min(Math.max(p.size ?? 6, 3), 8);
  if (pairs.length < 3) throw new AppError("not_enough_pairs", 409, "need at least 3 definitions", { found: pairs.length });
  const chosen = shuffle(pairs).slice(0, size);
  const withIds = chosen.map((c) => ({ termId: randomUUID(), defId: randomUUID(), ...c }));
  const publicPayload = {
    terms: shuffle(withIds.map((x) => ({ id: x.termId, text: x.term }))),
    definitions: shuffle(withIds.map((x) => ({ id: x.defId, text: x.definition }))),
  };
  const key = Object.fromEntries(withIds.map((x) => [x.termId, x.defId]));
  const [s] = await deps.sql<{ id: string }[]>`insert into game_sessions (user_id, kind, public_payload, private_key, max_score)
    values (${user.id}, 'matching', ${deps.sql.json(publicPayload as never)}, ${deps.sql.json(key as never)}, ${withIds.length}) returning id`;
  return { sessionId: s!.id, ...publicPayload };
}

export async function submitMatching(deps: Deps, user: UserRow, sessionId: string, pairs: { termId: string; definitionId: string }[]) {
  return deps.sql.begin(async (tx) => {
    const [s] = await tx<{ private_key: Record<string, string>; finished_at: Date | null; max_score: number; score: number | null }[]>`
      select private_key, finished_at, max_score, score from game_sessions where id = ${sessionId} and user_id = ${user.id} for update`;
    if (!s) throw notFound("game");
    if (s.finished_at) throw new AppError("already_submitted", 409, "already submitted", { score: s.score });
    const seen = new Set<string>();
    const results = pairs.filter((p) => !seen.has(p.termId) && seen.add(p.termId)).map((p) => ({ ...p, correct: s.private_key[p.termId] === p.definitionId }));
    const score = results.filter((r) => r.correct).length;
    await tx`update game_sessions set score = ${score}, finished_at = now() where id = ${sessionId}`;
    return { score, max: s.max_score, results, answer: s.private_key };
  });
}
