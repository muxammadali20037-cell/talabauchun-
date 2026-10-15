import { BULLET_INDENT_PT, SLIDE_H, SLIDE_W, type LaidOutElement, type LaidOutSlide, type SlideContent, type TextParagraph, type TextRun } from "@talaba/shared";
import { labels } from "./labels";
import { clampLines, lineHeight, measureParagraphs, textWidth, wrapText, WIDTH_SAFETY, type MeasuredParagraph } from "./measure";
import type { Theme } from "./themes";

/**
 * Layout engine: turns slide content into absolutely positioned elements
 * (inches on a 13.333 × 7.5 slide). The Mini App preview and the PPTX
 * renderer both draw exactly these elements, so what the student sees is what
 * gets exported. Text is measured with real font metrics; when content does
 * not fit at the minimum body size the slide is split into continuation
 * slides ("(davomi)") instead of shrinking text further.
 */

export type LayoutInput = { id: string; content: SlideContent; notes?: string };
export type LayoutOptions = { language?: string; slideNumbers?: boolean };

export { BULLET_INDENT_PT };
const BULLET_IN = BULLET_INDENT_PT / 72;

const MX = 0.75; // side margin
const TOP = 0.5;
const CONTENT_W = SLIDE_W - 2 * MX;
const BOTTOM = 0.38; // distance from the slide edge to the footer baseline area
const GAP = 0.3; // standard gap between blocks
const BODY_SPACING = 1.08;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** Radius large enough to be capped at half the side: a square becomes a circle. */
const CIRCLE = 99;

type TextEl = Extract<LaidOutElement, { kind: "text" }>;

function text(
  t: Theme,
  o: Omit<TextEl, "kind" | "fontFace" | "align" | "valign" | "lineSpacing" | "color"> & Partial<Pick<TextEl, "fontFace" | "align" | "valign" | "lineSpacing" | "color">>,
): TextEl {
  return {
    kind: "text",
    fontFace: o.fontFace ?? t.fonts.body,
    align: o.align ?? "left",
    valign: o.valign ?? "top",
    lineSpacing: o.lineSpacing ?? 1,
    color: o.color ?? t.colors.text,
    ...o,
    x: r3(o.x),
    y: r3(o.y),
    w: r3(o.w),
    h: r3(o.h),
  };
}

/** `radius` is in inches; it is capped at half the shorter side (a square with that radius is a circle). */
function rect(x: number, y: number, w: number, h: number, fill: string, extra: { radius?: number; line?: string } = {}): LaidOutElement {
  const radius = extra.radius != null ? r3(Math.min(extra.radius, Math.min(w, h) / 2)) : undefined;
  return { kind: "rect", x: r3(x), y: r3(y), w: r3(w), h: r3(h), fill, ...(radius ? { radius } : {}), ...(extra.line ? { line: extra.line } : {}) };
}

const para = (s: string, o: Partial<TextParagraph> & { bold?: boolean; color?: string } = {}): TextParagraph => ({
  runs: [{ text: s, ...(o.bold ? { bold: true } : {}), ...(o.color ? { color: o.color } : {}) }],
  ...(o.bullet ? { bullet: true } : {}),
  ...(o.level ? { level: o.level } : {}),
  ...(o.spaceBeforePt ? { spaceBeforePt: o.spaceBeforePt } : {}),
});

const paraText = (p: TextParagraph) => p.runs.map((r) => r.text).join("");

/** Paragraph spacing used for bullet lists at a given size. */
function bulletSpace(size: number, level: 0 | 1 | undefined) {
  return Math.round(size * (level ? 0.25 : 0.5));
}

function measureBody(paras: TextParagraph[], face: string, size: number, boxW: number, spacing = BODY_SPACING): number {
  const m: MeasuredParagraph[] = paras.map((p, i) => ({
    text: paraText(p),
    face,
    sizePt: size,
    bold: p.runs.some((r) => r.bold),
    indent: p.bullet ? BULLET_IN * ((p.level ?? 0) + 1) : 0,
    spaceBeforePt: i > 0 ? (p.spaceBeforePt ?? 0) : 0,
  }));
  return measureParagraphs(m, boxW, spacing).height;
}

function withSizes(paras: TextParagraph[], size: number): TextParagraph[] {
  return paras.map((p, i) => ({ ...p, ...(i > 0 && p.bullet ? { spaceBeforePt: bulletSpace(size, p.level) } : {}) }));
}

// ───────────────────────── common chrome ─────────────────────────

type Frame = { elements: LaidOutElement[]; contentTop: number; contentBottom: number; warnings: string[] };

function sourceLine(content: SlideContent, lang: string | undefined): string {
  const L = labels(lang);
  const src = content.sources ?? [];
  if (!src.length) return "";
  if (src.length === 1) return `${L.source}: ${src[0]!.label}`;
  return `${L.sources}: ${src.map((s, i) => `[${i + 1}] ${s.label}`).join("; ")}`;
}

