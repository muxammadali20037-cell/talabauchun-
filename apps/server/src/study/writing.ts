import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AiError, UNTRUSTED_DATA_RULES } from "../ai/client";
import { AppError } from "../lib/errors";
import { summarizeDocument } from "./summary";
import { assertAiAssistQuota } from "../billing/plans";

export const WritingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("bibliography"), documentIds: z.array(z.string().uuid()).min(1).max(30), style: z.enum(["gost", "apa"]).default("gost") }),
  z.object({ mode: z.literal("outline"), topic: z.string().min(3).max(300), workType: z.enum(["referat", "kurs_ishi", "maqola", "esse"]).default("referat"), documentIds: z.array(z.string().uuid()).max(10).default([]), requirements: z.string().max(3000).optional() }),
  z.object({ mode: z.literal("annotation"), documentId: z.string().uuid() }),
  z.object({ mode: z.literal("polish"), text: z.string().min(20).max(8000) }),
  z.object({ mode: z.literal("rubric"), text: z.string().min(20).max(12000), rubric: z.string().min(10).max(4000) }),
]);
export type WritingInput = z.infer<typeof WritingInput>;

const LANG_NAME: Record<string, string> = { uz: "Uzbek (Latin script)", "uz-Cyrl": "Uzbek (Cyrillic script)", ru: "Russian", en: "English" };

type DocMeta = { id: string; title: string; author: string | null; published_info: string | null; source_url: string | null; source_kind: string; created_at: Date };

/**
 * Bibliography entries built only from metadata the user has (title, author,
 * publication info, URL). Missing fields are reported, never invented.
 */
export function formatReference(d: DocMeta, style: "gost" | "apa", accessed: Date) {
  const missing: string[] = [];
  if (!d.author) missing.push("author");
  if (!d.published_info && !d.source_url) missing.push("publication");
  const year = d.published_info?.match(/\b(1[89]\d{2}|20\d{2})\b/)?.[1] ?? null;
  if (!year && style === "apa") missing.push("year");
  const date = `${String(accessed.getUTCDate()).padStart(2, "0")}.${String(accessed.getUTCMonth() + 1).padStart(2, "0")}.${accessed.getUTCFullYear()}`;
  // "Karimov A." already ends with a period
  const author = d.author ? (/[.!?]$/.test(d.author.trim()) ? `${d.author.trim()} ` : `${d.author.trim()}. `) : "";
  let text: string;
  if (style === "gost") {
    // ГОСТ 7.1 / O‘zDSt style: Author. Title. — Publication. — URL (accessed: dd.mm.yyyy). Each area ends with a period before the dash.
    const area = (s: string) => {
      const v = s.replace(/\s+/g, " ").trim();
      return /[.!?]$/.test(v) ? v : `${v}.`;
    };
    const areas = [area(`${author}${d.title}`)];
    if (d.published_info) areas.push(area(d.published_info));
    if (d.source_url) areas.push(area(`URL: ${d.source_url} (murojaat sanasi: ${date})`));
    text = areas.join(" — ");
  } else {
    const publisher = d.published_info?.replace(/\b(1[89]\d{2}|20\d{2})\b/, "").replace(/[,.;:\s—-]+$/, "").replace(/^[,.;:\s—-]+/, "").trim();
    text = [author, `(${year ?? "n.d."}). `, `${d.title}. `, publisher ? `${publisher}. ` : "", d.source_url ?? ""].join("").replace(/\s+/g, " ").trim();
  }
  return { documentId: d.id, text, missing };
}

async function docsFor(deps: Deps, user: UserRow, ids: string[]) {
  for (const id of ids) await requireObjectRole(deps.sql, user, "document", id, "viewer");
  if (!ids.length) return [];
  return deps.sql<DocMeta[]>`select id, title, author, published_info, source_url, source_kind, created_at from documents where id in ${deps.sql(ids)} and deleted_at is null order by author nulls last, title`;
}

function aiRequired(deps: Deps) {
  if (!deps.ai) throw new AppError("ai_required", 409, "this mode needs the AI provider");
  return deps.ai;
}
const wrapAi = (e: unknown): never => {
  if (e instanceof AiError) throw new AppError(`ai_${e.code}`, e.retryable ? 503 : 502);
  throw e;
};

/** «quoted» or “quoted” segments: the student's citations, which editing must not change. */
export function quotedSegments(text: string) {
  return [...text.matchAll(/«([^»]{3,})»|“([^”]{3,})”|"([^"]{3,})"/g)].map((m) => (m[1] ?? m[2] ?? m[3])!);
}

/**
 * Writing helper for reports and course papers. Never claims originality or
 * undetectability; citations stay separate from the student's own wording.
 */
