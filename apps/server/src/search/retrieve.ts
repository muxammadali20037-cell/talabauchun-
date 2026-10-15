import type { Deps } from "../deps";
import type { Locator } from "@talaba/shared";

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  documentTitle: string;
  text: string;
  locator: Locator & { section?: number };
  pageStart: number;
  score: number;
};

const UZ_SUFFIXES = [
  "larimizdan", "laringizdan", "lardagi", "laridan", "larning", "larini", "lariga", "larida", "larimiz", "lardan", "larga", "larda", "larni",
  "ining", "idagi", "lari", "lari", "ning", "dagi", "dan", "dir", "lar", "ga", "ka", "qa", "da", "ni", "gi", "si", "im", "ing", "i",
];
const RU_SUFFIXES = ["ами", "ями", "ого", "его", "ому", "ему", "ыми", "ими", "ая", "яя", "ое", "ее", "ой", "ей", "ий", "ый", "ов", "ев", "ах", "ях", "ам", "ям", "ы", "и", "а", "я", "е", "у", "ю", "о"];
const STOP = new Set(["va", "bu", "u", "bilan", "uchun", "qanday", "nima", "nechta", "qaysi", "kim", "the", "and", "what", "which", "is", "of", "in", "a", "an", "и", "в", "на", "что", "как", "это", "какой", "какая", "ham", "esa", "deb", "yoki"]);