/** Title (+ optional kicker) at the top and source/number footer at the bottom of a content slide. */
function contentFrame(t: Theme, content: SlideContent, title: string, pageNo: number | null, lang: string | undefined): Frame {
  const els: LaidOutElement[] = [];
  const warnings: string[] = [];
  const c = t.colors;
  // light decoration in the top-right corner, kept clear of the title column
  if (t.id === "creative") {
    els.push(rect(SLIDE_W - 1.35, 0.32, 0.7, 0.7, c.lightDecor[0]!, { radius: CIRCLE }));
    els.push(rect(SLIDE_W - 0.95, 0.72, 0.42, 0.42, c.lightDecor[1]!, { radius: CIRCLE }));
  }
  const titleW = t.id === "creative" ? CONTENT_W - 1.2 : CONTENT_W;
  let y = TOP;
  if (content.kicker) {
    const kh = lineHeight(t.sizes.kicker);
    const k = clampLines(content.kicker, titleW, t.fonts.body, t.sizes.kicker, 1, true).text;
    els.push(text(t, { name: "kicker", role: "label", x: MX, y, w: titleW, h: kh, paragraphs: [para(k)], fontSizePt: t.sizes.kicker, bold: true, color: c.accent }));
    y += kh + 0.06;
  }
  let size = t.sizes.title;
  let lines = wrapText(title, titleW, t.fonts.heading, size, true);
  while (lines.length > 2 && size > t.sizes.titleMin) {
    size -= 2;
    lines = wrapText(title, titleW, t.fonts.heading, size, true);
  }
  let shown = title;
  if (lines.length > 3) {
    shown = clampLines(title, titleW, t.fonts.heading, size, 3, true).text;
    lines = wrapText(shown, titleW, t.fonts.heading, size, true);
    warnings.push("title_clamped");
  }
  const th = lines.length * lineHeight(size);
  els.push(text(t, { name: "title", role: "title", x: MX, y, w: titleW, h: th, paragraphs: [para(shown)], fontFace: t.fonts.heading, fontSizePt: size, bold: true, color: c.text, valign: "top" }));
  const contentTop = y + th + GAP + 0.05;

  // footer: source note (never overlapping content) + slide number
  const fs = t.sizes.footer;
  const flh = lineHeight(fs);
  const srcW = CONTENT_W - 1.0;
  let src = sourceLine(content, lang);
  let srcLines = src ? wrapText(src, srcW, t.fonts.body, fs).length : 0;
  if (srcLines > 2) {
    src = clampLines(src, srcW, t.fonts.body, fs, 2).text;
    srcLines = 2;
    warnings.push("source_note_clamped");
  }
  const footH = Math.max(1, srcLines) * flh;
  const footY = SLIDE_H - BOTTOM - footH;
  if (src) els.push(text(t, { name: "source", role: "footer", x: MX, y: footY, w: srcW, h: footH, paragraphs: [para(src)], fontSizePt: fs, color: c.muted, valign: "bottom" }));
  if (pageNo != null) {
    els.push(text(t, { name: "page", role: "footer", x: SLIDE_W - MX - 0.8, y: SLIDE_H - BOTTOM - flh, w: 0.8, h: flh, paragraphs: [para(String(pageNo))], fontSizePt: fs, color: c.muted, align: "right", valign: "bottom" }));
  }
  return { elements: els, contentTop, contentBottom: footY - GAP, warnings };
}

// ───────────────────────── text-heavy layouts ─────────────────────────

type BulletItem = { text: string; level: 0 | 1; ref?: number };

function bulletParas(items: BulletItem[], content: SlideContent, t: Theme, size: number): TextParagraph[] {
  const multi = (content.sources ?? []).length > 1;
  return withSizes(
    items.map((b) => {
      const runs: TextRun[] = [{ text: b.text }];
      if (multi && b.ref) runs.push({ text: ` [${b.ref}]`, color: t.colors.muted });
      return { runs, bullet: true, ...(b.level ? { level: b.level } : {}) };
    }),
    size,
  );
}

/** Largest body size at which `items` fit in h; null when even the minimum size overflows. */
function fitSize(t: Theme, h: number, w: number, build: (size: number) => TextParagraph[], sizes = t.sizes.body): { size: number; paras: TextParagraph[] } | null {
  for (const size of sizes) {
    const paras = build(size);
    if (measureBody(paras, t.fonts.body, size, w) <= h) return { size, paras };
  }
  return null;
}

/** Greedy split of items into pages that fit at the minimum size (each page keeps at least one item). */
function paginate<T>(items: T[], fits: (subset: T[]) => boolean): T[][] {
  const pages: T[][] = [];
  let cur: T[] = [];
  for (const it of items) {
    if (cur.length && !fits([...cur, it])) {
      pages.push(cur);
      cur = [];
    }
    cur.push(it);
  }
  if (cur.length) pages.push(cur);
  return pages;
}

type Part = { elements: LaidOutElement[]; warnings: string[]; background?: string };
type Ctx = { t: Theme; lang?: string; pageNo: (offset: number) => number | null };

function continuationTitle(title: string, part: number, lang?: string) {
  return part === 0 ? title : `${title} ${labels(lang).continued}`;
}

