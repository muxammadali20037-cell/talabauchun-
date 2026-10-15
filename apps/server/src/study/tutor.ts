import { assertAiAssistQuota } from "../billing/plans";
import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AiError, UNTRUSTED_DATA_RULES } from "../ai/client";
import { AppError } from "../lib/errors";
import { describeLocator, retrieve } from "../search/retrieve";
import { sourceBlock } from "../quiz/ai-gen";
import { contentStems, coverage, locateQuote, splitKeep } from "../quiz/text";

export const AskInput = z.object({
  question: z.string().min(2).max(4000),
  documentIds: z.array(z.string().uuid()).max(10).optional(),
  mode: z.enum(["sources_only", "general", "sources_plus_web"]).default("sources_only"),
  style: z.enum(["normal", "simpler", "example", "hint", "check_me"]).default("normal"),
  studentAnswer: z.string().max(4000).optional(),
});

const STYLE: Record<string, string> = {
  normal: "Explain clearly and concisely.",
  simpler: "Explain more simply, as to a first-year student, with everyday words.",
  example: "Explain with one concrete worked example.",
  hint: "Do NOT give the final answer; give one or two hints that lead the student to it.",
  check_me: "The student gives their own answer; say what is right, what is wrong and why, without rewriting their whole answer.",
};

const Answer = z.object({
  found_in_sources: z.boolean(),
  answer: z.string(),
  claims: z.array(z.object({ text: z.string(), source_id: z.string(), quote: z.string() })),
  general_note: z.string().nullable(),
  needs_clarification: z.string().nullable(),
});

/**
 * Study assistant. "Only my sources": answers strictly from retrieved
 * passages; when nothing relevant is found it says so instead of answering.
 * Every cited claim is checked against the chunk text; unverifiable citations
 * are dropped. General explanations are labelled as AI notes, never as book evidence.
 */
export async function askTutor(deps: Deps, user: UserRow, raw: unknown) {
  const p = AskInput.parse(raw);
  if (p.mode === "sources_plus_web") throw new AppError("web_search_not_enabled", 409);
  for (const id of p.documentIds ?? []) await requireObjectRole(deps.sql, user, "document", id, "viewer");
  const hits = await retrieve(deps, { query: p.question, userId: user.id, documentIds: p.documentIds, limit: 6 });
  const qStems = contentStems(p.question);
  const relevant = hits.filter((h) => coverage(qStems, contentStems(h.text)) >= 0.34);
  const passages = relevant.map((h) => ({ documentId: h.documentId, documentTitle: h.documentTitle, where: describeLocator(h.locator, user.language), locator: h.locator, quote: h.text }));

  if (p.mode === "sources_only" && !relevant.length) return { status: "not_found" as const, passages: [] };
  if (!deps.ai) {
    // Without an AI provider: the most relevant sentences, quoted with their location.
    const sentences = relevant
      .flatMap((h) => splitKeep(h.text).map((s) => ({ s, h, cov: coverage(qStems, contentStems(s)) })))
      .filter((x) => x.cov > 0)
      .sort((a, b) => b.cov - a.cov)
      .slice(0, 4)
      .map((x) => ({ text: x.s, documentId: x.h.documentId, documentTitle: x.h.documentTitle, where: describeLocator(x.h.locator, user.language), verified: true }));
    return { status: "extractive" as const, claims: sentences, passages };
  }
  const { block, ids } = sourceBlock(relevant);
  const lang = user.language === "ru" ? "Russian" : user.language === "en" ? "English" : user.language === "uz-Cyrl" ? "Uzbek (Cyrillic)" : "Uzbek (Latin)";
  const system = `You are a patient university tutor. Answer in ${lang}. ${UNTRUSTED_DATA_RULES}
${p.mode === "sources_only" ? "Use ONLY the <source> passages. If they do not contain the answer, set found_in_sources=false and say so briefly in answer." : "Prefer the <source> passages; you may add general knowledge, but put it in general_note, never in claims."}
Each claim must quote verbatim the passage (source_id) that supports it. For math/physics/economics problems: givens → method → calculation → units → check → final answer. If the question is ambiguous or a referenced image is unclear, ask in needs_clarification instead of guessing. Medical and legal topics: educational explanation only, no personal advice. ${STYLE[p.style]}`;
  const userMsg = `${block || "<source id=\"none\">(no passages found)</source>"}\n\nQuestion: ${p.question}${p.studentAnswer ? `\nStudent's answer: ${p.studentAnswer}` : ""}`;
  let res;
  try {
    await assertAiAssistQuota(deps.sql, user.id);
    res = await deps.ai.structured({ task: "tutor", tier: "fast", system, user: userMsg, schema: Answer, effort: "low", meta: { userId: user.id }, interactive: true });
  } catch (e) {
    if (e instanceof AiError) throw new AppError(`ai_${e.code}`, e.retryable ? 503 : 502);
    throw e;
  }
  const a = res.data;
  if (p.mode === "sources_only" && !a.found_in_sources) return { status: "not_found" as const, passages };
  const claims = a.claims.map((c) => {
    const chunk = ids.get(c.source_id);
    const found = chunk ? locateQuote(c.quote, chunk.text) : null;
    return { text: c.text, documentId: chunk?.documentId ?? null, documentTitle: chunk?.documentTitle ?? null, where: chunk ? describeLocator(chunk.locator, user.language) : null, quote: found?.quote ?? null, verified: !!found };
  });
  return { status: "answered" as const, answer: a.answer, claims, generalNote: a.general_note, needsClarification: a.needs_clarification, passages };
}
