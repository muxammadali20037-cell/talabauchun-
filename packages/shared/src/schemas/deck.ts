import { z } from "zod";

export const ThemeId = z.enum(["academic", "data", "creative"]);
export type ThemeId = z.infer<typeof ThemeId>;

/** Reference to a stored source_reference row (evidence), rendered as a short footnote. */
export const SlideSourceRef = z.object({
  sourceRefId: z.string().uuid().optional(),
  label: z.string().max(300),
});
export type SlideSourceRef = z.infer<typeof SlideSourceRef>;

export const Bullet = z.object({
  text: z.string().min(1).max(600),
  level: z.union([z.literal(0), z.literal(1)]).default(0),
});
export type Bullet = z.infer<typeof Bullet>;

const base = {
  title: z.string().max(200),
  sources: z.array(SlideSourceRef).max(6).default([]),
  /** true when text is AI-written explanation rather than extracted from a source */
  aiWritten: z.boolean().default(false),
};

export const SlideContent = z.discriminatedUnion("layout", [
  z.object({
    layout: z.literal("title"),
    ...base,
    subtitle: z.string().max(300).optional(),
    meta: z.array(z.string().max(200)).max(6).default([]),
  }),
  z.object({ layout: z.literal("section"), ...base, subtitle: z.string().max(300).optional() }),
  z.object({ layout: z.literal("agenda"), ...base, items: z.array(z.string().min(1).max(200)).min(1).max(12) }),
  z.object({ layout: z.literal("bullets"), ...base, bullets: z.array(Bullet).min(1).max(14) }),
  z.object({
    layout: z.literal("two_column"),
    ...base,
    left: z.object({ heading: z.string().max(120), bullets: z.array(Bullet).max(8) }),
    right: z.object({ heading: z.string().max(120), bullets: z.array(Bullet).max(8) }),
  }),
  z.object({
    layout: z.literal("definition"),
    ...base,
    term: z.string().max(160),
    definition: z.string().max(800),
  }),
  z.object({
    layout: z.literal("table"),
    ...base,
    columns: z.array(z.string().max(80)).min(1).max(8),
    rows: z.array(z.array(z.string().max(120))).min(1).max(14),
    caption: z.string().max(300).optional(),
  }),
  z.object({
    layout: z.literal("chart"),
    ...base,
    chartKind: z.enum(["bar", "column", "line", "pie"]),
    categories: z.array(z.string().max(60)).min(1).max(24),
    series: z.array(z.object({ name: z.string().max(80), values: z.array(z.number().finite()) })).min(1).max(6),
    unit: z.string().max(40).optional(),
    caption: z.string().max(300).optional(),
    /** Where the numbers came from; "example" data must be visibly labelled. */
    dataOrigin: z.enum(["source_table", "user_input", "example"]),
    takeaway: z.string().max(300).optional(),
  }),
  z.object({
    layout: z.literal("questions"),
    ...base,
    prompt: z.string().max(200).optional(),
  }),
  z.object({ layout: z.literal("references"), ...base, items: z.array(z.string().min(1).max(400)).min(1).max(20) }),
]);
export type SlideContent = z.infer<typeof SlideContent>;
export type SlideLayout = SlideContent["layout"];

export const DeckSettings = z.object({
  language: z.string().default("uz"),
  topic: z.string().min(2).max(300),
  audience: z.string().max(200).default("talabalar"),
  durationMin: z.number().int().min(1).max(120).default(10),
  slideCount: z.number().int().min(4).max(40).default(12),
  theme: ThemeId.default("academic"),
  author: z.string().max(200).optional(),
  university: z.string().max(200).optional(),
  subject: z.string().max(200).optional(),
  teacher: z.string().max(200).optional(),
  group: z.string().max(100).optional(),
  requirements: z.string().max(5000).optional(),
  extras: z.object({ speech: z.boolean().default(true), defenseQa: z.boolean().default(true), handout: z.boolean().default(false) }).default({ speech: true, defenseQa: true, handout: false }),
});
export type DeckSettings = z.infer<typeof DeckSettings>;

/** Laid-out element shared by HTML preview and PPTX renderer (units: inches, 13.333 x 7.5 slide). */
export type TextRun = { text: string; bold?: boolean; italic?: boolean; color?: string };
export type TextParagraph = { runs: TextRun[]; level?: 0 | 1; bullet?: boolean; spaceBeforePt?: number };
export type LaidOutElement =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill: string; radius?: number; line?: string }
  | {
      kind: "text";
      role: "title" | "subtitle" | "body" | "caption" | "footer" | "label" | "big";
      x: number; y: number; w: number; h: number;
      paragraphs: TextParagraph[];
      fontFace: string; fontSizePt: number; color: string; bold?: boolean;
      align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom";
      lineSpacing: number;
    }
  | {
      kind: "table"; x: number; y: number; w: number; h: number;
      columns: string[]; rows: string[][]; fontFace: string; fontSizePt: number;
      headerFill: string; headerColor: string; color: string; border: string; zebra?: string;
      colW: number[]; rowH: number;
    }
  | {
      kind: "chart"; x: number; y: number; w: number; h: number;
      chartKind: "bar" | "column" | "line" | "pie";
      categories: string[]; series: { name: string; values: number[] }[];
      colors: string[]; fontFace: string; fontSizePt: number; unit?: string; showLegend: boolean;
    };

export type LaidOutSlide = {
  slideId: string;
  /** index in the rendered deck (continuation slides get their own index) */
  renderIndex: number;
  continuationOf?: string;
  background: string;
  elements: LaidOutElement[];
  notes: string;
  warnings: string[];
};

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;
