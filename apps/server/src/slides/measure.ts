import { existsSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";

/**
 * Server-side text measurement with real font metrics. The deck fonts are
 * restricted to Arial and Times New Roman, whose metric-compatible substitutes
 * (Liberation Sans / Serif) ship with LibreOffice on Linux, so a line that fits
 * here also fits in the PDF and in PowerPoint. Widths come from glyph advance
 * widths (× size / unitsPerEm); a safety margin covers kerning/rounding
 * differences between renderers.
 */

const FONT_DIRS = [
  "/usr/share/fonts/truetype/liberation",
  "/usr/share/fonts/truetype/liberation2",
  "/usr/share/fonts/liberation",
  "/usr/share/fonts/liberation-sans",
  "/usr/share/fonts/liberation-serif",
  "/usr/local/share/fonts",
  "/opt/homebrew/share/fonts",
];

const FONT_FILES: Record<string, { regular: string; bold: string }> = {
  arial: { regular: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" },
  "times new roman": { regular: "LiberationSerif-Regular.ttf", bold: "LiberationSerif-Bold.ttf" },
};

/** Width safety factor: wrap as if boxes were 5% narrower than they are. */
export const WIDTH_SAFETY = 0.95;
/** Line pitch as a multiple of the font size (Liberation Sans single spacing is ≈1.15). */
export const LINE_HEIGHT = 1.2;

type LoadedFont = { font: fontkit.Font | null; cache: Map<number, number>; file: string | null };
const loaded = new Map<string, LoadedFont>();

function findFile(name: string): string | null {
  for (const dir of FONT_DIRS) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function load(face: string, bold: boolean): LoadedFont {
  const key = `${face.toLowerCase()}|${bold ? "b" : "r"}`;
  let f = loaded.get(key);
  if (f) return f;
  const files = FONT_FILES[face.toLowerCase()] ?? FONT_FILES.arial!;
  const file = findFile(bold ? files.bold : files.regular);
  let font: fontkit.Font | null = null;
  if (file) {
    const opened = fontkit.openSync(file);
    font = "glyphForCodePoint" in opened ? (opened as fontkit.Font) : null;
  }
  f = { font, cache: new Map(), file };
  loaded.set(key, f);
  return f;
}

/** Which font file measures a face (null = fallback estimate; fonts-liberation is not installed). */
export function fontFileFor(face: string, bold = false): string | null {
  return load(face, bold).file;
}

/** Code points the font cannot render (would fall back to another font in the PDF). */
export function missingGlyphs(text: string, face = "Arial", bold = false): string[] {
  const { font } = load(face, bold);
  if (!font) return [];
  const out = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x20) continue;
    if (!font.hasGlyphForCodePoint(cp)) out.add(ch);
  }
  return [...out];
}

/** Advance width of one character in em units. */
function charEm(f: LoadedFont, cp: number): number {
  let w = f.cache.get(cp);
  if (w !== undefined) return w;
  if (f.font) {
    const g = f.font.glyphForCodePoint(cp);
    w = g.advanceWidth / f.font.unitsPerEm;
  } else {
    // No font file: a deliberately wide estimate so layout errs towards splitting, never overflowing.
    w = cp === 0x20 ? 0.28 : cp >= 0x2000 && cp <= 0x206f ? 1.0 : 0.62;
  }
  f.cache.set(cp, w);
  return w;
}

/** Width of `text` in inches at `sizePt`. */
export function textWidth(text: string, face: string, sizePt: number, bold = false): number {
  const f = load(face, bold);
  let em = 0;
  for (const ch of text) em += charEm(f, ch.codePointAt(0)!);
  return (em * sizePt) / 72;
}

/** Line pitch in inches. */
export function lineHeight(sizePt: number, spacing = 1): number {
  return (sizePt * LINE_HEIGHT * spacing) / 72;
}

/**
 * Greedy word wrap into lines that fit `maxWidth` inches (after the safety
 * factor). Explicit "\n" are hard breaks; a word longer than a line is broken
 * by characters (URLs). Returns at least one (possibly empty) line.
 */
export function wrapText(text: string, maxWidth: number, face: string, sizePt: number, bold = false): string[] {
  const limit = Math.max(0.2, maxWidth * WIDTH_SAFETY);
  const out: string[] = [];
  for (const hard of text.split("\n")) {
    const words = hard.split(/[ \t]+/).filter((w) => w.length > 0);
    if (!words.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, face, sizePt, bold) <= limit) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (textWidth(word, face, sizePt, bold) <= limit) {
        line = word;
        continue;
      }
      // break an over-long token
      let piece = "";
      for (const ch of word) {
        if (textWidth(piece + ch, face, sizePt, bold) > limit && piece) {
          out.push(piece);
          piece = ch;
        } else piece += ch;
      }
      line = piece;
    }
    out.push(line);
  }
  return out;
}

export type MeasuredParagraph = {
  text: string;
  sizePt: number;
  bold?: boolean;
  face: string;
  /** left indent in inches (bullet hanging indent) */
  indent?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
};

/** Height in inches of paragraphs stacked in one text box of width `boxW`. */
export function measureParagraphs(paras: MeasuredParagraph[], boxW: number, spacing = 1): { height: number; lines: number[] } {
  let h = 0;
  const lines: number[] = [];
  paras.forEach((p, i) => {
    const n = wrapText(p.text, boxW - (p.indent ?? 0), p.face, p.sizePt, p.bold).length;
    lines.push(n);
    if (i > 0) h += (p.spaceBeforePt ?? 0) / 72;
    h += n * lineHeight(p.sizePt, spacing);
    if (i < paras.length - 1) h += (p.spaceAfterPt ?? 0) / 72;
  });
  return { height: h, lines };
}

/** Shortens text to `maxLines` lines at the given width, ending with "…" on a word boundary. */
export function clampLines(text: string, maxWidth: number, face: string, sizePt: number, maxLines: number, bold = false): { text: string; clamped: boolean } {
  const lines = wrapText(text, maxWidth, face, sizePt, bold);
  if (lines.length <= maxLines) return { text, clamped: false };
  const words = text.split(/\s+/);
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = words.slice(0, mid).join(" ") + "…";
    if (wrapText(candidate, maxWidth, face, sizePt, bold).length <= maxLines) lo = mid;
    else hi = mid - 1;
  }
  return { text: words.slice(0, Math.max(1, lo)).join(" ").replace(/[,;:—–-]+$/, "") + "…", clamped: true };
}