/** Light suffix stripping so "kitoblarimizdan" matches "kitob" with a prefix query. Not a full stemmer. */
export function stemToken(token: string): string {
  const t = token.toLowerCase().replace(/[ʻʼ'`‘’]/g, "");
  if (t.length <= 4) return t;
  const list = /[а-яё]/.test(t) ? RU_SUFFIXES : UZ_SUFFIXES;
  for (const s of list) {
    if (t.endsWith(s) && t.length - s.length >= 4) return t.slice(0, t.length - s.length);
  }
  return t;
}

export function queryTokens(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[\p{L}\p{N}ʻʼ'‘’]+/gu) ?? []).filter((t) => t.length >= 2 && !STOP.has(t)).map(stemToken))].slice(0, 16);
}

function toTsQuery(tokens: string[]): string | null {
  const safe = tokens.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter((t) => t.length >= 2);
  if (!safe.length) return null;
  return safe.map((t) => `${t}:*`).join(" | ");
}

export type RetrieveOptions = {
  query: string;
  userId: string;
  documentIds?: string[];
  pageRanges?: { documentId: string; from: number; to: number }[];
  sectionIds?: string[];
  limit?: number;
};

/**
 * Hybrid retrieval over chunks the user may read: full-text (prefix tsquery),
 * trigram word similarity and — when an embedder is configured — vector
 * similarity, fused with reciprocal rank fusion. Authorization is part of the
 * SQL (workspace membership), not a post-filter.
 */
export async function retrieve(deps: Deps, o: RetrieveOptions): Promise<RetrievedChunk[]> {
  const limit = Math.min(o.limit ?? 8, 50);
  const tokens = queryTokens(o.query);
  const tsq = toTsQuery(tokens);
  const docFilter = o.documentIds?.length ? o.documentIds : null;
  const sectionFilter = o.sectionIds?.length ? o.sectionIds : null;
  const ranges = o.pageRanges?.length ? JSON.stringify(o.pageRanges) : null;
  let vector: string | null = null;
  if (deps.embedder && o.query.trim()) {
    try {
      const [v] = await deps.embedder.embed([o.query], "query");
      vector = v ? JSON.stringify(v) : null;
    } catch {
      vector = null; // degrade to lexical search
    }
  }
  const rows = await deps.sql<(Omit<RetrievedChunk, "score" | "locator"> & { locator: RetrievedChunk["locator"]; score: number })[]>`
    with allowed as (
      select c.id, c.text, c.tsv, c.embedding, c.locator, c.page_start, d.id as document_id, v.id as version_id, d.title
      from chunks c
      join document_versions v on v.id = c.document_version_id
      join documents d on d.id = v.document_id and d.current_version_id = v.id
      where d.deleted_at is null
        and d.workspace_id in (select workspace_id from memberships where user_id = ${o.userId})
        and (${docFilter}::uuid[] is null or d.id = any(${docFilter}::uuid[]))
        and (${sectionFilter}::uuid[] is null or c.section_id = any(${sectionFilter}::uuid[]))
        and (${ranges}::jsonb is null or exists (
          select 1 from jsonb_to_recordset(${ranges}::jsonb) as r("documentId" uuid, "from" int, "to" int)
          where r."documentId" = d.id and c.page_start between r."from" and r."to"))
    ),
    fts as (
      select id, row_number() over (order by ts_rank_cd(tsv, q) desc) as rk
      from allowed, to_tsquery('simple', coalesce(${tsq}, '')) q
      where ${tsq}::text is not null and tsv @@ q
      order by ts_rank_cd(tsv, q) desc limit 50
    ),
    trg as (
      select id, row_number() over (order by word_similarity(${o.query}, text) desc) as rk
      from allowed where ${o.query} <% text
      order by word_similarity(${o.query}, text) desc limit 50
    ),
    vec as (
      select id, row_number() over (order by embedding <=> ${vector}::vector) as rk
      from allowed where ${vector}::text is not null and embedding is not null
      order by embedding <=> ${vector}::vector limit 50
    ),
    fused as (
      select id, sum(1.0 / (60 + rk)) as score from (
        select id, rk from fts union all select id, rk from trg union all select id, rk from vec
      ) s group by id
    )
    select a.id as "chunkId", a.document_id as "documentId", a.version_id as "documentVersionId", a.title as "documentTitle",
           a.text, a.locator, a.page_start as "pageStart", f.score::float as score
    from fused f join allowed a on a.id = f.id
    order by f.score desc limit ${limit}`;
  return rows;
}

/** Ordered chunks of the selected pages/sections (for generation over a chapter rather than a query). */
export async function chunksForScope(deps: Deps, o: Omit<RetrieveOptions, "query"> & { maxChunks?: number }): Promise<RetrievedChunk[]> {
  const docFilter = o.documentIds?.length ? o.documentIds : null;
  const sectionFilter = o.sectionIds?.length ? o.sectionIds : null;
  const ranges = o.pageRanges?.length ? JSON.stringify(o.pageRanges) : null;
  return deps.sql<RetrievedChunk[]>`
    select c.id as "chunkId", d.id as "documentId", v.id as "documentVersionId", d.title as "documentTitle",
           c.text, c.locator, c.page_start as "pageStart", 0::float as score
    from chunks c
    join document_versions v on v.id = c.document_version_id
    join documents d on d.id = v.document_id and d.current_version_id = v.id
    where d.deleted_at is null
      and d.workspace_id in (select workspace_id from memberships where user_id = ${o.userId})
      and (${docFilter}::uuid[] is null or d.id = any(${docFilter}::uuid[]))
      and (${sectionFilter}::uuid[] is null or c.section_id = any(${sectionFilter}::uuid[]))
      and (${ranges}::jsonb is null or exists (
        select 1 from jsonb_to_recordset(${ranges}::jsonb) as r("documentId" uuid, "from" int, "to" int)
        where r."documentId" = d.id and c.page_start between r."from" and r."to"))
    order by d.created_at, c.ord
    limit ${o.maxChunks ?? 400}`;
}

/** Human-readable location; never invents a page for sources without pages. */
export function describeLocator(loc: Partial<Locator> & { section?: number }, lang: "uz" | "uz-Cyrl" | "ru" | "en" = "uz"): string {
  const L = {
    uz: { page: "sahifa", printed: "kitobda", slide: "slayd", section: "boʻlim", sheet: "varaq" },
    "uz-Cyrl": { page: "саҳифа", printed: "китобда", slide: "слайд", section: "бўлим", sheet: "варақ" },
    ru: { page: "стр.", printed: "в книге", slide: "слайд", section: "раздел", sheet: "лист" },
    en: { page: "page", printed: "printed", slide: "slide", section: "section", sheet: "sheet" },
  }[lang];
  if (loc.pageIndex != null) {
    const printed = loc.pageLabel && loc.pageLabel !== String(loc.pageIndex) ? ` (${L.printed}: ${loc.pageLabel})` : "";
    return `${L.page} ${loc.pageIndex}${printed}`;
  }
  if (loc.slide != null) return `${L.slide} ${loc.slide}`;
  if (loc.sheet) return `${L.sheet} “${loc.sheet}”${loc.row != null ? `, ${loc.row}` : ""}`;
  const parts: string[] = [];
  if (loc.heading) parts.push(`“${loc.heading}”`);
  if (loc.section != null) parts.push(`${L.section} ${loc.section}`);
  return parts.join(", ") || "—";
}
