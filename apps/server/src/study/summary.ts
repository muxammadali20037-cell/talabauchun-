import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole } from "../access/policy";
import { AiError, UNTRUSTED_DATA_RULES } from "../ai/client";
import { AppError } from "../lib/errors";
import { assertAiAssistQuota } from "../billing/plans";
import { describeLocator, type RetrievedChunk } from "../search/retrieve";
import { contentStems, locateQuote, splitKeep } from "../quiz/text";
import { capitalize, findDefinitions } from "../quiz/terms";

export type SummarySection = { title: string; where: string; points: { text: string; quote: string | null; verified: boolean; aiWritten: boolean }[]; terms: { term: string; definition: string }[] };

/**
 * Chapter summary. Extractive by default: the most informative sentences of
 * each section (term frequency within the document), quoted verbatim with
 * their location. With AI, points are rewritten concisely and each must cite a
 * verbatim quote that is checked against the chunk text.
 */
export async function summarizeDocument(deps: Deps, user: UserRow, documentId: string, opts: { useAi?: boolean; maxPerSection?: number } = {}) {
  await requireObjectRole(deps.sql, user, "document", documentId, "viewer");
  const [ver] = await deps.sql<{ id: string }[]>`select current_version_id as id from documents where id = ${documentId}`;
  const sections = await deps.sql<{ id: string; title: string; level: number; start_page: number; end_page: number }[]>`
    select id, title, level, start_page, end_page from sections where document_version_id = ${ver?.id ?? null} order by ord`;
  const chunks = await deps.sql<(RetrievedChunk & { section_id: string | null })[]>`
    select c.id as "chunkId", d.id as "documentId", c.document_version_id as "documentVersionId", d.title as "documentTitle", c.text, c.locator, c.page_start as "pageStart", 0::float as score, c.section_id
    from chunks c join documents d on d.current_version_id = c.document_version_id where d.id = ${documentId} order by c.ord limit 600`;
  const df = new Map<string, number>();
  for (const c of chunks) for (const s of new Set(contentStems(c.text))) df.set(s, (df.get(s) ?? 0) + 1);
  const top = sections.filter((s) => s.level === 1).length ? sections.filter((s) => s.level === 1) : sections;
  const groups = top.length
    ? top.map((s) => ({ title: s.title, chunks: chunks.filter((c) => c.pageStart >= s.start_page && c.pageStart <= s.end_page) }))
    : [{ title: "", chunks }];
  const defs = findDefinitions(chunks.map((c) => c.text));
  const out: SummarySection[] = [];
  for (const g of groups) {
    if (!g.chunks.length) continue;
    const scored: { s: string; score: number; chunk: (typeof g.chunks)[number] }[] = [];
    // chunks overlap, so the same sentence can appear twice
    const seen = new Set<string>();
    for (const c of g.chunks) {
      for (const s of splitKeep(c.text)) {
        if (s.length < 40 || s.length > 320) continue;
        const key = s.toLowerCase().replace(/\s+/g, " ").trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const st = contentStems(s);
        const score = st.reduce((acc, t) => acc + Math.log(1 + (df.get(t) ?? 0)), 0) / Math.sqrt(st.length || 1) + (/\d/.test(s) ? 0.5 : 0) + (/[—–-]\s*bu\b|deb ataladi/i.test(s) ? 1 : 0);
        scored.push({ s, score, chunk: c });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, opts.maxPerSection ?? 4).sort((a, b) => g.chunks.indexOf(a.chunk) - g.chunks.indexOf(b.chunk));
    const first = g.chunks[0]!;
    out.push({
      title: g.title,
      where: describeLocator(first.locator, user.language),
      points: picked.map((p) => ({ text: p.s, quote: p.s, verified: true, aiWritten: false })),
      terms: defs.filter((d) => g.chunks.some((c) => c.text.includes(d.sentence))).map((d) => ({ term: capitalize(d.term), definition: d.definition })),
    });
  }
  if (opts.useAi && deps.ai && out.length) {
    const Schema = z.object({ sections: z.array(z.object({ index: z.number(), points: z.array(z.object({ text: z.string(), quote: z.string() })) })) });
    const blocks = out.map((s, i) => `<section index="${i}" title="${s.title.replace(/"/g, "")}">\n<source>\n${s.points.map((p) => p.quote).join("\n")}\n</source>\n</section>`).join("\n");
    await assertAiAssistQuota(deps.sql, user.id);
    const res = await deps.ai.structured({
      task: "tutor",
      tier: "fast",
      interactive: true,
      system: `You condense study material into short bullet points for students, in ${user.language === "ru" ? "Russian" : user.language === "en" ? "English" : "Uzbek"}. ${UNTRUSTED_DATA_RULES} Each point must include a verbatim quote from its section's <source> that supports it.`,
      user: blocks,
      schema: Schema,
      effort: "low",
      meta: { userId: user.id },
    }).catch((e) => {
      if (e instanceof AiError) throw new AppError(`ai_${e.code}`, e.retryable ? 503 : 502);
      throw e;
    });
    for (const sec of res.data.sections) {
      const target = out[sec.index];
      if (!target) continue;
      const sourceText = target.points.map((p) => p.quote).join("\n");
      target.points = sec.points.map((p) => {
        const found = locateQuote(p.quote, sourceText);
        return { text: p.text, quote: found?.quote ?? null, verified: !!found, aiWritten: true };
      });
    }
  }
  return { documentId, sections: out };
}
