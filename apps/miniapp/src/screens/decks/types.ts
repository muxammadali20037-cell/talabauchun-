import type { DeckOutlineItem, DeckSettings, LaidOutSlide, MessageKey, SlideContent, SlideEvidence, ThemeId } from "@talaba/shared";
import { ApiError } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { JobView } from "../../lib/jobs";

/** API shapes of /api/decks (see apps/server/src/slides/service.ts). Runtime constants are local so no schema code is bundled. */
export const SLIDE_W_IN = 13.333;
export const SLIDE_H_IN = 7.5;
export const BULLET_INDENT_PT = 22;
export const MAX_SLIDES = 20;
export const MIN_SLIDES = 4;

export type DeckStatus = "draft" | "planning" | "plan_ready" | "generating" | "ready" | "failed";
export type Role = "owner" | "editor" | "viewer";

export type SlideView = {
  id: string;
  position: number;
  revision: number;
  content: SlideContent;
  notes: string;
  updatedAt: string;
  updatedBy: string | null;
  lock: { lockedBy: string; lockedByName: string | null; byMe: boolean; expiresAt: string } | null;
  evidence: SlideEvidence;
  aiWritten: boolean;
  origin: { kind: string; mode: string } | null;
  renderIndexes: number[];
};

export type DeckDetail = {
  deck: {
    id: string; title: string; theme: ThemeId; status: DeckStatus; settings: DeckSettings; revision: number; role: Role; workspaceId: string;
    sourceDocumentIds: string[]; outline: DeckOutlineItem[] | null; createdAt: string; updatedAt: string;
    generation: { mode: "ai" | "extractive" | null; warnings: string[]; note: string | null; requested: number | null; produced: number | null; errorCode: string | null };
  };
  job: JobView | null;
  regenerations: { jobId: string; slideId: string | null; status: string; errorCode: string | null }[];
  slides: SlideView[];
  preview: { width: number; height: number; slides: LaidOutSlide[] };
  warnings: string[];
};

export type DeckListItem = { id: string; title: string; theme: ThemeId; status: DeckStatus; slides: number; revision: number; workspaceId: string; createdAt: string; updatedAt: string };

export type ExportItem = {
  id: string; format: "pptx" | "pdf"; status: "queued" | "rendering" | "ready" | "failed"; deckRevision: number; current: boolean; createdAt: string;
  error: string | null; bytes: number | null;
  checks: { ok: boolean | null; slideCount: number | null; items: { name: string; ok: boolean }[]; thumbnails: number };
  download: { url: string; filename: string; expiresAt: string } | null;
};

export type Estimate = { credits: number; ai: boolean; aiAvailable: boolean; balance: number; regenerateCredits: number; exportCredits: number };

type T = (k: MessageKey, v?: Record<string, string | number>) => string;

const KNOWN_ERRORS = new Set([
  "deck_conflict", "slide_conflict", "slide_locked", "nothing_to_undo", "deck_needs_source", "deck_too_many_slides", "invalid_page_range", "deck_not_ready",
  "deck_not_plan_ready", "deck_has_no_sources", "reorder_mismatch", "no_source_text", "no_slides_generated", "slide_changed", "slide_deleted",
  "nothing_to_regenerate", "export_checks_failed", "render_failed", "render_timeout", "renderer_missing", "deck_empty", "cancelled",
]);

/** Message for a stable error code (API error, job error code or export error). Unknown codes fall back to the generic text. */
export function codeMessage(code: string | null | undefined, t: T, details?: Record<string, unknown>): string {
  if (!code) return t("common.error");
  const c = code.startsWith("checks_failed") ? "export_checks_failed" : code === "pdf_not_produced" ? "render_failed" : code;
  if (c.startsWith("ai_")) return t("deck.err.ai_unavailable");
  if (c === "validation_error") return t("deck.err.validation");
  if (KNOWN_ERRORS.has(c)) return t(`deck.err.${c}` as MessageKey, { max: Number(details?.max ?? MAX_SLIDES) });
  return t("common.error");
}

/** API errors with deck-specific codes get deck messages; everything else (offline, credits…) the shared mapping. */
export function deckError(e: unknown, t: T): string {
  if (e instanceof ApiError && (KNOWN_ERRORS.has(e.code) || e.code === "validation_error" || e.code.startsWith("ai_"))) return codeMessage(e.code, t, e.details);
  return errorMessage(e, t);
}

/** Human text for generation and layout warnings ("material_short:9/12", "split_continuation@4"). */
export function warningText(w: string, t: T): string | null {
  const [head, at] = w.split("@");
  const page = Number(at ?? 0);
  const [code, arg] = (head ?? "").split(":");
  switch (code) {
    case "material_short": {
      const [produced, requested] = (arg ?? "").split("/");
      return t("deck.warn.material_short", { produced: produced ?? "?", requested: requested ?? "?" });
    }
    case "citations_dropped":
      return t("deck.warn.citations_dropped", { n: arg ?? "?" });
    case "slides_not_written":
      return t("deck.warn.slides_not_written", { n: arg ?? "?" });
    case "split_continuation":
    case "split_columns":
      return t("deck.warn.split", { n: page });
    case "table_split":
      return t("deck.warn.table_split", { n: page });
    case "title_clamped":
      return t("deck.warn.title_clamped", { n: page });
    case "table_as_text":
      return t("deck.warn.table_as_text", { n: page });
    case "source_note_clamped":
      return t("deck.warn.source_note_clamped", { n: page });
    default:
      return null;
  }
}

export function formatDate(iso: string, lang: string) {
  try {
    return new Intl.DateTimeFormat(lang === "uz-Cyrl" ? "uz-Cyrl" : lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export const THEME_KEYS: Record<ThemeId, MessageKey> = { academic: "deck.themeAcademic", data: "deck.themeData", creative: "deck.themeCreative" };
/** Swatches shown on the theme picker (the real colours of each design). */
export const THEME_SWATCH: Record<ThemeId, [string, string, string]> = {
  academic: ["#1e1b4b", "#4f46e5", "#eef2ff"],
  data: ["#0f172a", "#0f766e", "#ecfdf5"],
  creative: ["#4338ca", "#be123c", "#fff1f2"],
};

export const STATUS_KIND: Record<DeckStatus, "neutral" | "primary" | "success" | "warn" | "danger"> = {
  draft: "neutral", planning: "primary", plan_ready: "warn", generating: "primary", ready: "success", failed: "danger",
};
