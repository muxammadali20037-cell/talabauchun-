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
