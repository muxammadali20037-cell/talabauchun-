import type { ThemeId } from "@talaba/shared";

/**
 * Deck design systems. Fonts are limited to families with metric-compatible
 * free substitutes (Arial → Liberation Sans, Times New Roman → Liberation
 * Serif), so text measured on the server, the LibreOffice PDF and the user's
 * PowerPoint all wrap the same way. Colors are hex without "#" (pptxgenjs
 * corrupts files when given "#RRGGBB").
 */
export type Theme = {
  id: ThemeId;
  name: string;
  fonts: { heading: string; body: string };
  /** Point sizes. Body text never goes below `bodyMin`: content is split onto a continuation slide instead. */
  sizes: {
    hero: number;
    title: number;
    titleMin: number;
    body: number[];
    bodyMin: number;
    kicker: number;
    caption: number;
    footer: number;
    table: number;
    tableMin: number;
    chart: number;
  };
  colors: {
    bg: string;
    /** card / panel surface on content slides */
    surface: string;
    surfaceLine: string;
    text: string;
    muted: string;
    accent: string;
    onAccent: string;
    /** tint of the accent used behind definitions and takeaways */
    accentSoft: string;
    /** text color used on accentSoft */
    onAccentSoft: string;
    /** cover / questions / section slides */
    dark: string;
    onDark: string;
    onDarkMuted: string;
    onDarkAccent: string;
    /** decorative shapes on the dark slides (never behind text) */
    darkDecor: string[];
    /** decorative shapes on light content slides (never behind text) */
    lightDecor: string[];
    tableHeader: string;
    onTableHeader: string;
    zebra: string;
    warnBg: string;
    warnText: string;
    chart: string[];
  };
  /** Card panels behind bullets (Modern Data) or plain text on the page. */
  cards: boolean;
};

export const THEMES: Record<ThemeId, Theme> = {
  academic: {
    id: "academic",
    name: "Academic Clean",
    fonts: { heading: "Times New Roman", body: "Arial" },
    sizes: { hero: 44, title: 36, titleMin: 30, body: [28, 26, 24, 22], bodyMin: 22, kicker: 14, caption: 16, footer: 12, table: 18, tableMin: 14, chart: 14 },
    colors: {
      bg: "FFFFFF",
      surface: "F8FAFC",
      surfaceLine: "E2E8F0",
      text: "0F172A",
      muted: "475569",
      accent: "4F46E5",
      onAccent: "FFFFFF",
      accentSoft: "EEF2FF",
      onAccentSoft: "1E1B4B",
      dark: "1E1B4B",
      onDark: "FFFFFF",
      onDarkMuted: "C7D2FE",
      onDarkAccent: "A5B4FC",
      darkDecor: ["312E81", "3730A3"],
      lightDecor: ["EEF2FF", "E0E7FF"],
      tableHeader: "4F46E5",
      onTableHeader: "FFFFFF",
      zebra: "F1F5F9",
      warnBg: "FEF3C7",
      warnText: "92400E",
      chart: ["4F46E5", "059669", "D97706", "0284C7", "BE123C", "475569"],
    },
    cards: false,
  },
  data: {
    id: "data",
    name: "Modern Data",
    fonts: { heading: "Arial", body: "Arial" },
    sizes: { hero: 44, title: 34, titleMin: 28, body: [26, 24, 22], bodyMin: 22, kicker: 14, caption: 16, footer: 12, table: 18, tableMin: 14, chart: 14 },
    colors: {
      bg: "F8FAFC",
      surface: "FFFFFF",
      surfaceLine: "E2E8F0",
      text: "0F172A",
      muted: "475569",
      accent: "0F766E",
      onAccent: "FFFFFF",
      accentSoft: "ECFDF5",
      onAccentSoft: "064E3B",
      dark: "0F172A",
      onDark: "F8FAFC",
      onDarkMuted: "CBD5E1",
      onDarkAccent: "34D399",
      darkDecor: ["1E293B", "134E4A"],
      lightDecor: ["D1FAE5", "E2E8F0"],
      tableHeader: "0F172A",
      onTableHeader: "FFFFFF",
      zebra: "F1F5F9",
      warnBg: "FEF3C7",
      warnText: "92400E",
      chart: ["059669", "4F46E5", "D97706", "0284C7", "BE123C", "475569"],
    },
    cards: true,
  },
  creative: {
    id: "creative",
    name: "Creative Seminar",
    fonts: { heading: "Arial", body: "Arial" },
    sizes: { hero: 46, title: 36, titleMin: 30, body: [28, 26, 24, 22], bodyMin: 22, kicker: 14, caption: 16, footer: 12, table: 18, tableMin: 14, chart: 14 },
    colors: {
      bg: "FFFFFF",
      surface: "FFF7ED",
      surfaceLine: "FED7AA",
      text: "1C1917",
      muted: "57534E",
      accent: "BE123C",
      onAccent: "FFFFFF",
      accentSoft: "FFF1F2",
      onAccentSoft: "881337",
      dark: "4338CA",
      onDark: "FFFFFF",
      onDarkMuted: "E0E7FF",
      onDarkAccent: "FECDD3",
      darkDecor: ["4F46E5", "6366F1"],
      lightDecor: ["FFE4E6", "E0E7FF"],
      tableHeader: "BE123C",
      onTableHeader: "FFFFFF",
      zebra: "FFF1F2",
      warnBg: "FEF3C7",
      warnText: "92400E",
      chart: ["BE123C", "4F46E5", "D97706", "0F766E", "7C3AED", "57534E"],
    },
    cards: false,
  },
};

