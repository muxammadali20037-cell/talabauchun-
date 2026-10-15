import type { Deps } from "../deps";
import { retrieve, type RetrievedChunk } from "../search/retrieve";
import { contentStems, coverage, splitKeep } from "./text";
import type { CandidateEvidence } from "./validate";

export type EvidenceSearch = {
  evidence: CandidateEvidence | null;
  /** passage that matches the question but not the given answer (possible conflict) */
  closestPassage: { quote: string; documentTitle: string; locator: RetrievedChunk["locator"] } | null;
  candidates: RetrievedChunk[];
};

const QUESTION_WORDS = new Set(["nima", "qanday", "qaysi", "nechta", "kim", "qachon", "qayerda", "deb", "ataladi", "deyiladi", "what", "which", "how", "when", "who", "что", "какой", "как", "когда", "кто"]);

/**
 * Looks for a sentence in the user's selected sources that contains the given
 * answer and matches the question topic. Only an exact sentence from a chunk is
 * ever returned as evidence; otherwise `evidence` is null (no fake citations).
 */
export async function findEvidenceForAnswer(deps: Deps, p: { userId: string; documentIds: string[]; question: string; answer: string }): Promise<EvidenceSearch> {
  if (!p.documentIds.length) return { evidence: null, closestPassage: null, candidates: [] };
  const candidates = await retrieve(deps, { query: `${p.question} ${p.answer}`, userId: p.userId, documentIds: p.documentIds, limit: 10 });
  const ans = contentStems(p.answer);
  const qs = contentStems(p.question).filter((t) => !QUESTION_WORDS.has(t));
  let best: { score: number; sentence: string; chunk: RetrievedChunk } | null = null;
  let closest: { score: number; sentence: string; chunk: RetrievedChunk } | null = null;
  for (const chunk of candidates) {
    for (const sentence of splitKeep(chunk.text)) {
      const ss = contentStems(sentence);
      const aCov = coverage(ans, ss);
      const qCov = coverage(qs, ss);
      if (aCov >= 0.75 && qCov >= 0.25) {
        const score = aCov * 2 + qCov;
        if (!best || score > best.score) best = { score, sentence, chunk };
      }
      if (qCov >= 0.5 && (!closest || qCov > closest.score)) closest = { score: qCov, sentence, chunk };
    }
  }
  if (best) {
    return {
      evidence: {
        chunkId: best.chunk.chunkId,
        documentId: best.chunk.documentId,
        documentVersionId: best.chunk.documentVersionId,
        documentTitle: best.chunk.documentTitle,
        locator: best.chunk.locator,
        quote: best.sentence,
        method: "exact_quote",
      },
      closestPassage: null,
      candidates,
    };
  }
  return {
    evidence: null,
    closestPassage: closest ? { quote: closest.sentence, documentTitle: closest.chunk.documentTitle, locator: closest.chunk.locator } : null,
    candidates,
  };
}
