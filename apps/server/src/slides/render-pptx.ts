import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import type { LaidOutElement, LaidOutSlide } from "@talaba/shared";
import { BULLET_INDENT_PT } from "./layout";
import { pptxLang } from "./labels";
import type { Theme } from "./themes";

/**
 * Renders laid-out slides to an editable PPTX: text boxes with real bullet
 * paragraphs, native shapes, native tables and native charts built from the
 * stored numbers. Nothing is rasterised. Positions and sizes come verbatim
 * from the layout engine, the same model the Mini App preview draws.
 */

export type RenderMeta = { title: string; author?: string | null; subject?: string | null; language?: string };

type TextEl = Extract<LaidOutElement, { kind: "text" }>;
type TableEl = Extract<LaidOutElement, { kind: "table" }>;
type ChartEl = Extract<LaidOutElement, { kind: "chart" }>;
type Slide = ReturnType<PptxGenJS["addSlide"]>;

function addRect(pptx: PptxGenJS, slide: Slide, e: Extract<LaidOutElement, { kind: "rect" }>, name: string) {
  const half = Math.min(e.w, e.h) / 2;
  const radius = Math.min(e.radius ?? 0, half);
  const circle = e.radius != null && radius >= half - 1e-3 && Math.abs(e.w - e.h) < 1e-3;
  const shape = circle ? pptx.ShapeType.ellipse : radius > 0 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect;
  slide.addShape(shape, {
    x: e.x, y: e.y, w: e.w, h: e.h,
    fill: { color: e.fill },
    line: e.line ? { color: e.line, width: 0.75 } : { type: "none" },
    ...(radius > 0 && !circle ? { rectRadius: radius } : {}),
    objectName: name,
  });
}

function addText(slide: Slide, e: TextEl, lang: string, name: string) {
  const runs: PptxGenJS.TextProps[] = [];
  e.paragraphs.forEach((p, pi) => {
    const lastPara = pi === e.paragraphs.length - 1;
    p.runs.forEach((r, ri) => {
      const first = ri === 0;
      const last = ri === p.runs.length - 1;
      runs.push({
        text: r.text,
        options: {
          // paragraph properties go on the first run only; pptxgenjs starts a new paragraph at every bulleted run
          ...(first && p.bullet ? { bullet: { indent: BULLET_INDENT_PT }, ...(p.level ? { indentLevel: p.level } : {}) } : {}),
          ...(first && p.spaceBeforePt ? { paraSpaceBefore: p.spaceBeforePt } : {}),
          ...(r.bold ?? e.bold ? { bold: true } : {}),
          ...(r.italic ? { italic: true } : {}),
          color: r.color ?? e.color,
          lang,
          ...(last && !lastPara ? { breakLine: true } : {}),
        },
      });
    });
  });
  slide.addText(runs, {
    x: e.x, y: e.y, w: e.w, h: e.h,
    fontFace: e.fontFace, fontSize: e.fontSizePt, color: e.color,
    align: e.align, valign: e.valign, lineSpacingMultiple: e.lineSpacing,
    margin: 0, isTextBox: true, fit: "none", wrap: true, lang,
    objectName: name,
  });
}

function addTable(slide: Slide, e: TableEl, lang: string, name: string) {
  const header: PptxGenJS.TableCell[] = e.columns.map((col) => ({ text: col, options: { bold: true, color: e.headerColor, fill: { color: e.headerFill }, lang } }));
  const body: PptxGenJS.TableCell[][] = e.rows.map((row, ri) =>
    row.map((cell) => ({ text: cell, options: { color: e.color, fill: { color: e.zebra && ri % 2 === 1 ? e.zebra : "FFFFFF" }, lang } })),
  );
  slide.addTable([header, ...body], {
    x: e.x, y: e.y, w: e.w, colW: e.colW,
    rowH: e.rowHeights ?? [e.rowH, ...e.rows.map(() => e.rowH)],
    fontFace: e.fontFace, fontSize: e.fontSizePt, color: e.color, valign: "middle",
    border: { type: "solid", pt: 0.75, color: e.border },
    margin: [0.08, 0.12, 0.08, 0.12],
    autoPage: false,
    objectName: name,
  });
}

