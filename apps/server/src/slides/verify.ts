import path from "node:path";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { SLIDE_H, SLIDE_W, type LaidOutElement, type LaidOutSlide } from "@talaba/shared";
import { run } from "./render-pdf";

/**
 * Post-render checks. An export is only marked ready when the file really
 * opens, has the expected number of slides/pages, keeps text as editable text
 * and charts as native charts, embeds the expected fonts and has no text
 * outside the page or outside the box the layout engine planned for it.
 */

export type Check = { name: string; ok: boolean; detail?: Record<string, unknown> };
export type CheckReport = { ok: boolean; checks: Check[] };

const SPECIAL = /[ʻʼ‘’ўқғҳЎҚҒҲ]/gu;

export function popplerBin(pdftoppmBin: string, tool: "pdfinfo" | "pdftotext" | "pdffonts"): string {
  return pdftoppmBin.includes("/") ? path.join(path.dirname(pdftoppmBin), tool) : tool;
}

function report(checks: Check[]): CheckReport {
  return { ok: checks.every((c) => c.ok), checks };
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&";
    if (k === "lt") return "<";
    if (k === "gt") return ">";
    if (k === "quot") return '"';
    if (k === "apos") return "'";
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(parseInt(k.slice(1), 10));
    return m;
  });
}

/** Lower-cased letters/digits only, apostrophe variants unified: renderers may differ in punctuation glyphs. */
export function normWord(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[ʻʼ‘’'`´]/g, "'").replace(/[^\p{L}\p{N}']/gu, "");
}

const elementText = (e: LaidOutElement): string =>
  e.kind === "text" ? e.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join(" ")
  : e.kind === "table" ? [...e.columns, ...e.rows.flat()].join(" ")
  : e.kind === "chart" ? [...e.categories, ...e.series.map((s) => s.name), ...e.series.flatMap((s) => s.values.map(String))].join(" ")
  : "";

// ───────────────────────── PPTX ─────────────────────────

export async function verifyPptx(buf: Buffer, laid: LaidOutSlide[]): Promise<CheckReport> {
  const checks: Check[] = [];
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    return report([{ name: "pptx_opens", ok: false, detail: { error: String(e).slice(0, 200) } }]);
  }
  const pres = await zip.file("ppt/presentation.xml")?.async("string");
  checks.push({ name: "pptx_opens", ok: !!pres });
  if (!pres) return report(checks);
  const slidePaths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const listed = (pres.match(/<p:sldId\b/g) ?? []).length;
  checks.push({ name: "pptx_slide_count", ok: slidePaths.length === laid.length && listed === laid.length, detail: { parts: slidePaths.length, listed, expected: laid.length } });

  const xmlErrors: string[] = [];
  const noText: number[] = [];
  const pictures: number[] = [];
  const badParagraphs: number[] = [];
  let charts = 0;
  let tables = 0;
  for (let i = 0; i < slidePaths.length; i++) {
    const xml = await zip.file(slidePaths[i]!)!.async("string");
    const v = XMLValidator.validate(xml);
    if (v !== true) xmlErrors.push(`${slidePaths[i]}: ${v.err.msg}`);
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]!)).filter((s) => s.trim());
    const expectsText = laid[i]?.elements.some((e) => e.kind === "text");
    if (expectsText && !texts.length) noText.push(i + 1);
    if (/<p:pic\b/.test(xml)) pictures.push(i + 1);
    for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) if ((p[1]!.match(/<a:pPr\b/g) ?? []).length > 1) badParagraphs.push(i + 1);
    charts += (xml.match(/<c:chart\b/g) ?? []).length;
    tables += (xml.match(/<a:tbl>/g) ?? []).length;
  }
  checks.push({ name: "pptx_xml_valid", ok: !xmlErrors.length && !badParagraphs.length, detail: xmlErrors.length || badParagraphs.length ? { xmlErrors: xmlErrors.slice(0, 5), badParagraphs: [...new Set(badParagraphs)] } : undefined });
  checks.push({ name: "pptx_text_editable", ok: !noText.length && !pictures.length, detail: noText.length || pictures.length ? { slidesWithoutText: noText, slidesWithPictures: pictures } : undefined });

  const expectedCharts = laid.flatMap((s) => s.elements).filter((e) => e.kind === "chart").length;
  const chartParts = Object.keys(zip.files).filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p));
  let seriesOk = true;
  for (const p of chartParts) {
    const xml = await zip.file(p)!.async("string");
    if (!/<c:ser>/.test(xml) || !/<c:numCache>/.test(xml)) seriesOk = false;
  }
  checks.push({ name: "pptx_charts_native", ok: charts === expectedCharts && chartParts.length === expectedCharts && seriesOk, detail: { charts, chartParts: chartParts.length, expected: expectedCharts } });
  const expectedTables = laid.flatMap((s) => s.elements).filter((e) => e.kind === "table").length;
  checks.push({ name: "pptx_tables_native", ok: tables === expectedTables, detail: { tables, expected: expectedTables } });
  return report(checks);
}