export function getTheme(id: string | null | undefined): Theme {
  return THEMES[(id ?? "academic") as ThemeId] ?? THEMES.academic;
}

/** WCAG 2.x relative luminance of an sRGB hex color ("RRGGBB"). */
export function relativeLuminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`invalid color ${hex}`);
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG contrast ratio (1..21). Body text needs ≥ 4.5, large text and graphics ≥ 3. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every text/background pair the layout engine actually uses, with the minimum ratio it must meet. */
export function themeTextPairs(t: Theme): { name: string; fg: string; bg: string; min: number }[] {
  const c = t.colors;
  return [
    { name: "text/bg", fg: c.text, bg: c.bg, min: 4.5 },
    { name: "muted/bg", fg: c.muted, bg: c.bg, min: 4.5 },
    { name: "accent/bg", fg: c.accent, bg: c.bg, min: 4.5 },
    { name: "text/surface", fg: c.text, bg: c.surface, min: 4.5 },
    { name: "muted/surface", fg: c.muted, bg: c.surface, min: 4.5 },
    { name: "accent/surface", fg: c.accent, bg: c.surface, min: 4.5 },
    { name: "onAccent/accent", fg: c.onAccent, bg: c.accent, min: 4.5 },
    { name: "onAccentSoft/accentSoft", fg: c.onAccentSoft, bg: c.accentSoft, min: 4.5 },
    { name: "accent/accentSoft", fg: c.accent, bg: c.accentSoft, min: 4.5 },
    { name: "onDark/dark", fg: c.onDark, bg: c.dark, min: 4.5 },
    { name: "onDarkMuted/dark", fg: c.onDarkMuted, bg: c.dark, min: 4.5 },
    { name: "onDarkAccent/dark", fg: c.onDarkAccent, bg: c.dark, min: 4.5 },
    { name: "onTableHeader/tableHeader", fg: c.onTableHeader, bg: c.tableHeader, min: 4.5 },
    { name: "text/zebra", fg: c.text, bg: c.zebra, min: 4.5 },
    { name: "warnText/warnBg", fg: c.warnText, bg: c.warnBg, min: 4.5 },
    // chart marks are graphics (WCAG 1.4.11): 3:1 against the slide background
    ...c.chart.slice(0, 2).map((col, i) => ({ name: `chart${i}/bg`, fg: col, bg: t.cards ? c.surface : c.bg, min: 3 })),
  ];
}

export function themeContrastIssues(t: Theme): string[] {
  return themeTextPairs(t)
    .map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${t.id}:${p.name}=${p.ratio.toFixed(2)}<${p.min}`);
}