export async function writingHelp(deps: Deps, user: UserRow, raw: unknown) {
  const p = WritingInput.parse(raw);
  const lang = LANG_NAME[user.language] ?? "Uzbek (Latin script)";
  const usesAi = !!deps.ai && p.mode !== "bibliography";
  if (usesAi) await assertAiAssistQuota(deps.sql, user.id);
  switch (p.mode) {
    case "bibliography": {
      const docs = await docsFor(deps, user, p.documentIds);
      return { mode: p.mode, style: p.style, entries: docs.map((d, i) => ({ n: i + 1, ...formatReference(d, p.style, new Date()) })) };
    }
    case "outline": {
      const docs = await docsFor(deps, user, p.documentIds);
      const sections: { title: string; document: string }[] = [];
      for (const d of docs) {
        const rows = await deps.sql<{ title: string }[]>`select s.title from sections s join documents x on x.current_version_id = s.document_version_id where x.id = ${d.id} and s.level = 1 order by s.ord limit 12`;
        sections.push(...rows.map((r) => ({ title: r.title, document: d.title })));
      }
      if (!deps.ai) {
        // without AI: a skeleton from the chapters of the chosen sources, clearly labelled as such
        return { mode: p.mode, generated: "from_sources" as const, outline: [{ title: "Kirish", points: [] }, ...sections.map((s) => ({ title: s.title, points: [`Manba: ${s.document}`] })), { title: "Xulosa", points: [] }, { title: "Foydalanilgan adabiyotlar", points: [] }] };
      }
      const Schema = z.object({ outline: z.array(z.object({ title: z.string(), points: z.array(z.string()) })), notes: z.string().nullable() });
      const res = await deps.ai.structured({
        task: "writing", tier: "fast", effort: "low", schema: Schema, meta: { userId: user.id }, interactive: true,
        system: `You help a university student plan a ${p.workType.replace("_", " ")} in ${lang}. ${UNTRUSTED_DATA_RULES} Return a clear outline: introduction (relevance, aim, tasks), 2–4 main chapters with 2–4 points each, conclusion, references. Base chapters on the given source chapters when relevant. Do not invent sources, statistics or citations. Do not write the paper itself.`,
        user: `<topic>${p.topic}</topic>\n<requirements>${p.requirements ?? ""}</requirements>\n<source_chapters>\n${sections.map((s) => `- ${s.title} (${s.document})`).join("\n")}\n</source_chapters>`,
      }).catch(wrapAi);
      return { mode: p.mode, generated: "ai" as const, outline: res.data.outline, notes: res.data.notes };
    }
    case "annotation": {
      await requireObjectRole(deps.sql, user, "document", p.documentId, "viewer");
      const sum = await summarizeDocument(deps, user, p.documentId, { maxPerSection: 2 });
      const points = sum.sections.flatMap((s) => s.points.map((x) => x.text)).slice(0, 8);
      if (!points.length) throw new AppError("not_enough_text", 409);
      if (!deps.ai) return { mode: p.mode, generated: "extractive" as const, annotation: points.slice(0, 4).join(" "), keyPoints: points };
      const Schema = z.object({ annotation: z.string(), keywords: z.array(z.string()) });
      const res = await deps.ai.structured({
        task: "writing", tier: "fast", effort: "low", schema: Schema, meta: { userId: user.id }, interactive: true,
        system: `Write a 70–120 word academic annotation in ${lang} of the source, using only the given key sentences. ${UNTRUSTED_DATA_RULES} Add 4–7 keywords. No facts that are not in the sentences.`,
        user: `<source>\n${points.join("\n")}\n</source>`,
      }).catch(wrapAi);
      return { mode: p.mode, generated: "ai" as const, annotation: res.data.annotation, keywords: res.data.keywords, keyPoints: points };
    }
    case "polish": {
      const ai = aiRequired(deps);
      const Schema = z.object({ text: z.string(), changes: z.array(z.object({ before: z.string(), after: z.string(), why: z.string() })) });
      const res = await ai.structured({
        task: "writing", tier: "fast", effort: "low", schema: Schema, meta: { userId: user.id }, interactive: true,
        system: `Improve the clarity, grammar and academic style of the student's own text in the same language. ${UNTRUSTED_DATA_RULES} Keep the meaning and the student's arguments. Text inside «…», “…” or "…" is a citation: copy it exactly. List the main changes. Do not add new facts or sources.`,
        user: `<text>\n${p.text}\n</text>`,
      }).catch(wrapAi);
      const quotes = quotedSegments(p.text);
      const changedQuotes = quotes.filter((q) => !res.data.text.includes(q));
      return { mode: p.mode, text: res.data.text, changes: res.data.changes.slice(0, 30), quotesKept: quotes.length - changedQuotes.length, quotesChanged: changedQuotes };
    }
    case "rubric": {
      const ai = aiRequired(deps);
      const Schema = z.object({ criteria: z.array(z.object({ criterion: z.string(), status: z.enum(["met", "partly", "not_met"]), excerpt: z.string().nullable(), suggestion: z.string() })), overall: z.string() });
      const res = await ai.structured({
        task: "writing", tier: "fast", effort: "medium", schema: Schema, meta: { userId: user.id }, interactive: true,
        system: `Compare the student's text with the teacher's assessment criteria, in ${lang}. ${UNTRUSTED_DATA_RULES} For each criterion: met / partly / not_met, a short verbatim excerpt from the student's text as evidence (or null), and one concrete suggestion. Do not give a grade and do not promise one.`,
        user: `<criteria>\n${p.rubric}\n</criteria>\n<text>\n${p.text}\n</text>`,
      }).catch(wrapAi);
      // an excerpt the student did not write is dropped, not shown as evidence
      const criteria = res.data.criteria.map((c) => ({ ...c, excerpt: c.excerpt && p.text.includes(c.excerpt.trim()) ? c.excerpt.trim() : null }));
      return { mode: p.mode, criteria, overall: res.data.overall };
    }
  }
}