/** Series values and categories of every chart part, in order (for data checks). */
export async function pptxChartData(buf: Buffer): Promise<{ part: string; categories: string[]; series: { name: string; values: number[] }[] }[]> {
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.keys(zip.files).filter((p) => /^ppt\/charts\/chart\d+\.xml$/.test(p)).sort();
  const out = [];
  for (const part of parts) {
    const xml = await zip.file(part)!.async("string");
    const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((m) => {
      const ser = m[1]!;
      const name = decodeXml(/<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/.exec(ser)?.[1] ?? "");
      const val = /<c:val>([\s\S]*?)<\/c:val>/.exec(ser)?.[1] ?? "";
      const values = [...val.matchAll(/<c:pt idx="(\d+)">\s*<c:v>([^<]*)<\/c:v>/g)].sort((a, b) => Number(a[1]) - Number(b[1])).map((x) => Number(x[2]));
      const cat = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(ser)?.[1] ?? "";
      const categories = [...cat.matchAll(/<c:pt idx="(\d+)">\s*<c:v>([^<]*)<\/c:v>/g)].sort((a, b) => Number(a[1]) - Number(b[1])).map((x) => decodeXml(x[2]!));
      return { name, values, categories };
    });
    out.push({ part, categories: series[0]?.categories ?? [], series: series.map(({ name, values }) => ({ name, values })) });
  }
  return out;
}

