import type { Tx } from "../db/index";
import { nativePollCompatible, type Candidate, type Check } from "./validate";

/** Writes generated/edited candidates into a quiz version: evidence snapshot, question, options, private key, checks. */
export async function insertCandidate(tx: Tx, p: { versionId: string; workspaceId: string; position: number; c: Candidate; checks: Check[]; status: string; stableId?: string; revision?: number }) {
  const { c } = p;
  let sourceRefId: string | null = null;
  if (c.evidence) {
    const [ref] = await tx<{ id: string }[]>`
      insert into source_references (workspace_id, document_id, document_version_id, chunk_id, document_title, locator, quote, verified, verification)
      values (${p.workspaceId}, ${c.evidence.documentId}, ${c.evidence.documentVersionId}, ${c.evidence.chunkId}, ${c.evidence.documentTitle},
              ${tx.json(c.evidence.locator as never)}, ${c.evidence.quote}, ${c.evidenceStatus === "verified"}, ${c.evidence.method})
      returning id`;
    sourceRefId = ref!.id;
  }
  const payload = { nativePollOk: nativePollCompatible(c), ...(c.notes ?? {}) };
  const [q] = await tx<{ id: string }[]>`
    insert into questions (quiz_version_id, ${p.stableId ? tx`stable_id,` : tx``} revision, position, type, text, language, topic, difficulty, cognitive_level, explanation,
      status, generator, evidence_status, source_ref_id, payload)
    values (${p.versionId}, ${p.stableId ? tx`${p.stableId},` : tx``} ${p.revision ?? 1}, ${p.position}, ${c.type}, ${c.text}, ${c.language}, ${c.topic}, ${c.difficulty},
      ${c.cognitiveLevel}, ${c.explanation}, ${p.status}, ${c.generator}, ${c.evidenceStatus}, ${sourceRefId}, ${tx.json(payload as never)})
    returning id`;
  const correctIds: string[] = [];
  for (let i = 0; i < c.options.length; i++) {
    const o = c.options[i]!;
    const [row] = await tx<{ id: string }[]>`
      insert into options (question_id, position, text, why_wrong) values (${q!.id}, ${i}, ${o.text}, ${o.whyWrong ?? null}) returning id`;
    if (o.correct) correctIds.push(row!.id);
  }
  await tx`insert into private_answer_keys (question_id, correct_option_ids) values (${q!.id}, ${correctIds})`;
  await writeChecks(tx, q!.id, p.checks);
  return q!.id;
}

export async function writeChecks(tx: Tx, questionId: string, checks: Check[]) {
  await tx`delete from question_checks where question_id = ${questionId} and checker <> 'user'`;
  for (const ch of checks) {
    await tx`insert into question_checks (question_id, rule, result, checker, detail)
      values (${questionId}, ${ch.rule}, ${ch.result}, ${ch.checker ?? "deterministic"}, ${tx.json((ch.detail ?? {}) as never)})`;
  }
}
