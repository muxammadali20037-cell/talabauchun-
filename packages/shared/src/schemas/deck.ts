import { z } from "zod";

export const ThemeId = z.enum(["academic", "data", "creative"]);
export type ThemeId = z.infer<typeof ThemeId>;

/** Reference to a stored source_reference row (evidence), rendered as a short footnote. */
export const SlideSourceRef = z.object({
  sourceRefId: z.string().uuid().optional(),
  label: z.string().max(300),
  /**
   * Set by the server only: true when the cited passage was found in the source
   * text (exact/fuzzy quote) or the values were copied from a source table.
   * Client-sent values are ignored and recomputed on every save.
   */
  verified: z.boolean().optional(),
});
export type SlideSourceRef = z.infer<typeof SlideSourceRef>;

export const Bullet = z.object({
  text: z.string().min(1).max(600),
  level: z.union([z.literal(0), z.literal(1)]).default(0),
  /** 1-based index into the slide's `sources`; shown as a small [n] marker when a slide cites several sources. */
  ref: z.number().int().min(1).max(6).optional(),
});
export type Bullet = z.infer<typeof Bullet>;

const base = {
  title: z.string().max(200),
  sources: z.array(SlideSourceRef).max(6).default([]),
  /** true when text is AI-written explanation rather than extracted from a source */
  aiWritten: z.boolean().default(false),
  /** Optional small label above the title (e.g. the chapter the slide belongs to). */
  kicker: z.string().max(80).optional(),
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
    /** The source itself marks these values as example/teaching data; rendered with a visible label. */
    isExample: z.boolean().optional(),
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
    /** Reporting period covered by the categories, e.g. "2021–2024". */
    period: z.string().max(60).optional(),
    /** The source itself marks these values as example/teaching data; rendered with a visible label. */
    isExample: z.boolean().optional(),
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
      /** Stable element name (e.g. "title", "body", "source") used for PPTX object names and render checks. */
      name?: string;
      role: "title" | "subtitle" | "body" | "caption" | "footer" | "label" | "big";
      x: number; y: number; w: number; h: number;
      paragraphs: TextParagraph[];
      fontFace: string; fontSizePt: number; color: string; bold?: boolean;
      align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom";
      lineSpacing: number;
      /** Color of bullet glyphs (defaults to the text color). Bullets hang by BULLET_INDENT_PT per level. */
      bulletColor?: string;
    }
  | {
      kind: "table"; x: number; y: number; w: number; h: number;
      columns: string[]; rows: string[][]; fontFace: string; fontSizePt: number;
      headerFill: string; headerColor: string; color: string; border: string; zebra?: string;
      colW: number[]; rowH: number;
      /** Exact row heights (header first) when rows differ; `rowH` is then the tallest body row. */
      rowHeights?: number[];
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
/** Hanging indent of one bullet level in points (level 1 is indented twice as far). */
export const BULLET_INDENT_PT = 22;

/** Evidence state of one slide as shown in the editor; never "verified" without a checked source. */
export const SlideEvidence = z.enum(["verified", "partial", "unverified", "not_applicable"]);
export type SlideEvidence = z.infer<typeof SlideEvidence>;

/** One planned slide (the outline shown before full generation). */
export const DeckOutlineItem = z.object({
  layout: z.enum(["title", "section", "agenda", "bullets", "two_column", "definition", "table", "chart", "questions", "references"]),
  title: z.string().min(1).max(200),
  /** The one main idea this slide must convey. */
  idea: z.string().max(400).default(""),
  /** Server-issued id of the planned slide; items the student adds themselves have none. */
  key: z.string().max(40).optional(),
});
export type DeckOutlineItem = z.infer<typeof DeckOutlineItem>;

const PageRange = z.object({ documentId: z.string().uuid(), from: z.number().int().min(1), to: z.number().int().min(1) });

export const CreateDeckRequest = z.object({
  title: z.string().max(200).optional(),
  settings: DeckSettings,
  documentIds: z.array(z.string().uuid()).max(10).default([]),
  pageRanges: z.array(PageRange).max(20).optional(),
  sectionIds: z.array(z.string().uuid()).max(50).optional(),
  /** false forces the extractive (no-AI) generator even when AI is configured. */
  useAi: z.boolean().optional(),
  /** true: only build the outline (status plan_ready); slides are generated later from the (edited) outline. */
  planOnly: z.boolean().default(false),
  workspaceId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(100),
});
export type CreateDeckRequest = z.infer<typeof CreateDeckRequest>;

export const SlideEdit = z.object({
  content: SlideContent,
  notes: z.string().max(8000).optional(),
  /** Revision the client edited; a different current revision returns 409 instead of overwriting. */
  revision: z.number().int().min(1),
});
export type SlideEdit = z.infer<typeof SlideEdit>;

export const ExportFormat = z.enum(["pptx", "pdf"]);
export type ExportFormat = z.infer<typeof ExportFormat>;
