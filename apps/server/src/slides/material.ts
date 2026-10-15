import type { Locator } from "@talaba/shared";
import type { Deps } from "../deps";
import { chunksForScope, describeLocator, type RetrievedChunk } from "../search/retrieve";
import { norm } from "../quiz/text";

/**
 * Source material for a deck, rebuilt from the stored page texts of the
 * selected documents. PDF text has hard line breaks inside sentences, so lines
 * are re-joined into paragraphs, headings are recovered (outline titles plus a
 * conservative heading heuristic) and paragraphs are split into whole
 * sentences, each keeping the locator of the page it came from.
 */

export type MDoc = {
  id: string;
  versionId: string;
  title: string;
  author: string | null;
  publishedInfo: string | null;
  sourceUrl: string | null;
  sourceKind: string;
  filename: string | null;
  pageCount: number | null;
  /** title from the file's own metadata (e.g. PDF Title), when present */
  embeddedTitle: string | null;
};

export type MSentence = {
  id: number;
  text: string;
  docId: string;
  versionId: string;
  docTitle: string;
  locator: Locator;
  page: number;
  blockId: number;
  /** index of the paragraph within its block (sentences of one paragraph belong together) */
  para: number;
};

export type MBlock = {
  id: number;
  docId: string;
  title: string | null;
  level: 1 | 2 | 3;
  /** true when the heading is in the document outline; false = heuristic or no heading */
  listed: boolean;
  /** id of the enclosing level-1 block (chapter), or null */
  chapterId: number | null;
  sentences: MSentence[];
  /** paragraphs as joined text (for definition finding) */
  paragraphs: { text: string; sentenceIds: number[] }[];
};

export type MTable = {
  docId: string;
  versionId: string;
  docTitle: string;
  filename: string | null;
  sheet: string;
  columns: string[];
  rows: (string | number | null)[][];
  truncated: boolean;
  locator: Locator;
};

export type Material = {
  docs: MDoc[];
  blocks: MBlock[];
  sentences: MSentence[];
  tables: MTable[];
  chunks: RetrievedChunk[];
};

export type Scope = {
  userId: string;
  documentIds: string[];
  pageRanges?: { documentId: string; from: number; to: number }[];
  sectionIds?: string[];
};

const key = (s: string) => norm(s).replace(/[^\p{L}\p{N}]/gu, "");

