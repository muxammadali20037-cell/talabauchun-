export type PageKind = "pdf_page" | "slide" | "section" | "image" | "sheet" | "web" | "text";
export type PageStatus = "ok" | "low_confidence" | "failed" | "empty";

export type ExtractedPage = {
  pageIndex: number;
  pageLabel?: string | null;
  kind: PageKind;
  heading?: string | null;
  text: string;
  method: "text" | "ocr" | "none";
  ocrConfidence?: number | null;
  status: PageStatus;
  error?: string | null;
  /** paragraph number of the first paragraph on this unit (DOCX / web / text) */
  firstParagraph?: number;
};

export type ExtractedSection = { title: string; level: number; startPage: number; endPage: number };

export type TableData = { sheet: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean };

export type ExtractResult = {
  pages: ExtractedPage[];
  sections: ExtractedSection[];
  pageCount: number;
  metadata: Record<string, unknown>;
  tables?: TableData[];
  title?: string | null;
  author?: string | null;
  publishedInfo?: string | null;
};

export class ExtractError extends Error {
  constructor(public readonly code: "password_protected" | "corrupted" | "unsupported" | "too_large" | "empty" | "fetch_failed" | "blocked_url", message?: string) {
    super(message ?? code);
  }
}

/** Collapse whitespace while keeping paragraph breaks. */
export function cleanText(s: string): string {
  return s
    .replace(/\u0000/g, "")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function letterCount(s: string): number {
  const m = s.match(/\p{L}/gu);
  return m ? m.length : 0;
}

/**
 * PDF text layers and OCR break lines where the page wraps, which splits
 * sentences. Joins a line with the next when the previous line does not end a
 * sentence and the next one starts in lower case; "iqti-\nsodiyot" loses the hyphen.
 * Headings and paragraph starts (capital letter after a finished line) stay separate.
 */
export function reflowLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const prev = out[out.length - 1];
    if (prev !== undefined && prev !== "" && line !== "" && !/[.!?:;…»”"]$/u.test(prev) && (/^[\p{Ll}(«"„]/u.test(line) || /^\d+(?:[.,]\d+)?(?:-|\s+)\p{Ll}/u.test(line))) {
      out[out.length - 1] = /\p{L}-$/u.test(prev) && /^\p{Ll}/u.test(line) ? prev.slice(0, -1) + line : `${prev} ${line}`;
    } else out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