/** Content height available on every page of a split slide (a continuation title may wrap to more lines). */
function pageHeight(t: Theme, content: SlideContent, lang?: string): number {
  const a = contentFrame(t, content, content.title, 0, lang);
  const b = contentFrame(t, content, continuationTitle(content.title, 1, lang), 0, lang);
  return Math.min(a.contentBottom - a.contentTop, b.contentBottom - b.contentTop);
}

function bulletsParts(content: Extract<SlideContent, { layout: "bullets" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const items: BulletItem[] = content.bullets.map((b) => ({ text: b.text, level: (b.level ?? 0) as 0 | 1, ref: b.ref }));
  const pad = t.cards ? 0.35 : 0;
  const boxW = CONTENT_W - 2 * pad;
  const boxH = pageHeight(t, content, ctx.lang) - 2 * pad;
  const minSize = t.sizes.bodyMin;
  const pages = paginate(items, (sub) => measureBody(bulletParas(sub, content, t, minSize), t.fonts.body, minSize, boxW) <= boxH);
  return pages.map((page, i) => {
    const f = contentFrame(t, content, continuationTitle(content.title, i, ctx.lang), ctx.pageNo(i), ctx.lang);
    const h = f.contentBottom - f.contentTop;
    const fit = fitSize(t, h - 2 * pad, boxW, (s) => bulletParas(page, content, t, s)) ?? { size: minSize, paras: bulletParas(page, content, t, minSize) };
    const used = measureBody(fit.paras, t.fonts.body, fit.size, boxW);
    const els = [...f.elements];
    if (t.cards) els.push(rect(MX, f.contentTop, CONTENT_W, Math.min(h, used + 2 * pad + 0.1), c(t).surface, { radius: 0.06, line: c(t).surfaceLine }));
    els.push(text(t, { name: "body", role: "body", x: MX + pad, y: f.contentTop + pad, w: boxW, h: Math.min(h - 2 * pad, used + 0.12), paragraphs: fit.paras, fontSizePt: fit.size, lineSpacing: BODY_SPACING, bulletColor: c(t).accent }));
    const warnings = [...f.warnings];
    if (pages.length > 1) warnings.push("split_continuation");
    return { elements: els, warnings };
  });
}

const c = (t: Theme) => t.colors;

function twoColumnParts(content: Extract<SlideContent, { layout: "two_column" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const f = contentFrame(t, content, content.title, ctx.pageNo(0), ctx.lang);
  const gap = 0.4;
  const colW = (CONTENT_W - gap) / 2;
  const pad = 0.3;
  const innerW = colW - 2 * pad;
  const h = f.contentBottom - f.contentTop;
  const cols = [content.left, content.right];
  const build = (size: number) =>
    cols.map((col) => [
      para(col.heading, { bold: true, color: c(t).accent }),
      ...bulletParas(col.bullets.map((b) => ({ text: b.text, level: (b.level ?? 0) as 0 | 1, ref: b.ref })), content, t, size).map((p, i) => (i === 0 ? { ...p, spaceBeforePt: Math.round(size * 0.5) } : p)),
    ]);
  for (const size of t.sizes.body) {
    const paras = build(size);
    const heights = paras.map((p) => measureBody(p, t.fonts.body, size, innerW));
    if (Math.max(...heights) <= h - 2 * pad) {
      const els = [...f.elements];
      const cardH = Math.min(h, Math.max(...heights) + 2 * pad + 0.1);
      paras.forEach((p, i) => {
        const x = MX + i * (colW + gap);
        els.push(rect(x, f.contentTop, colW, cardH, i === 0 ? c(t).surface : c(t).accentSoft, { radius: 0.06, line: i === 0 ? c(t).surfaceLine : undefined }));
        els.push(text(t, { name: i === 0 ? "left" : "right", role: "body", x: x + pad, y: f.contentTop + pad, w: innerW, h: Math.min(h - 2 * pad, heights[i]! + 0.12), paragraphs: p, fontSizePt: size, lineSpacing: BODY_SPACING, color: i === 0 ? c(t).text : c(t).onAccentSoft, bulletColor: c(t).accent }));
      });
      return [{ elements: els, warnings: f.warnings }];
    }
  }
  // Too long for two columns at the minimum size: one column per slide.
  return cols.flatMap((col, i) =>
    bulletsParts({ layout: "bullets", title: col.heading ? `${content.title}: ${col.heading}` : content.title, kicker: content.kicker, sources: content.sources, aiWritten: content.aiWritten, bullets: col.bullets.length ? col.bullets : [{ text: col.heading, level: 0 }] }, { ...ctx, pageNo: (o) => ctx.pageNo(i + o) }).map((p) => ({ ...p, warnings: [...p.warnings, "split_columns"] })),
  );
}

function definitionParts(content: Extract<SlideContent, { layout: "definition" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const f = contentFrame(t, content, content.title, ctx.pageNo(0), ctx.lang);
  const h = f.contentBottom - f.contentTop;
  const pad = 0.45;
  const innerW = CONTENT_W - 2 * pad;
  for (const termSize of [40, 36, 32]) {
    const tl = wrapText(content.term, innerW, t.fonts.heading, termSize, true).length;
    if (tl > 2 && termSize > 32) continue;
    const termH = tl * lineHeight(termSize);
    for (const size of [28, ...t.sizes.body.filter((s) => s < 28)]) {
      const defH = measureBody([para(content.definition)], t.fonts.body, size, innerW, BODY_SPACING);
      const total = termH + 0.25 + defH;
      if (total <= h - 2 * pad) {
        const panelH = Math.min(h, total + 2 * pad + 0.1);
        const top = f.contentTop + Math.max(0, (h - panelH) / 2 - 0.3);
        const els = [...f.elements, rect(MX, top, CONTENT_W, panelH, c(t).accentSoft, { radius: 0.06 })];
        els.push(text(t, { name: "term", role: "big", x: MX + pad, y: top + pad, w: innerW, h: termH, paragraphs: [para(content.term)], fontFace: t.fonts.heading, fontSizePt: termSize, bold: true, color: c(t).accent }));
        els.push(text(t, { name: "body", role: "body", x: MX + pad, y: top + pad + termH + 0.25, w: innerW, h: defH + 0.12, paragraphs: [para(content.definition)], fontSizePt: size, lineSpacing: BODY_SPACING, color: c(t).onAccentSoft }));
        return [{ elements: els, warnings: f.warnings }];
      }
    }
  }
  // extremely long definition: fall back to a bullets slide split by sentences
  const sentences = content.definition.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [content.definition];
  return bulletsParts({ layout: "bullets", title: content.title, kicker: content.kicker, sources: content.sources, aiWritten: content.aiWritten, bullets: [{ text: content.term, level: 0 }, ...sentences.map((s) => ({ text: s, level: 1 as const }))] }, ctx);
}

function agendaParts(content: Extract<SlideContent, { layout: "agenda" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const h = pageHeight(t, content, ctx.lang);
  const badge = 0.6;
  const rowGap = 0.24;
  const items = content.items.map((s, i) => ({ s, n: i + 1 }));
  const twoCols = items.length > 5;
  const colW = twoCols ? (CONTENT_W - 0.5) / 2 : CONTENT_W;
  const textW = colW - badge - 0.25;
  const rowsH = (rows: typeof items, size: number) =>
    rows.reduce((acc, r, i) => acc + Math.max(badge, wrapText(r.s, textW, t.fonts.body, size).length * lineHeight(size)) + (i ? rowGap : 0), 0);
  const perCol = (rows: typeof items) => (twoCols ? [rows.slice(0, Math.ceil(rows.length / 2)), rows.slice(Math.ceil(rows.length / 2))] : [rows]);
  const fitsAt = (rows: typeof items, size: number) => perCol(rows).every((col) => rowsH(col, size) <= h);
  if (items.length >= 2 && items.length <= 4) {
    const cards = agendaCards(content, ctx);
    if (cards) return cards;
  }
  const pages = paginate(items, (sub) => fitsAt(sub, t.sizes.bodyMin));
  return pages.map((page, pi) => {
    const f = contentFrame(t, content, continuationTitle(content.title, pi, ctx.lang), ctx.pageNo(pi), ctx.lang);
    const size = t.sizes.body.find((s) => fitsAt(page, s)) ?? t.sizes.bodyMin;
    const els = [...f.elements];
    const avail = f.contentBottom - f.contentTop;
    perCol(page).forEach((col, ci) => {
      let y = f.contentTop;
      const x0 = MX + ci * (colW + 0.5);
      // spread short lists over the slide instead of leaving the lower half empty
      const gap = col.length > 1 ? Math.min(0.55, Math.max(rowGap, rowGap + (avail - rowsH(col, size)) / (col.length - 1))) : rowGap;
      for (const r of col) {
        const lines = wrapText(r.s, textW, t.fonts.body, size).length;
        const rowH = Math.max(badge, lines * lineHeight(size));
        els.push(rect(x0, y + (rowH - badge) / 2, badge, badge, c(t).accent, { radius: CIRCLE }));
        els.push(text(t, { name: `n${r.n}`, role: "label", x: x0, y: y + (rowH - badge) / 2, w: badge, h: badge, paragraphs: [para(String(r.n))], fontSizePt: 20, bold: true, color: c(t).onAccent, align: "center", valign: "middle" }));
        els.push(text(t, { name: `item${r.n}`, role: "body", x: x0 + badge + 0.25, y: y + (rowH - lines * lineHeight(size)) / 2, w: textW, h: lines * lineHeight(size), paragraphs: [para(r.s)], fontSizePt: size }));
        y += rowH + gap;
      }
    });
    return { elements: els, warnings: pages.length > 1 ? [...f.warnings, "split_continuation"] : f.warnings };
  });
}

/** Short outlines (2–4 parts) as a row of numbered cards: a clear visual instead of a half-empty list. */
function agendaCards(content: Extract<SlideContent, { layout: "agenda" }>, ctx: Ctx): Part[] | null {
  const { t } = ctx;
  const f = contentFrame(t, content, content.title, ctx.pageNo(0), ctx.lang);
  const n = content.items.length;
  const gap = 0.35;
  const w = (CONTENT_W - gap * (n - 1)) / n;
  const pad = 0.35;
  const innerW = w - 2 * pad;
  const numSize = 40;
  const numH = lineHeight(numSize, 1);
  const avail = f.contentBottom - f.contentTop;
  for (const size of t.sizes.body) {
    const heights = content.items.map((it) => measureBody([para(it)], t.fonts.body, size, innerW, BODY_SPACING));
    // cards as tall as the longest item needs (at least 2.6"), centred in the content area
    const cardH = Math.min(avail, Math.max(2.6, 2 * pad + numH + 0.25 + Math.max(...heights) + 0.1));
    if (Math.max(...heights) > cardH - 2 * pad - numH - 0.25) continue;
    const top = f.contentTop + Math.max(0, (avail - cardH) / 2 - 0.15);
    const els = [...f.elements];
    content.items.forEach((it, i) => {
      const x = MX + i * (w + gap);
      els.push(rect(x, top, w, cardH, c(t).accentSoft, { radius: 0.1 }));
      els.push(text(t, { name: `n${i + 1}`, role: "big", x: x + pad, y: top + pad, w: innerW, h: numH, paragraphs: [para(String(i + 1).padStart(2, "0"))], fontFace: t.fonts.heading, fontSizePt: numSize, bold: true, color: c(t).accent }));
      els.push(text(t, { name: `item${i + 1}`, role: "body", x: x + pad, y: top + pad + numH + 0.25, w: innerW, h: heights[i]! + 0.1, paragraphs: [para(it)], fontSizePt: size, lineSpacing: BODY_SPACING, color: c(t).onAccentSoft }));
    });
    return [{ elements: els, warnings: f.warnings }];
  }
  return null;
}

function referencesParts(content: Extract<SlideContent, { layout: "references" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const h = pageHeight(t, content, ctx.lang);
  const sizes = [22, 20];
  const items = content.items.map((s, i) => `${i + 1}. ${s}`);
  const build = (sub: string[], size: number) => sub.map((s, i) => para(s, { spaceBeforePt: i ? Math.round(size * 0.6) : 0 }));
  const pages = paginate(items, (sub) => measureBody(build(sub, 20), t.fonts.body, 20, CONTENT_W) <= h);
  return pages.map((page, pi) => {
    const f = contentFrame(t, content, continuationTitle(content.title, pi, ctx.lang), ctx.pageNo(pi), ctx.lang);
    const size = sizes.find((s) => measureBody(build(page, s), t.fonts.body, s, CONTENT_W) <= f.contentBottom - f.contentTop) ?? 20;
    const paras = build(page, size);
    const used = measureBody(paras, t.fonts.body, size, CONTENT_W);
    return { elements: [...f.elements, text(t, { name: "body", role: "body", x: MX, y: f.contentTop, w: CONTENT_W, h: used + 0.12, paragraphs: paras, fontSizePt: size, lineSpacing: BODY_SPACING })], warnings: pages.length > 1 ? [...f.warnings, "split_continuation"] : f.warnings };
  });
}

// ───────────────────────── data layouts ─────────────────────────

function exampleBadge(t: Theme, x: number, y: number, lang?: string): { els: LaidOutElement[]; h: number; w: number } {
  const label = labels(lang).exampleBadge;
  const size = 14;
  const w = textWidth(label, t.fonts.body, size, true) / WIDTH_SAFETY + 0.5;
  const h = lineHeight(size) + 0.18;
  return {
    w,
    h,
    els: [
      rect(x, y, w, h, c(t).warnBg, { radius: 0.3 }),
      text(t, { name: "example_badge", role: "label", x, y, w, h, paragraphs: [para(label)], fontSizePt: size, bold: true, color: c(t).warnText, align: "center", valign: "middle" }),
    ],
  };
}

type TableLayout = { colW: number[]; rowHs: number[]; headerH: number; size: number };

function tableMetrics(t: Theme, columns: string[], rows: string[][], width: number, maxH = Infinity): TableLayout | null {
  const padX = 0.12;
  const padY = 0.08;
  // Larger text when the table is small; otherwise the theme size, shrinking only for width.
  let fallback: TableLayout | null = null;
  for (let size = t.sizes.table + 4; size >= t.sizes.tableMin; size -= 2) {
    const n = columns.length;
    // natural width per column = widest cell; a column is never narrower than its longest word
    const natural = columns.map((col, i) => Math.max(textWidth(col, t.fonts.body, size, true), ...rows.map((r) => textWidth(r[i] ?? "", t.fonts.body, size))) / WIDTH_SAFETY + 2 * padX + 0.02);
    const minW = columns.map((col, i) =>
      Math.max(...[col, ...rows.map((r) => r[i] ?? "")].flatMap((cell) => cell.split(/\s+/)).map((word) => textWidth(word, t.fonts.body, size, true) / WIDTH_SAFETY + 2 * padX + 0.02)),
    );
    if (minW.reduce((a, b) => a + b, 0) > width) continue;
    let colW: number[];
    const sumNat = natural.reduce((a, b) => a + b, 0);
    if (sumNat <= width) colW = natural.map((w) => (w * width) / sumNat);
    else {
      // give every column its minimum, then share the rest in proportion to the remaining need
      const rest = width - minW.reduce((a, b) => a + b, 0);
      const need = natural.map((w, i) => w - minW[i]!);
      const needSum = need.reduce((a, b) => a + b, 0) || 1;
      colW = minW.map((w, i) => w + (rest * need[i]!) / needSum);
    }
    const cellH = (s: string, i: number, bold: boolean) => wrapText(s, colW[i]! - 2 * padX, t.fonts.body, size, bold).length * lineHeight(size) + 2 * padY;
    const headerH = Math.max(...columns.map((col, i) => cellH(col, i, true)));
    const rowHs = rows.map((r) => Math.max(...Array.from({ length: n }, (_, i) => cellH(r[i] ?? "", i, false))));
    const m = { colW, rowHs, headerH, size };
    if (headerH + rowHs.reduce((a, b) => a + b, 0) <= maxH) return m;
    if (size <= t.sizes.table && !fallback) fallback = m;
  }
  return fallback;
}

function tableParts(content: Extract<SlideContent, { layout: "table" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const capSize = t.sizes.caption;
  const capLines = content.caption ? Math.min(2, wrapText(content.caption, CONTENT_W, t.fonts.body, capSize).length) : 0;
  const capH = capLines * lineHeight(capSize);
  const badgeH = content.isExample ? lineHeight(14) + 0.18 + 0.2 : 0;
  const avail = pageHeight(t, content, ctx.lang) - badgeH - (capH ? capH + 0.2 : 0);
  const m = tableMetrics(t, content.columns, content.rows, CONTENT_W, avail);
  if (!m) {
    // too many/too wide columns: show as text rows instead of an unreadable table
    return bulletsParts({ layout: "bullets", title: content.title, kicker: content.kicker, sources: content.sources, aiWritten: content.aiWritten, bullets: content.rows.map((r) => ({ text: r.map((cell, i) => `${content.columns[i]}: ${cell}`).join("; ").slice(0, 600), level: 0 as const })) }, ctx).map((p) => ({ ...p, warnings: [...p.warnings, "table_as_text"] }));
  }
  const idx = content.rows.map((_, i) => i);
  const pages = paginate(idx, (sub) => m.headerH + sub.reduce((a, i) => a + m.rowHs[i]!, 0) <= avail);
  return pages.map((page, pi) => {
    const f = contentFrame(t, content, continuationTitle(content.title, pi, ctx.lang), ctx.pageNo(pi), ctx.lang);
    const els = [...f.elements];
    let y = f.contentTop;
    if (content.isExample) {
      const b = exampleBadge(t, MX, y, ctx.lang);
      els.push(...b.els);
      y += b.h + 0.2;
    }
    const rows = page.map((i) => content.columns.map((_, ci) => content.rows[i]![ci] ?? ""));
    const rowHeights = [m.headerH, ...page.map((i) => m.rowHs[i]!)].map(r3);
    const tableH = rowHeights.reduce((a, b) => a + b, 0);
    els.push({
      kind: "table", x: MX, y: r3(y), w: r3(m.colW.reduce((a, b) => a + b, 0)), h: r3(tableH), columns: content.columns, rows,
      fontFace: t.fonts.body, fontSizePt: m.size, headerFill: c(t).tableHeader, headerColor: c(t).onTableHeader, color: c(t).text,
      border: c(t).surfaceLine, zebra: c(t).zebra, colW: m.colW.map(r3), rowH: Math.max(...rowHeights.slice(1)), rowHeights,
    });
    y += tableH + 0.2;
    if (content.caption) {
      const cap = clampLines(content.caption, CONTENT_W, t.fonts.body, capSize, 2).text;
      els.push(text(t, { name: "caption", role: "caption", x: MX, y, w: CONTENT_W, h: capH, paragraphs: [para(cap)], fontSizePt: capSize, color: c(t).muted }));
    }
    return { elements: els, warnings: pages.length > 1 ? [...f.warnings, "table_split"] : f.warnings };
  });
}

function chartParts(content: Extract<SlideContent, { layout: "chart" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const L = labels(ctx.lang);
  const f = contentFrame(t, content, content.title, ctx.pageNo(0), ctx.lang);
  const els = [...f.elements];
  const top = f.contentTop;
  const h = f.contentBottom - top;
  const info: string[] = [];
  if (content.unit) info.push(`${L.unit}: ${content.unit}`);
  if (content.period) info.push(`${L.period}: ${content.period}`);
  if (content.caption) info.push(content.caption);
  const side = !!(content.takeaway || info.length || content.isExample);
  const sideW = side ? 3.9 : 0;
  const chartW = CONTENT_W - (side ? sideW + 0.4 : 0);
  const showLegend = content.series.length > 1 || content.chartKind === "pie";
  els.push({
    kind: "chart", x: MX, y: r3(top), w: r3(chartW), h: r3(h), chartKind: content.chartKind,
    categories: content.categories, series: content.series.map((s) => ({ name: s.name, values: s.values.slice(0, content.categories.length) })),
    colors: c(t).chart, fontFace: t.fonts.body, fontSizePt: t.sizes.chart, unit: content.unit, showLegend,
  });
  if (side) {
    const x = MX + chartW + 0.4;
    let y = top;
    if (content.isExample) {
      // the badge wraps inside the side column
      const label = L.exampleBadge;
      const lines = wrapText(label, sideW - 0.4, t.fonts.body, 14, true).length;
      const bh = lines * lineHeight(14) + 0.24;
      els.push(rect(x, y, sideW, bh, c(t).warnBg, { radius: 0.12 }));
      els.push(text(t, { name: "example_badge", role: "label", x: x + 0.2, y: y + 0.12, w: sideW - 0.4, h: bh - 0.24, paragraphs: [para(label)], fontSizePt: 14, bold: true, color: c(t).warnText, valign: "middle" }));
      y += bh + 0.25;
    }
    const pad = 0.3;
    const innerW = sideW - 2 * pad;
    const paras: TextParagraph[] = [];
    if (content.takeaway) paras.push(para(content.takeaway, { bold: true, color: c(t).onAccentSoft }));
    info.forEach((s, i) => paras.push(para(s, { color: c(t).muted, spaceBeforePt: i === 0 && content.takeaway ? 12 : 6 })));
    // takeaway 22pt, info 16pt: measure the two groups separately
    const avail = top + h - y - 2 * pad;
    let takeSize = 22;
    const infoSize = t.sizes.caption;
    const measure = (ts: number) => {
      const a = content.takeaway ? measureBody([paras[0]!], t.fonts.body, ts, innerW) : 0;
      const b = info.length ? measureBody(paras.slice(content.takeaway ? 1 : 0).map((p, i) => (i === 0 ? { ...p, spaceBeforePt: 0 } : p)), t.fonts.body, infoSize, innerW) + (content.takeaway ? 12 / 72 : 0) : 0;
      return { a, b };
    };
    let m = measure(takeSize);
    while (m.a + m.b > avail && takeSize > 18) m = measure((takeSize -= 2));
    const panelH = Math.min(avail + 2 * pad, m.a + m.b + 2 * pad + 0.1);
    els.push(rect(x, y, sideW, panelH, c(t).accentSoft, { radius: 0.08 }));
    let yy = y + pad;
    if (content.takeaway) {
      const tk = clampLines(content.takeaway, innerW, t.fonts.body, takeSize, Math.max(1, Math.floor(m.a / lineHeight(takeSize, BODY_SPACING))), true).text;
      els.push(text(t, { name: "takeaway", role: "body", x: x + pad, y: yy, w: innerW, h: m.a + 0.06, paragraphs: [para(tk, { bold: true })], fontSizePt: takeSize, color: c(t).onAccentSoft, lineSpacing: BODY_SPACING }));
      yy += m.a + 12 / 72;
    }
    if (info.length) {
      const ip = info.map((s, i) => para(s, { spaceBeforePt: i ? 6 : 0 }));
      const ih = measureBody(ip, t.fonts.body, infoSize, innerW);
      els.push(text(t, { name: "chart_info", role: "caption", x: x + pad, y: yy, w: innerW, h: ih + 0.06, paragraphs: ip, fontSizePt: infoSize, color: c(t).onAccentSoft, lineSpacing: BODY_SPACING }));
    }
  }
  return [{ elements: els, warnings: f.warnings }];
}

// ───────────────────────── dark (cover) layouts ─────────────────────────

function darkDecor(t: Theme): LaidOutElement[] {
  const d = c(t).darkDecor;
  return [rect(SLIDE_W - 4.6, 0.9, 3.6, 3.6, d[0]!, { radius: CIRCLE }), rect(SLIDE_W - 2.55, 3.85, 2.0, 2.0, d[1]!, { radius: CIRCLE })];
}

function coverParts(content: Extract<SlideContent, { layout: "title" | "section" | "questions" }>, ctx: Ctx): Part[] {
  const { t } = ctx;
  const els: LaidOutElement[] = [...darkDecor(t)];
  const x = 0.9;
  const w = SLIDE_W - 4.9 - x; // keep text clear of the decoration
  const subtitle = content.layout === "questions" ? content.prompt : content.subtitle;
  const meta = content.layout === "title" ? content.meta ?? [] : [];
  // meta lines (author, university…) sit at the bottom-left
  const metaSize = 18;
  const metaParas = meta.map((m, i) => para(m, { spaceBeforePt: i ? 4 : 0 }));
  const metaH = meta.length ? measureBody(metaParas, t.fonts.body, metaSize, w + 1.2) : 0;
  const metaY = SLIDE_H - 0.7 - metaH;
  const blockBottom = meta.length ? metaY - 0.45 : SLIDE_H - 0.9;
  const warnings: string[] = [];
  let size = content.layout === "section" ? 40 : t.sizes.hero;
  let lines = wrapText(content.title, w, t.fonts.heading, size, true);
  while (lines.length > 3 && size > 32) lines = wrapText(content.title, w, t.fonts.heading, (size -= 2), true);
  let title = content.title;
  if (lines.length > 4) {
    title = clampLines(content.title, w, t.fonts.heading, size, 4, true).text;
    lines = wrapText(title, w, t.fonts.heading, size, true);
    warnings.push("title_clamped");
  }
  const th = lines.length * lineHeight(size, 1.0);
  const kick = content.kicker ? clampLines(content.kicker, w, t.fonts.body, 16, 1, true).text : "";
  const kh = kick ? lineHeight(16) + 0.12 : 0;
  const subSize = 24;
  const sub = subtitle ? clampLines(subtitle, w, t.fonts.body, subSize, 3).text : "";
  const sh = sub ? wrapText(sub, w, t.fonts.body, subSize).length * lineHeight(subSize, BODY_SPACING) : 0;
  const blockH = kh + th + (sh ? 0.3 + sh : 0);
  let y = Math.max(0.8, Math.min((SLIDE_H - blockH) / 2 - 0.2, blockBottom - blockH));
  if (kick) {
    els.push(text(t, { name: "kicker", role: "label", x, y, w, h: lineHeight(16), paragraphs: [para(kick)], fontSizePt: 16, bold: true, color: c(t).onDarkAccent }));
    y += kh;
  }
  els.push(text(t, { name: "title", role: "title", x, y, w, h: th, paragraphs: [para(title)], fontFace: t.fonts.heading, fontSizePt: size, bold: true, color: c(t).onDark }));
  y += th;
  if (sub) {
    y += 0.3;
    els.push(text(t, { name: "subtitle", role: "subtitle", x, y, w, h: sh, paragraphs: [para(sub)], fontSizePt: subSize, color: c(t).onDarkMuted, lineSpacing: BODY_SPACING }));
  }
  if (meta.length) els.push(text(t, { name: "meta", role: "caption", x, y: metaY, w: w + 1.2, h: metaH, paragraphs: metaParas, fontSizePt: metaSize, color: c(t).onDarkMuted }));
  const pageNo = content.layout === "title" ? null : ctx.pageNo(0);
  if (pageNo != null) els.push(text(t, { name: "page", role: "footer", x: SLIDE_W - MX - 0.8, y: SLIDE_H - BOTTOM - lineHeight(12), w: 0.8, h: lineHeight(12), paragraphs: [para(String(pageNo))], fontSizePt: 12, color: c(t).onDarkMuted, align: "right", valign: "bottom" }));
  return [{ elements: els, warnings, background: c(t).dark }];
}

// ───────────────────────── entry points ─────────────────────────

function partsFor(content: SlideContent, ctx: Ctx): Part[] {
  switch (content.layout) {
    case "title":
    case "section":
    case "questions":
      return coverParts(content, ctx);
    case "agenda":
      return agendaParts(content, ctx);
    case "bullets":
      return bulletsParts(content, ctx);
    case "two_column":
      return twoColumnParts(content, ctx);
    case "definition":
      return definitionParts(content, ctx);
    case "table":
      return tableParts(content, ctx);
    case "chart":
      return chartParts(content, ctx);
    case "references":
      return referencesParts(content, ctx);
  }
}

/** Lays out one slide; `startIndex` is its first render index (page numbers are index + 1). */
export function layoutSlide(s: LayoutInput, t: Theme, startIndex: number, opts: LayoutOptions = {}): LaidOutSlide[] {
  const numbers = opts.slideNumbers ?? true;
  const ctx: Ctx = { t, lang: opts.language, pageNo: (o) => (numbers ? startIndex + o + 1 : null) };
  const parts = partsFor(s.content, ctx);
  return parts.map((p, i) => ({
    slideId: s.id,
    renderIndex: startIndex + i,
    ...(i > 0 ? { continuationOf: s.id } : {}),
    background: p.background ?? t.colors.bg,
    elements: p.elements,
    notes: i === 0 ? (s.notes ?? "") : "",
    warnings: p.warnings,
  }));
}

/** Lays out a whole deck. Continuation slides get their own render index right after their source slide. */
export function layoutDeck(slides: LayoutInput[], t: Theme, opts: LayoutOptions = {}): LaidOutSlide[] {
  const out: LaidOutSlide[] = [];
  for (const s of slides) out.push(...layoutSlide(s, t, out.length, opts));
  return out;
}

/** How many rendered slides one slide needs (1 = fits). Used by generators to keep slides to one page. */
export function renderedPages(content: SlideContent, t: Theme, lang?: string): number {
  return partsFor(content, { t, lang, pageNo: () => 1 }).length;
}

/** All text a laid-out slide shows (for render checks). */
export function slideText(s: LaidOutSlide): string[] {
  const out: string[] = [];
  for (const e of s.elements) {
    if (e.kind === "text") out.push(e.paragraphs.map(paraText).join("\n"));
    else if (e.kind === "table") out.push([e.columns.join(" "), ...e.rows.map((r) => r.join(" "))].join("\n"));
    else if (e.kind === "chart") out.push([...e.categories, ...e.series.map((x) => x.name)].join(" "));
  }
  return out;
}
