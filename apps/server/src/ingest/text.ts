import { groupIntoSections } from "./docx";
import { cleanText, ExtractError, type ExtractResult } from "./types";

const MD_HEADING = /^(#{1,3})\s+(.{1,200})$/;
const CHAPTER = /^((\d+|[IVXLC]+)[\s.-]*(bob|боб|bo[ʻ'‘`]?lim|бўлим|mavzu|мавзу|глава|раздел|тема|chapter)\b.{0,150}|(bob|боб|глава|chapter|mavzu|тема)\s+(\d+|[IVXLC]+)\b.{0,150})$/iu;

/** Plain text / pasted text: paragraphs separated by blank lines; headings detected conservatively. */
export function extractPlainText(raw: string): ExtractResult {
  const text = cleanText(raw.replace(/\r\n?/g, "\n"));
  if (!text) throw new ExtractError("empty");
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  let n = 0;
  const paras = blocks.map((b) => {
    n++;
    const md = MD_HEADING.exec(b);
    if (md) return { text: md[2]!.trim(), level: md[1]!.length, n };
    if (!b.includes("\n") && CHAPTER.test(b)) return { text: b, level: 1, n };
    return { text: b, level: null, n };
  });
  return groupIntoSections(paras, "text", {}, null, null);
}

/** Decodes a text upload (UTF-8 with BOM handling; falls back to windows-1251 for legacy Cyrillic files). */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 10 && bad / Math.max(1, utf8.length) > 0.01) {
    try {
      return new TextDecoder("windows-1251").decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}
