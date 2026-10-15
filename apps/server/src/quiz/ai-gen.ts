import { z } from "zod";
import { UNTRUSTED_DATA_RULES, type AiClient } from "../ai/client";
import { describeLocator, type RetrievedChunk } from "../search/retrieve";
import { shuffle } from "../lib/crypto";
import { locateQuote } from "./text";
import type { Candidate, CandidateEvidence, Check } from "./validate";

const LANG_NAMES: Record<string, string> = { uz: "Uzbek (Latin script, use ʻ in oʻ/gʻ)", "uz-Cyrl": "Uzbek (Cyrillic script)", ru: "Russian", en: "English" };

export function sourceBlock(chunks: RetrievedChunk[]): { block: string; ids: Map<string, RetrievedChunk> } {
  const ids = new Map<string, RetrievedChunk>();
  const parts = chunks.map((c, i) => {
    const id = `s${i + 1}`;
    ids.set(id, c);
    const loc = describeLocator(c.locator, "en");
    return `<source id="${id}" title="${escapeAttr(c.documentTitle)}" location="${escapeAttr(loc)}">\n${c.text.replace(/<\/?source[^>]*>/gi, "")}\n</source>`;
  });
  return { block: parts.join("\n"), ids };
}

function escapeAttr(s: string) {
  return s.replace(/["<>]/g, "");
}

const GenOption = z.object({ text: z.string(), correct: z.boolean(), why_wrong: z.string().nullable() });
const GenQuestion = z.object({
  question: z.string(),
  type: z.enum(["single", "multiple", "true_false"]),
  options: z.array(GenOption),
  explanation: z.string(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  cognitive_level: z.enum(["recall", "understand", "apply", "analyze"]),
  topic: z.string(),
  evidence_source_id: z.string().nullable(),
  evidence_quote: z.string().nullable(),
});
export const GenOutput = z.object({ questions: z.array(GenQuestion), not_enough_material_note: z.string().nullable() });
export type GenOutput = z.infer<typeof GenOutput>;

const GEN_SYSTEM = `You write multiple-choice study questions for university students strictly from their own study material.
${UNTRUSTED_DATA_RULES}
Rules for every question:
- It must be answerable from one <source>; set evidence_source_id to that source id and evidence_quote to a short VERBATIM excerpt (one or two sentences copied exactly) that proves the correct answer.
- Default: type "single" with exactly 4 options and exactly 1 correct. Use "multiple" only when explicitly allowed, and then say in the question text that several answers are correct.
- Distractors must be plausible mistakes about the same topic, in the same grammatical form and similar length as the correct option; never joke options, never "all/none of the above". Do not make the correct option longer or more detailed than the others.
- For each wrong option give why_wrong (one sentence); for the correct option why_wrong is null.
- explanation: why the correct answer is right, based on the evidence.
- Do not repeat a question with cosmetic changes. Do not use facts that are not in the material.
- If the material supports fewer good questions than requested, return only those and explain in not_enough_material_note.`;

export async function aiGenerateFromChunks(
  ai: AiClient,
  chunks: RetrievedChunk[],
  o: { count: number; language: string; allowMultiple: boolean; difficultyMix: { easy: number; medium: number; hard: number }; topic?: string; meta?: { userId?: string; workspaceId?: string; jobId?: string } },
): Promise<{ candidates: Candidate[]; note: string | null; rejected: number }> {
  const { block, ids } = sourceBlock(chunks);
  const user = `${block}\n\nWrite ${o.count} questions in ${LANG_NAMES[o.language] ?? o.language}. Difficulty mix: easy ${Math.round(o.difficultyMix.easy * 100)}%, medium ${Math.round(o.difficultyMix.medium * 100)}%, hard ${Math.round(o.difficultyMix.hard * 100)}%. ${o.allowMultiple ? "Some questions may have several correct answers." : "Every question has exactly one correct answer."}${o.topic ? ` Focus topic: ${o.topic}.` : ""}`;
  const res = await ai.structured({ task: "quiz_generate", tier: "strong", system: GEN_SYSTEM, user, schema: GenOutput, effort: "medium", meta: o.meta });
  let rejected = 0;
  const candidates: Candidate[] = [];
  for (const q of res.data.questions) {
    const chunk = q.evidence_source_id ? ids.get(q.evidence_source_id) : undefined;
    let evidence: CandidateEvidence | null = null;
    if (chunk && q.evidence_quote) {
      const found = locateQuote(q.evidence_quote, chunk.text);
      if (found) evidence = { chunkId: chunk.chunkId, documentId: chunk.documentId, documentVersionId: chunk.documentVersionId, documentTitle: chunk.documentTitle, locator: chunk.locator, quote: found.quote, method: found.method };
    }
    if (!evidence) rejected++;
    candidates.push({
      text: q.question.trim(),
      type: q.type,
      options: q.options.map((op) => ({ text: op.text.trim(), correct: op.correct, whyWrong: op.why_wrong })),
      explanation: q.explanation,
      difficulty: q.difficulty,
      cognitiveLevel: q.cognitive_level,
      topic: q.topic || null,
      language: o.language,
      // A quote the model claimed but that is not in the source is dropped: no fake citations.
      evidence,
      evidenceStatus: evidence ? "verified" : "unverified",
      generator: "ai",
      notes: evidence ? undefined : { droppedCitation: q.evidence_quote ? "quote_not_found_in_source" : "no_quote" },
    });
  }
  return { candidates, note: res.data.not_enough_material_note, rejected };
}

const AnswerOutput = z.object({
  items: z.array(
    z.object({
      index: z.number(),
      found_in_sources: z.boolean(),
      correct_answer: z.string().nullable(),
      evidence_source_id: z.string().nullable(),
      evidence_quote: z.string().nullable(),
      distractors: z.array(z.object({ text: z.string(), why_wrong: z.string() })),
      explanation: z.string().nullable(),
      user_answer_conflicts_with_source: z.boolean(),
      conflict_note: z.string().nullable(),
    }),
  ),
});

/**
 * Questions-only and question+answer lists: the model looks for the answer in
 * the retrieved passages (or checks the user's answer) and writes distractors.
 * A user-supplied answer is never silently replaced; conflicts are reported.
 */
export async function aiAnswerAndDistract(
  ai: AiClient,
  items: { question: string; userAnswer: string | null; chunks: RetrievedChunk[] }[],
  o: { language: string; meta?: { userId?: string; workspaceId?: string; jobId?: string } },
): Promise<Candidate[]> {
  const all = new Map<string, RetrievedChunk>();
  const sections = items.map((it, i) => {
    const ids: string[] = [];
    for (const c of it.chunks) {
      let id = [...all.entries()].find(([, v]) => v.chunkId === c.chunkId)?.[0];
      if (!id) {
        id = `s${all.size + 1}`;
        all.set(id, c);
      }
      ids.push(id);
    }
    return `<item index="${i}">\nQuestion: ${it.question}\n${it.userAnswer ? `User's answer: ${it.userAnswer}\n` : ""}Relevant sources: ${ids.join(", ") || "none"}\n</item>`;
  });
  const sourcesText = [...all.entries()]
    .map(([id, c]) => `<source id="${id}" title="${escapeAttr(c.documentTitle)}" location="${escapeAttr(describeLocator(c.locator, "en"))}">\n${c.text}\n</source>`)
    .join("\n");
  const system = `You turn a student's questions into 4-option multiple-choice questions grounded in their material.
${UNTRUSTED_DATA_RULES}
For each item: decide whether the answer is stated in the listed sources. If yes, set found_in_sources=true, give correct_answer (short), evidence_source_id and a VERBATIM evidence_quote. If the user supplied an answer, keep it as correct_answer unless the sources clearly contradict it; in that case set user_answer_conflicts_with_source=true and explain in conflict_note (still keep the user's answer). If the sources do not contain the answer, set found_in_sources=false and leave correct_answer null unless the user supplied one. Always write exactly 3 plausible distractors in the same form and length as the correct answer, each with why_wrong. Write in ${LANG_NAMES[o.language] ?? o.language}.`;
  const res = await ai.structured({ task: "quiz_from_questions", tier: "strong", system, user: `${sourcesText}\n\n${sections.join("\n")}`, schema: AnswerOutput, effort: "medium", meta: o.meta });
  return items.map((it, i) => {
    const r = res.data.items.find((x) => x.index === i);
    const answer = it.userAnswer ?? r?.correct_answer ?? null;
    let evidence: CandidateEvidence | null = null;
    const chunk = r?.evidence_source_id ? all.get(r.evidence_source_id) : undefined;
    if (r?.found_in_sources && chunk && r.evidence_quote) {
      const found = locateQuote(r.evidence_quote, chunk.text);
      if (found) evidence = { chunkId: chunk.chunkId, documentId: chunk.documentId, documentVersionId: chunk.documentVersionId, documentTitle: chunk.documentTitle, locator: chunk.locator, quote: found.quote, method: found.method };
    }
    const options = answer ? [{ text: answer, correct: true }, ...(r?.distractors ?? []).slice(0, 3).map((d) => ({ text: d.text, correct: false, whyWrong: d.why_wrong }))] : [];
    return {
      text: it.question,
      type: "single",
      options,
      explanation: r?.explanation ?? null,
      difficulty: "medium",
      cognitiveLevel: "recall",
      topic: null,
      language: o.language,
      evidence,
      evidenceStatus: evidence ? "verified" : r?.found_in_sources === false ? "not_found" : "unverified",
      generator: it.userAnswer ? "user" : "ai",
      notes: {
        ...(r?.user_answer_conflicts_with_source ? { conflict: r.conflict_note ?? "conflict" } : {}),
        ...(!answer ? { needsAnswer: true } : {}),
      },
    } satisfies Candidate;
  });
}

const BlindOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      chosen: z.array(z.string()),
      answerable_from_source: z.boolean(),
      other_defensible: z.array(z.string()),
      ambiguous: z.boolean(),
      language_ok: z.boolean(),
      issues: z.array(z.string()),
    }),
  ),
});

