import { getDocument, InvalidPDFException, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ocrPdfPage } from "./ocr";
import { cleanText, ExtractError, letterCount, reflowLines, type ExtractedPage, type ExtractedSection, type ExtractResult } from "./types";

export type PdfOptions = {
  maxPages: number;
  ocr: { enabled: boolean; pdftoppm: string; tesseract: string; langs: string };
  /** pages already processed in an earlier attempt (resume after restart) */
  skipPages?: Set<number>;
  onPage?: (page: ExtractedPage) => Promise<void>;
  shouldStop?: () => Promise<void>;
};

const MIN_TEXT_LETTERS = 40;
const CHAPTER_RE = /^\s*((\d+|[IVXLC]+)[\s.-]*(bob|боб|bo[ʻ'‘`]?lim|бўлим|mavzu|мавзу|глава|раздел|тема|chapter|part)\b.*|(bob|боб|глава|chapter|mavzu|тема)\s+(\d+|[IVXLC]+)\b.*)$/iu;

type TextItem = { str: string; hasEOL?: boolean };

export async function extractPdf(data: Buffer, pdfPathForOcr: string, opts: PdfOptions): Promise<ExtractResult> {
  let doc;
  const task = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    if (e instanceof PasswordException || (e as { name?: string })?.name === "PasswordException") throw new ExtractError("password_protected");
    if (e instanceof InvalidPDFException || (e as { name?: string })?.name === "InvalidPDFException") throw new ExtractError("corrupted");
    throw new ExtractError("corrupted", e instanceof Error ? e.message : String(e));
  }
  try {
    const pageCount = doc.numPages;
    if (pageCount > opts.maxPages) throw new ExtractError("too_large", `${pageCount} pages`);
    const labels = await doc.getPageLabels().catch(() => null);
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;

    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= pageCount; i++) {
      if (opts.skipPages?.has(i)) continue;
      await opts.shouldStop?.();
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const raw = (content.items as TextItem[]).map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("");
      let text = reflowLines(cleanText(raw));
      const label = labels?.[i - 1] ?? null;
      let result: ExtractedPage;
      if (letterCount(text) >= MIN_TEXT_LETTERS) {
        result = { pageIndex: i, pageLabel: label, kind: "pdf_page", text, method: "text", status: "ok" };
      } else if (opts.ocr.enabled) {
        try {
          const ocr = await ocrPdfPage(pdfPathForOcr, i, { pdftoppm: opts.ocr.pdftoppm, tesseract: opts.ocr.tesseract, langs: opts.ocr.langs });
          const ocrText = reflowLines(cleanText(ocr.text));
          if (ocr.words === 0 || letterCount(ocrText) === 0) {
            result = { pageIndex: i, pageLabel: label, kind: "pdf_page", text, method: text ? "text" : "none", status: text ? "ok" : "empty" };
          } else {
            text = letterCount(ocrText) > letterCount(text) ? ocrText : text;
            const status = ocr.confidence >= 60 ? "ok" : ocr.confidence >= 35 ? "low_confidence" : "failed";
            result = { pageIndex: i, pageLabel: label, kind: "pdf_page", text, method: "ocr", ocrConfidence: Math.round(ocr.confidence * 10) / 10, status };
          }
        } catch (e) {
          result = { pageIndex: i, pageLabel: label, kind: "pdf_page", text, method: "none", status: "failed", error: "ocr_error" };
        }
      } else {
        result = { pageIndex: i, pageLabel: label, kind: "pdf_page", text, method: "text", status: text ? "low_confidence" : "failed", error: "ocr_disabled" };
      }
      page.cleanup();
      pages.push(result);
      await opts.onPage?.(result);
    }

    // Chapters: the PDF outline plus chapter-like headings at the top of a page
    // (some exporters omit top-level headings from bookmarks). Levels follow
    // the numbering ("2." / "2-bob" → 1, "2.3." → 2) when present.
    const flat: { title: string; level: number; page: number }[] = [];
    const outline = await doc.getOutline().catch(() => null);
    if (outline?.length) {
      const walk = async (items: typeof outline, level: number) => {
        for (const item of items) {
          let pageNo: number | null = null;
          try {
            const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
            if (Array.isArray(dest) && dest[0]) {
              const ref = dest[0] as { num: number; gen: number } | number;
              pageNo = typeof ref === "number" ? ref + 1 : (await doc.getPageIndex(ref as never)) + 1;
            }
          } catch {
            pageNo = null;
          }
          if (pageNo && item.title?.trim()) flat.push({ title: item.title.trim(), level: numberingLevel(item.title) ?? level, page: pageNo });
          if (level < 3 && item.items?.length) await walk(item.items, level + 1);
        }
      };
      await walk(outline, 1);
    }
    for (const p of pages) {
      const first = p.text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
      if (first.length <= 120 && CHAPTER_RE.test(first) && !flat.some((f) => f.page === p.pageIndex && f.title === first)) {
        flat.push({ title: first, level: 1, page: p.pageIndex });
      }
    }
    const sections = toSections(flat, pageCount);

    const title = typeof info.Title === "string" && info.Title.trim() ? info.Title.trim() : null;
    const author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : null;
    return {
      pages,
      sections,
      pageCount,
      title,
      author,
      metadata: { hasPageLabels: !!labels, outline: !!outline?.length, producer: info.Producer ?? null },
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** "2." / "2-bob" → 1, "2.3." → 2, "2.3.1" → 3; null when the title is not numbered. */
export function numberingLevel(title: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)*)\.?[\s-]/.exec(title);
  if (!m) return null;
  return m[1]!.split(".").length;
}

function toSections(flat: { title: string; level: number; page: number }[], pageCount: number): ExtractedSection[] {
  const sorted = [...flat].sort((a, b) => a.page - b.page || a.level - b.level);
  return sorted.map((s, idx) => {
    const next = sorted.slice(idx + 1).find((n) => n.level <= s.level && n.page > s.page);
    return { title: s.title.slice(0, 300), level: s.level, startPage: s.page, endPage: next ? Math.max(s.page, next.page - 1) : pageCount };
  });
}
