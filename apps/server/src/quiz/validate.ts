import { TELEGRAM } from "@talaba/shared";
import type { EvidenceStatus, Locator } from "@talaba/shared";
import { contentStems, coverage, jaccard, levenshteinRatio, norm, numbersIn } from "./text";

export type CandidateOption = { text: string; correct: boolean; whyWrong?: string | null };
export type CandidateEvidence = {
  chunkId: string | null;
  documentId: string | null;
  documentVersionId: string | null;
  documentTitle: string;
  locator: Locator & { section?: number };
  quote: string;
  method: "exact_quote" | "fuzzy_quote" | "user_confirmed" | "table_value";
};
export type Candidate = {
  text: string;
  type: "single" | "multiple" | "true_false";
  options: CandidateOption[];
  explanation: string | null;
  difficulty: "easy" | "medium" | "hard";
  cognitiveLevel: "recall" | "understand" | "apply" | "analyze";
  topic: string | null;
  language: string;
  evidence: CandidateEvidence | null;
  evidenceStatus: EvidenceStatus;
  generator: "ai" | "extractive" | "user";
  sourceLanguage?: string | null;
  /** extra info shown to the editor (e.g. conflict with the user's answer, candidate passages) */
  notes?: Record<string, unknown>;
};

export type Check = { rule: string; result: "pass" | "warn" | "fail"; detail?: Record<string, unknown>; checker?: "deterministic" | "ai" | "user" };