function addChart(pptx: PptxGenJS, slide: Slide, e: ChartEl, name: string) {
  const data = e.series.map((s) => ({ name: s.name, labels: e.categories, values: s.values }));
  const type = e.chartKind === "line" ? pptx.ChartType.line : e.chartKind === "pie" ? pptx.ChartType.pie : pptx.ChartType.bar;
  const axisText = "475569";
  const common: PptxGenJS.IChartOpts = {
    x: e.x, y: e.y, w: e.w, h: e.h,
    objectName: name,
    chartColors: e.chartKind === "pie" ? e.categories.map((_, i) => e.colors[i % e.colors.length]!) : e.colors.slice(0, Math.max(1, e.series.length)),
    showLegend: e.showLegend,
    legendPos: "b",
    legendFontFace: e.fontFace,
    legendFontSize: e.fontSizePt,
    legendColor: axisText,
    showValue: true,
    dataLabelFontFace: e.fontFace,
    dataLabelFontSize: e.fontSizePt,
    dataLabelColor: "0F172A",
    showTitle: false,
  };
  if (e.chartKind === "pie") {
    slide.addChart(type, data, { ...common, dataLabelPosition: "bestFit", showPercent: false });
    return;
  }
  slide.addChart(type, data, {
    ...common,
    ...(e.chartKind === "line"
      ? { lineSize: 3, lineDataSymbol: "circle", lineDataSymbolSize: 9, dataLabelPosition: "t" as const }
      : { barDir: e.chartKind === "bar" ? "bar" : "col", barGapWidthPct: 60, dataLabelPosition: "outEnd" as const }),
    catAxisLabelFontFace: e.fontFace,
    catAxisLabelFontSize: e.fontSizePt,
    catAxisLabelColor: axisText,
    valAxisLabelFontFace: e.fontFace,
    valAxisLabelFontSize: e.fontSizePt,
    valAxisLabelColor: axisText,
    valGridLine: { color: "E2E8F0", size: 0.75 },
    catGridLine: { style: "none" },
    ...(e.unit ? { showValAxisTitle: true, valAxisTitle: e.unit, valAxisTitleFontFace: e.fontFace, valAxisTitleFontSize: e.fontSizePt, valAxisTitleColor: axisText } : {}),
  });
}

/**
 * pptxgenjs writes a second <a:pPr> inside a paragraph for every extra run,
 * which is not valid DrawingML (PowerPoint may "repair" the file). Keep only
 * the first paragraph-properties element of each paragraph.
 */
export function fixParagraphProps(xml: string): string {
  return xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_m, inner: string) => {
    let seenRun = false;
    const fixed = inner.replace(/<a:pPr\b[^>]*\/>|<a:pPr\b[\s\S]*?<\/a:pPr>|<a:r>/g, (tag) => {
      if (tag === "<a:r>") {
        seenRun = true;
        return tag;
      }
      return seenRun ? "" : tag;
    });
    return `<a:p>${fixed}</a:p>`;
  });
}

/**
 * pptxgenjs cannot color bullet glyphs; add <a:buClr> to the bulleted
 * paragraphs of the named shapes (schema order: buClr precedes buSzPct).
 */
export function colorBullets(xml: string, colors: Map<string, string>): string {
  if (!colors.size) return xml;
  return xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/g, (sp) => {
    const name = /<p:cNvPr id="\d+" name="([^"]*)"/.exec(sp)?.[1];
    const color = name ? colors.get(name) : undefined;
    if (!color) return sp;
    return sp.replace(/<a:buSzPct val="100000"\/><a:buChar /g, `<a:buClr><a:srgbClr val="${color}"/></a:buClr><a:buSzPct val="100000"/><a:buChar `);
  });
}

export async function renderPptx(slides: LaidOutSlide[], theme: Theme, meta: RenderMeta): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = meta.title.slice(0, 200);
  pptx.author = (meta.author ?? "").slice(0, 200) || "TALABA AI";
  pptx.company = "TALABA AI";
  if (meta.subject) pptx.subject = meta.subject.slice(0, 200);
  pptx.theme = { headFontFace: theme.fonts.heading, bodyFontFace: theme.fonts.body };
  const lang = pptxLang(meta.language);
  for (const ls of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: ls.background };
    ls.elements.forEach((e, i) => {
      const name = e.kind === "text" && e.name ? e.name : `${e.kind}${i + 1}`;
      if (e.kind === "rect") addRect(pptx, slide, e, name);
      else if (e.kind === "text") addText(slide, e, lang, name);
      else if (e.kind === "table") addTable(slide, e, lang, name);
      else addChart(pptx, slide, e, name);
    });
    if (ls.notes.trim()) slide.addNotes(ls.notes);
  }
  const raw = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  const zip = await JSZip.loadAsync(raw);
  for (const path of Object.keys(zip.files)) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
    if (!m) continue;
    const ls = slides[Number(m[1]) - 1];
    const colors = new Map<string, string>();
    for (const e of ls?.elements ?? []) if (e.kind === "text" && e.name && e.bulletColor) colors.set(e.name, e.bulletColor);
    const xml = await zip.file(path)!.async("string");
    zip.file(path, colorBullets(fixParagraphProps(xml), colors));
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
