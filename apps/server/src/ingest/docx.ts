import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { cleanText, ExtractError, type ExtractedPage, type ExtractedSection, type ExtractResult } from "./types";

const MAX_XML_BYTES = 30 * 1024 * 1024;
const MAX_ENTRIES = 5000;

type Node = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", preserveOrder: true, trimValues: false, processEntities: true });

export async function openZip(data: Buffer): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: false });
  } catch {
    throw new ExtractError("corrupted");
  }
  if (Object.keys(zip.files).length > MAX_ENTRIES) throw new ExtractError("corrupted", "too many zip entries");
  return zip;
}

export async function readZipText(zip: JSZip, name: string): Promise<string | null> {
  const f = zip.file(name);
  if (!f) return null;
  // Guard against zip bombs: stop inflating past the limit.
  const declared = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  if (declared > MAX_XML_BYTES) throw new ExtractError("too_large", `${name} too large`);
  const text = await f.async("string");
  if (text.length > MAX_XML_BYTES) throw new ExtractError("too_large", `${name} too large`);
  return text;
}

/** Collects text of w:t / a:t descendants in document order (preserveOrder tree). */
export function collectText(nodes: Node[], textTag: string, out: string[] = []): string[] {
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n)) {
      if (k === ":@") continue;
      if (k === "#text") continue;
      if (k === textTag && Array.isArray(v)) {
        for (const t of v as Node[]) if (typeof t["#text"] !== "undefined") out.push(String(t["#text"]));
      } else if (k === "w:tab") out.push("\t");
      else if (k === "w:br" || k === "a:br") out.push("\n");
      else if (Array.isArray(v)) collectText(v as Node[], textTag, out);
    }
  }
  return out;
}

function attr(node: Node, name: string): string | undefined {
  const a = node[":@"] as Record<string, string> | undefined;
  return a?.[name];
}

function findChild(children: Node[] | undefined, tag: string): Node | undefined {
  return children?.find((c) => tag in c);
}

function headingLevel(p: Node): number | null {
  const pPr = findChild(p["w:p"] as Node[], "w:pPr");
  const style = pPr ? findChild(pPr["w:pPr"] as Node[], "w:pStyle") : undefined;
  const val = style ? attr(style, "@w:val") ?? "" : "";
  const m = /^(?:heading|Heading|Заголовок)\s?(\d)$/.exec(val) || /^(\d)$/.exec(val);
  if (m) return Number(m[1]);
  if (/^Title$/i.test(val)) return 1;
  const outline = pPr ? findChild(pPr["w:pPr"] as Node[], "w:outlineLvl") : undefined;
  if (outline) return Number(attr(outline, "@w:val") ?? 0) + 1;
  return null;
}

/**
 * DOCX has no stable pages, so units are heading-delimited sections with
 * paragraph numbers; no page numbers are invented. Macros (vbaProject.bin) are
 * never executed — only document XML is read.
 */
export async function extractDocx(data: Buffer): Promise<ExtractResult> {
  const zip = await openZip(data);
  const xml = await readZipText(zip, "word/document.xml");
  if (!xml) throw new ExtractError("corrupted", "word/document.xml missing");
  const hasMacros = !!zip.file("word/vbaProject.bin");
  const tree = parser.parse(xml) as Node[];
  const docNode = tree.find((n) => "w:document" in n);
  const bodyNode = findChild(docNode?.["w:document"] as Node[], "w:body");
  const body = (bodyNode?.["w:body"] as Node[]) ?? [];

  type Para = { text: string; level: number | null; n: number };
  const paras: Para[] = [];
  let n = 0;
  for (const el of body) {
    if ("w:p" in el) {
      const text = cleanText(collectText(el["w:p"] as Node[], "w:t").join(""));
      if (!text) continue;
      n++;
      paras.push({ text, level: headingLevel(el), n });
    } else if ("w:tbl" in el) {
      const rows = ((el["w:tbl"] as Node[]) ?? []).filter((r) => "w:tr" in r);
      for (const r of rows) {
        const cells = ((r["w:tr"] as Node[]) ?? []).filter((c) => "w:tc" in c).map((c) => cleanText(collectText(c["w:tc"] as Node[], "w:t").join(" ")));
        const line = cells.join(" | ").trim();
        if (line.replace(/[|\s]/g, "")) {
          n++;
          paras.push({ text: line, level: null, n });
        }
      }
    }
  }
  if (!paras.length) throw new ExtractError("empty");

  const core = await readZipText(zip, "docProps/core.xml");
  const title = core ? /<dc:title>([^<]+)<\/dc:title>/.exec(core)?.[1]?.trim() ?? null : null;
  const author = core ? /<dc:creator>([^<]+)<\/dc:creator>/.exec(core)?.[1]?.trim() ?? null : null;

  return groupIntoSections(paras, "section", { hasMacros, macrosExecuted: false }, title, author);
}

/** Shared by DOCX, TXT and web pages: heading-delimited units capped in size. */
export function groupIntoSections(
  paras: { text: string; level: number | null; n: number }[],
  kind: "section" | "web" | "text",
  metadata: Record<string, unknown>,
  title: string | null,
  author: string | null,
  maxChars = 6000,
): ExtractResult {
  const pages: ExtractedPage[] = [];
  const sections: ExtractedSection[] = [];
  let current: { heading: string | null; lines: string[]; first: number } | null = null;
  let currentHeading: string | null = null;
  const flush = () => {
    if (current && current.lines.length) {
      pages.push({
        pageIndex: pages.length + 1,
        kind,
        heading: current.heading,
        text: current.lines.join("\n\n"),
        method: "text",
        status: "ok",
        firstParagraph: current.first,
      });
    }
    current = null;
  };
  for (const p of paras) {
    if (p.level !== null && p.level <= 3 && p.text.length <= 200) {
      flush();
      currentHeading = p.text;
      sections.push({ title: p.text, level: p.level, startPage: pages.length + 1, endPage: pages.length + 1 });
      current = { heading: currentHeading, lines: [p.text], first: p.n };
      continue;
    }
    if (!current) current = { heading: currentHeading, lines: [], first: p.n };
    const size = current.lines.reduce((s, l) => s + l.length, 0);
    if (size + p.text.length > maxChars && current.lines.length) {
      flush();
      current = { heading: currentHeading, lines: [], first: p.n };
    }
    current.lines.push(p.text);
  }
  flush();
  // close section ranges
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]!;
    const next = sections.slice(i + 1).find((x) => x.level <= s.level);
    s.endPage = next ? Math.max(s.startPage, next.startPage - 1) : pages.length;
  }
  return { pages, sections, pageCount: pages.length, metadata, title, author };
}