const META_OPTION = /^(barchasi|hammasi|hech (biri|qaysisi)|yuqoridagi(lar)?ning (barchasi|hammasi)|all of the above|none of the above|все (перечисленные|ответы)|ни один|ҳаммаси|барчаси)/iu;
const UNIT_RE = /(%|foiz|so[ʻ'‘]?m|сўм|сум|dollar|\$|kg|km|m²|ga\b|yil|йил|год|year|tonna|litr|marta|barobar)/iu;

/**
 * Deterministic checks for rules 1–8 of the quiz quality policy. AI checks
 * (blind solving, translation fidelity) are added separately when available.
 */
export function deterministicChecks(c: Candidate, others: Candidate[], ctx: { sourcesOnly: boolean; aiAvailable: boolean }): Check[] {
  const checks: Check[] = [];
  const correct = c.options.filter((o) => o.correct);
  const wrong = c.options.filter((o) => !o.correct);

  // 1. clear and answerable in form
  const clarity: string[] = [];
  if (c.text.trim().length < 8) clarity.push("question_too_short");
  if (c.options.length < 2) clarity.push("too_few_options");
  if (c.type === "single" && c.options.length !== 4 && c.options.length !== 2) clarity.push("non_standard_option_count");
  if (c.options.some((o) => !o.text.trim())) clarity.push("empty_option");
  checks.push({ rule: "clarity", result: clarity.some((x) => x !== "non_standard_option_count") ? "fail" : clarity.length ? "warn" : "pass", detail: clarity.length ? { issues: clarity } : undefined });

  // 2. the correct answer is supported by the cited source
  if (c.evidenceStatus === "verified" && c.evidence) {
    const quoteStems = contentStems(c.evidence.quote);
    const answerCov = correct.length ? Math.min(...correct.map((o) => coverage(contentStems(o.text), quoteStems))) : 0;
    const needsDirect = c.cognitiveLevel === "recall" || c.generator !== "ai";
    checks.push({
      rule: "source_support",
      result: answerCov >= 0.6 ? "pass" : needsDirect && !ctx.aiAvailable ? "warn" : "warn",
      detail: { answerCoverage: Math.round(answerCov * 100) / 100, method: c.evidence.method },
    });
  } else if (c.evidenceStatus === "general_knowledge" && !ctx.sourcesOnly) {
    checks.push({ rule: "source_support", result: "warn", detail: { reason: "general_knowledge_not_book_evidence" } });
  } else {
    checks.push({ rule: "source_support", result: "fail", detail: { reason: c.evidenceStatus === "not_found" ? "answer_not_found_in_sources" : "evidence_unverified" } });
  }

  // 3. exactly one correct answer for single-answer questions
  if (c.type === "single" || c.type === "true_false") {
    checks.push({ rule: "single_correct", result: correct.length === 1 ? "pass" : "fail", detail: { correctCount: correct.length } });
  } else {
    checks.push({ rule: "single_correct", result: correct.length >= 2 ? "pass" : "fail", detail: { correctCount: correct.length, type: "multiple" } });
  }

  // 4. options are distinct and do not contain each other
  const dupes: [number, number][] = [];
  const contains: [number, number][] = [];
  for (let i = 0; i < c.options.length; i++) {
    for (let j = i + 1; j < c.options.length; j++) {
      const a = c.options[i]!.text;
      const b = c.options[j]!.text;
      if (norm(a) === norm(b) || levenshteinRatio(a, b) >= 0.92) dupes.push([i, j]);
      else {
        const na = norm(a);
        const nb = norm(b);
        if ((na.length >= 4 && nb.includes(na)) || (nb.length >= 4 && na.includes(nb))) contains.push([i, j]);
      }
    }
  }
  const meta = c.options.map((o, i) => (META_OPTION.test(o.text.trim()) ? i : -1)).filter((i) => i >= 0);
  checks.push({
    rule: "options_distinct",
    result: dupes.length ? "fail" : contains.length || meta.length ? "warn" : "pass",
    detail: dupes.length || contains.length || meta.length ? { duplicates: dupes, containment: contains, metaOptions: meta } : undefined,
  });

  // 5. numbers / dates / units
  const issues5: string[] = [];
  if (c.evidence) {
    const evNums = new Set(numbersIn(c.evidence.quote));
    for (const o of correct) for (const n of numbersIn(o.text)) if (!evNums.has(n)) issues5.push(`number_not_in_source:${n}`);
  }
  const unitOf = (t: string) => (UNIT_RE.exec(t)?.[1] ?? "").toLowerCase();
  const correctUnit = correct[0] ? unitOf(correct[0].text) : "";
  if (correctUnit && wrong.some((w) => unitOf(w.text) !== correctUnit && numbersIn(w.text).length)) issues5.push("unit_mismatch");
  checks.push({ rule: "facts_numbers", result: issues5.length ? "warn" : "pass", detail: issues5.length ? { issues: issues5 } : undefined });

  // 6. explanation and location pointer
  const issues6: string[] = [];
  if (!c.explanation?.trim()) issues6.push("explanation_missing");
  if (c.evidence && !Object.keys(c.evidence.locator ?? {}).length) issues6.push("locator_missing");
  checks.push({ rule: "explanation_locator", result: issues6.length ? "warn" : "pass", detail: issues6.length ? { issues: issues6 } : undefined });

  // 7. not a cosmetic copy of another question
  const mine = contentStems(c.text + " " + correct.map((o) => o.text).join(" "));
  const similar = others.filter((o) => o !== c).map((o) => jaccard(mine, contentStems(o.text + " " + o.options.filter((x) => x.correct).map((x) => x.text).join(" ")))).filter((s) => s >= 0.8);
  checks.push({ rule: "not_duplicate", result: similar.length ? "fail" : "pass", detail: similar.length ? { similarity: Math.max(...similar) } : undefined });

  // 8. translation fidelity (needs an independent AI check when languages differ)
  if (c.sourceLanguage && c.sourceLanguage !== c.language) {
    checks.push({ rule: "translation", result: ctx.aiAvailable ? "pass" : "warn", detail: { from: c.sourceLanguage, to: c.language, verifiedBy: ctx.aiAvailable ? "ai_validator" : null } });
  } else {
    checks.push({ rule: "translation", result: "pass" });
  }

  // questions built by heuristics (no LLM) always need a human look before publishing
  if (c.generator === "extractive") checks.push({ rule: "review_required", result: "warn", detail: { reason: "extractive_generation" } });

  // correct answer should not stand out by length
  if (correct.length === 1 && wrong.length >= 2) {
    const cl = correct[0]!.text.length;
    const wl = wrong.map((w) => w.text.length);
    const avg = wl.reduce((a, b) => a + b, 0) / wl.length;
    const outlier = cl > Math.max(...wl) * 1.6 && cl - avg > 15;
    checks.push({ rule: "answer_length", result: outlier ? "warn" : "pass", detail: outlier ? { correct: cl, avgWrong: Math.round(avg) } : undefined });
  }
  return checks;
}

export function statusFromChecks(checks: Check[]): "draft" | "needs_review" {
  return checks.some((c) => c.result !== "pass") ? "needs_review" : "draft";
}

export function nativePollCompatible(c: { text: string; options: { text: string }[]; explanation: string | null }) {
  const lineFeeds = (c.explanation ?? "").split("\n").length - 1;
  return (
    c.text.length <= TELEGRAM.pollQuestionMax &&
    c.options.length >= 2 &&
    c.options.length <= TELEGRAM.pollOptionsMax &&
    c.options.every((o) => o.text.length <= TELEGRAM.pollOptionMax)
  ) && lineFeeds <= TELEGRAM.pollExplanationMaxLineFeeds;
}