/**
 * Independent blind check: a separate call sees the question, shuffled options
 * (letters only) and the evidence passage, but NOT the answer key. Mismatches,
 * extra defensible options or unanswerable questions become failed checks.
 */
export async function aiBlindValidate(ai: AiClient, cands: { key: string; c: Candidate; passage: string }[], meta?: { userId?: string; workspaceId?: string; jobId?: string }): Promise<Map<string, Check[]>> {
  const out = new Map<string, Check[]>();
  const LETTERS = "ABCDEFGHIJKL";
  for (let start = 0; start < cands.length; start += 8) {
    const batch = cands.slice(start, start + 8);
    const keyMaps = new Map<string, Map<string, number>>();
    const blocks = batch.map(({ key, c, passage }) => {
      const order = shuffle(c.options.map((_, i) => i));
      const m = new Map<string, number>();
      const lines = order.map((optIdx, pos) => {
        m.set(LETTERS[pos]!, optIdx);
        return `${LETTERS[pos]}) ${c.options[optIdx]!.text}`;
      });
      keyMaps.set(key, m);
      return `<item id="${key}">\n<source>\n${passage}\n</source>\nQuestion (${c.type === "multiple" ? "several answers may be correct" : "exactly one answer is correct"}): ${c.text}\n${lines.join("\n")}\n</item>`;
    });
    const system = `You independently check quiz questions written from study material. For each item, answer it using ONLY the passage in its <source>. ${UNTRUSTED_DATA_RULES}
Return the letters you choose in "chosen". Set answerable_from_source=false if the passage does not let a careful student determine the answer. List in other_defensible any other option letters that could also be argued correct from the passage. Set ambiguous=true if the wording is unclear. Set language_ok=false if the question or options are badly written or a translation changed the meaning. Use short issue codes in issues.`;
    const res = await ai.structured({ task: "quiz_validate", tier: "strong", system, user: blocks.join("\n"), schema: BlindOutput, effort: "low", meta });
    for (const { key, c } of batch) {
      const r = res.data.results.find((x) => x.id === key);
      const map = keyMaps.get(key)!;
      if (!r) {
        out.set(key, [{ rule: "ai_blind_check", checker: "ai", result: "warn", detail: { reason: "no_result" } }]);
        continue;
      }
      const chosen = new Set(r.chosen.map((l) => map.get(l.trim().toUpperCase())).filter((x): x is number => x !== undefined));
      const correct = new Set(c.options.map((o, i) => (o.correct ? i : -1)).filter((i) => i >= 0));
      const agrees = chosen.size === correct.size && [...chosen].every((i) => correct.has(i));
      const extra = r.other_defensible.map((l) => map.get(l.trim().toUpperCase())).filter((x): x is number => x !== undefined && !correct.has(x));
      const checks: Check[] = [
        { rule: "ai_blind_check", checker: "ai", result: agrees && r.answerable_from_source ? "pass" : "fail", detail: { agrees, answerable: r.answerable_from_source } },
        { rule: "ai_single_correct", checker: "ai", result: extra.length ? "fail" : "pass", detail: extra.length ? { otherDefensible: extra } : undefined },
        { rule: "ai_clarity", checker: "ai", result: r.ambiguous || !r.language_ok ? "warn" : "pass", detail: r.issues.length ? { issues: r.issues.slice(0, 5) } : undefined },
      ];
      out.set(key, checks);
    }
  }
  return out;
}