/** Splits joined paragraph text into sentences; decimals ("2.5") and initials stay intact. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…](?:["»”)])?)\s+(?=[\p{Lu}«"“(\d])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HEADING_RE = /^(?:\d+(?:\s?\.\s?\d+)*\.?\s+\S|\d+-bob\b|[IVXLC]+\.\s|bob\s+\d|глава\s+\d|chapter\s+\d|section\s+\d)/iu;

function looksLikeHeading(line: string, prev: string | null, next: string | null): boolean {
  const l = line.trim();
  if (!l || l.length > 90) return false;
  if (/[.,;:!?…]$/.test(l)) return false;
  const words = l.split(/\s+/);
  if (words.length > 9) return false;
  if (!/^[\p{Lu}\d«"“]/u.test(l)) return false;
  // mostly numbers (table cells) are not headings
  const letters = (l.match(/\p{L}/gu) ?? []).length;
  if (letters < 3 || letters < l.replace(/\s/g, "").length * 0.6) return false;
  if (HEADING_RE.test(l)) return true;
  const prevEnds = prev == null || /[.!?…:)»”"]$/.test(prev.trim());
  const nextStartsUpper = next == null || /^[\p{Lu}\d«"“]/u.test(next.trim());
  return prevEnds && nextStartsUpper && words.length <= 6;
}

function locatorFor(kind: string, page: { page_index: number; page_label: string | null; heading: string | null }, sourceUrl: string | null): Locator & { section?: number } {
  if (kind === "pdf_page") return { pageIndex: page.page_index, ...(page.page_label ? { pageLabel: page.page_label } : {}) };
  if (kind === "slide") return { slide: page.page_index };
  if (kind === "sheet") return { sheet: page.heading ?? undefined };
  if (kind === "image") return { pageIndex: 1 };
  return { section: page.page_index, ...(page.heading ? { heading: page.heading } : {}), ...(sourceUrl ? { url: sourceUrl } : {}) } as Locator & { section?: number };
}

export async function loadMaterial(deps: Deps, scope: Scope): Promise<Material> {
  if (!scope.documentIds.length) return { docs: [], blocks: [], sentences: [], tables: [], chunks: [] };
  // Authorization and scope (pages/sections) come from the shared retrieval query.
  const chunks = await chunksForScope(deps, { userId: scope.userId, documentIds: scope.documentIds, pageRanges: scope.pageRanges, sectionIds: scope.sectionIds, maxChunks: 3000 });
  const versionIds = [...new Set(chunks.map((c) => c.documentVersionId))];
  const docRows = versionIds.length
    ? await deps.sql<{ id: string; version_id: string; title: string; author: string | null; published_info: string | null; source_url: string | null; source_kind: string; original_filename: string | null; page_count: number | null; metadata: Record<string, unknown>; created_at: Date }[]>`
        select d.id, v.id as version_id, d.title, d.author, d.published_info, d.source_url, d.source_kind, v.original_filename, v.page_count, v.metadata, d.created_at
        from documents d join document_versions v on v.id = d.current_version_id
        where v.id in ${deps.sql(versionIds)} order by d.created_at`
    : [];
  // keep the order the student selected the documents in
  docRows.sort((a, b) => scope.documentIds.indexOf(a.id) - scope.documentIds.indexOf(b.id));
  const docs: MDoc[] = docRows.map((d) => ({
    id: d.id, versionId: d.version_id, title: d.title, author: d.author, publishedInfo: d.published_info, sourceUrl: d.source_url,
    sourceKind: d.source_kind, filename: d.original_filename, pageCount: d.page_count,
    embeddedTitle: typeof d.metadata?.title === "string" ? (d.metadata.title as string) : null,
  }));

  const tables: MTable[] = [];
  for (const d of docRows) {
    const t = (d.metadata?.tables ?? []) as { sheet: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean }[];
    for (const tb of Array.isArray(t) ? t : []) {
      if (!tb?.columns?.length || !tb.rows?.length) continue;
      tables.push({ docId: d.id, versionId: d.version_id, docTitle: d.title, filename: d.original_filename, sheet: tb.sheet, columns: tb.columns.map(String), rows: tb.rows, truncated: !!tb.truncated, locator: { sheet: tb.sheet } });
    }
  }

  const pagesInScope = new Map<string, Set<number>>();
  for (const c of chunks) {
    if (!pagesInScope.has(c.documentVersionId)) pagesInScope.set(c.documentVersionId, new Set());
    pagesInScope.get(c.documentVersionId)!.add(c.pageStart);
  }

  const blocks: MBlock[] = [];
  const sentences: MSentence[] = [];
  for (const d of docs) {
    if (d.sourceKind === "csv" || d.sourceKind === "xlsx") continue; // tables are handled as data, not prose
    const wanted = pagesInScope.get(d.versionId);
    if (!wanted?.size) continue;
    const pages = await deps.sql<{ page_index: number; page_label: string | null; kind: string; heading: string | null; text: string }[]>`
      select page_index, page_label, kind, heading, text from pages
      where document_version_id = ${d.versionId} and status in ('ok','low_confidence') and page_index in ${deps.sql([...wanted])}
      order by page_index`;
    const outline = await deps.sql<{ title: string; level: number }[]>`select title, level from sections where document_version_id = ${d.versionId} order by ord`;
    const outlineByKey = new Map(outline.map((s) => [key(s.title), Math.min(2, Math.max(1, s.level)) as 1 | 2]));
    const outlineTitle = new Map(outline.map((s) => [key(s.title), s.title]));

    let block: MBlock | null = null;
    let chapterId: number | null = null;
    const newBlock = (title: string | null, level: 1 | 2 | 3, listed: boolean): MBlock => {
      if (level === 1 && listed) chapterId = blocks.length;
      if (level === 3) chapterId = null; // an unlisted heading ends the current chapter (e.g. an appendix table)
      const b: MBlock = { id: blocks.length, docId: d.id, title, level, listed, chapterId: level === 1 && listed ? blocks.length : chapterId, sentences: [], paragraphs: [] };
      blocks.push(b);
      return b;
    };
    for (const p of pages) {
      const loc = locatorFor(p.kind, p, d.sourceUrl);
      // page-like sources without their own headings: a docx/html section heading starts a block
      if (p.kind === "section" && p.heading) {
        const lvl = outlineByKey.get(key(p.heading));
        block = newBlock(p.heading, lvl ?? 2, !!lvl);
      }
      const lines = p.text.split(/\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
      let paraLines: string[] = [];
      const flush = () => {
        if (!paraLines.length) return;
        const textJoined = paraLines.join(" ").replace(/(\p{L})- (\p{Ll})/gu, "$1$2");
        paraLines = [];
        if (!block) block = newBlock(null, 2, false);
        const ids: number[] = [];
        const paraIdx = block.paragraphs.length;
        for (const s of splitSentences(textJoined)) {
          const sent: MSentence = { id: sentences.length, text: s, docId: d.id, versionId: d.versionId, docTitle: d.title, locator: loc, page: p.page_index, blockId: block.id, para: paraIdx };
          sentences.push(sent);
          block.sentences.push(sent);
          ids.push(sent.id);
        }
        block.paragraphs.push({ text: textJoined, sentenceIds: ids });
      };
      // A line that ends a sentence and is clearly shorter than the page's full lines ends a paragraph.
      const fullLine = Math.max(40, ...lines.map((l) => l.length));
      lines.forEach((line, i) => {
        const k = key(line);
        const listedLevel = k.length >= 3 ? outlineByKey.get(k) : undefined;
        const heading = listedLevel ?? (looksLikeHeading(line, i > 0 ? lines[i - 1]! : null, lines[i + 1] ?? null) ? 3 : undefined);
        if (heading) {
          flush();
          block = newBlock(listedLevel ? (outlineTitle.get(k) ?? line) : line, heading, !!listedLevel);
          return;
        }
        paraLines.push(line);
        if (/[.!?…:]$/.test(line) && line.length < fullLine * 0.8) flush();
      });
      flush();
    }
  }
  return { docs, blocks, sentences, tables, chunks };
}

/** "iqtisodiyot, sahifa 3 (kitobda: 2)" — the short source label shown under a slide. */
export function sourceLabel(docTitle: string, locator: Locator, lang: "uz" | "uz-Cyrl" | "ru" | "en" = "uz"): string {
  const where = describeLocator(locator, lang);
  return where && where !== "—" ? `${docTitle}, ${where}` : docTitle;
}

/** Chapter blocks with their own sentences plus those of their sub-blocks. */
export function chapters(m: Material): { block: MBlock; sentences: MSentence[]; subs: MBlock[] }[] {
  const out: { block: MBlock; sentences: MSentence[]; subs: MBlock[] }[] = [];
  for (const b of m.blocks) {
    if (b.level === 1 && b.listed) out.push({ block: b, sentences: [...b.sentences], subs: [] });
    else if (b.chapterId != null && out.length && out[out.length - 1]!.block.id === b.chapterId) {
      const ch = out[out.length - 1]!;
      ch.subs.push(b);
      ch.sentences.push(...b.sentences);
    }
  }
  return out;
}