/** All slide texts (a:t runs joined per paragraph), per slide in order. */
export async function pptxSlideTexts(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const paths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[] = [];
  for (const p of paths) {
    const xml = await zip.file(p)!.async("string");
    out.push([...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => [...m[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join("")).filter(Boolean).join("\n"));
  }
  return out;
}

// ───────────────────────── PDF ─────────────────────────

export type PdfWord = { text: string; xMin: number; yMin: number; xMax: number; yMax: number };
export type PdfPage = { width: number; height: number; words: PdfWord[] };

export async function pdfWords(pdfPath: string, pdftotext: string): Promise<PdfPage[]> {
  const { stdout } = await run(pdftotext, ["-bbox-layout", "-enc", "UTF-8", pdfPath, "-"], { timeoutMs: 60_000 });
  const pages: PdfPage[] = [];
  for (const pm of stdout.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    const words = [...pm[3]!.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)].map((w) => ({
      xMin: Number(w[1]), yMin: Number(w[2]), xMax: Number(w[3]), yMax: Number(w[4]), text: decodeXml(w[5]!),
    }));
    pages.push({ width: Number(pm[1]), height: Number(pm[2]), words });
  }
  return pages;
}

export async function verifyPdf(pdfPath: string, laid: LaidOutSlide[], bins: { pdftoppm: string }): Promise<CheckReport> {
  const checks: Check[] = [];
  const info = await run(popplerBin(bins.pdftoppm, "pdfinfo"), [pdfPath], { timeoutMs: 30_000 }).catch((e) => ({ stdout: "", stderr: String(e) }));
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+) pts/m.exec(info.stdout);
  checks.push({ name: "pdf_opens", ok: pages > 0 });
  if (!pages) return report(checks);
  checks.push({ name: "pdf_page_count", ok: pages === laid.length, detail: { pages, expected: laid.length } });
  const w = Number(size?.[1] ?? 0);
  const h = Number(size?.[2] ?? 0);
  checks.push({ name: "pdf_page_size_16x9", ok: Math.abs(w - SLIDE_W * 72) < 2 && Math.abs(h - SLIDE_H * 72) < 2, detail: { width: w, height: h } });

  // Fonts: every font embedded and one of the metric-compatible families (a fallback font means a missing glyph).
  const fonts = await run(popplerBin(bins.pdftoppm, "pdffonts"), [pdfPath], { timeoutMs: 30_000 }).catch(() => ({ stdout: "", stderr: "" }));
  const fontRows = fonts.stdout.split("\n").slice(2).filter((l) => l.trim());
  const fontNames = fontRows.map((l) => l.split(/\s+/)[0]!.replace(/^[A-Z]{6}\+/, ""));
  const notEmbedded = fontRows.filter((l) => !/\byes\s+yes\b/.test(l)).map((l) => l.split(/\s+/)[0]);
  const foreign = fontNames.filter((n) => !/^(LiberationSans|LiberationSerif|Arial|Times|OpenSymbol)/i.test(n));
  checks.push({ name: "pdf_fonts", ok: !notEmbedded.length && !foreign.length, detail: { fonts: [...new Set(fontNames)], notEmbedded, foreign } });

  const pdfPages = await pdfWords(pdfPath, popplerBin(bins.pdftoppm, "pdftotext"));
  const outOfPage: { page: number; word: string }[] = [];
  const outOfBox: { page: number; word: string; at: number[] }[] = [];
  const missingTitle: { page: number; words: string[] }[] = [];
  const missingChars: { page: number; char: string; expected: number; found: number }[] = [];
  const tolX = 4;
  const tolY = 4;
  pdfPages.forEach((pg, i) => {
    const slide = laid[i];
    if (!slide) return;
    const scale = pg.width / SLIDE_W;
    const boxes = slide.elements
      .filter((e) => e.kind !== "rect")
      .map((e) => ({ e, x0: e.x * scale - tolX, y0: e.y * scale - tolY, x1: (e.x + e.w) * scale + tolX, y1: (e.y + e.h) * scale + tolY, text: normWord(elementText(e)) }));
    for (const word of pg.words) {
      if (word.xMin < -1 || word.yMin < -1 || word.xMax > pg.width + 1 || word.yMax > pg.height + 1) outOfPage.push({ page: i + 1, word: word.text });
      const nw = normWord(word.text);
      if (!nw) continue;
      const inside = boxes.filter((b) => word.xMin >= b.x0 && word.xMax <= b.x1 && word.yMin >= b.y0 && word.yMax <= b.y1);
      // a word must sit inside a box that actually holds that text; charts may add their own axis labels
      const ok = inside.some((b) => b.e.kind === "chart" || b.text.includes(nw));
      if (!ok) outOfBox.push({ page: i + 1, word: word.text, at: [word.xMin, word.yMin, word.xMax, word.yMax].map((n) => Math.round(n)) });
    }
    const pageWords = new Set(pg.words.map((x) => normWord(x.text)));
    const pageText = pg.words.map((x) => x.text).join(" ");
    for (const e of slide.elements) {
      if (e.kind !== "text" || e.role !== "title") continue;
      const words = elementText(e).split(/\s+/).map(normWord).filter(Boolean);
      const miss = words.filter((x) => !pageWords.has(x) && ![...pageWords].some((p) => p.includes(x)));
      if (miss.length) missingTitle.push({ page: i + 1, words: miss });
    }
    const expected = slide.elements.filter((e) => e.kind === "text" || e.kind === "table").map(elementText).join(" ");
    const counts = (s: string) => {
      const m = new Map<string, number>();
      for (const ch of s.match(SPECIAL) ?? []) m.set(ch, (m.get(ch) ?? 0) + 1);
      return m;
    };
    const exp = counts(expected);
    const got = counts(pageText);
    for (const [ch, n] of exp) if ((got.get(ch) ?? 0) < n) missingChars.push({ page: i + 1, char: ch, expected: n, found: got.get(ch) ?? 0 });
  });
  checks.push({ name: "pdf_text_in_page", ok: !outOfPage.length, detail: outOfPage.length ? { words: outOfPage.slice(0, 10) } : undefined });
  checks.push({ name: "pdf_text_in_boxes", ok: !outOfBox.length, detail: outOfBox.length ? { words: outOfBox.slice(0, 10), total: outOfBox.length } : undefined });
  checks.push({ name: "pdf_titles_present", ok: !missingTitle.length, detail: missingTitle.length ? { missing: missingTitle.slice(0, 10) } : undefined });
  checks.push({ name: "pdf_special_chars", ok: !missingChars.length, detail: missingChars.length ? { missing: missingChars.slice(0, 10) } : undefined });
  return report(checks);
}

export function failedChecks(r: CheckReport): string[] {
  return r.checks.filter((c) => !c.ok).map((c) => c.name);
}
