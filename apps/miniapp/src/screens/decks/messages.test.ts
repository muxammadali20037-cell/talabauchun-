import { describe, expect, it } from "vitest";
import { LANGS, translate, type MessageKey } from "@talaba/shared";
import { codeMessage, warningText } from "./types";

/** Codes the deck API and jobs can return (apps/server/src/slides) and the export check names (verify.ts). */
const CHECKS = [
  "pptx_opens", "pptx_slide_count", "pptx_xml_valid", "pptx_text_editable", "pptx_charts_native", "pptx_tables_native",
  "pdf_opens", "pdf_page_count", "pdf_page_size_16x9", "pdf_fonts", "pdf_text_in_page", "pdf_text_in_boxes", "pdf_titles_present", "pdf_special_chars",
];
const CODES = [
  "deck_conflict", "slide_conflict", "slide_locked", "nothing_to_undo", "deck_needs_source", "deck_too_many_slides", "invalid_page_range", "deck_not_ready",
  "deck_not_plan_ready", "deck_has_no_sources", "reorder_mismatch", "no_source_text", "no_slides_generated", "slide_changed", "slide_deleted",
  "nothing_to_regenerate", "export_checks_failed", "checks_failed:pdf_text_in_boxes", "render_failed", "render_timeout", "renderer_missing",
  "pdf_not_produced", "deck_empty", "ai_rate_limited", "ai_timeout", "validation_error", "cancelled",
];

describe("Presentation Studio messages", () => {
  for (const lang of LANGS) {
    const t = (k: MessageKey, v?: Record<string, string | number>) => translate(lang, k, v);
    it(`${lang}: every export check and error code has its own message`, () => {
      for (const c of CHECKS) expect(t(`deck.check.${c}` as MessageKey)).not.toBe(`deck.check.${c}`);
      for (const c of CODES) expect(codeMessage(c, t, { max: 20 })).not.toBe(t("common.error"));
      expect(codeMessage("deck_too_many_slides", t, { max: 20 })).toContain("20");
      expect(codeMessage("something_new", t)).toBe(t("common.error"));
    });
    it(`${lang}: warnings carry their numbers; unknown warnings are not shown`, () => {
      const short = warningText("material_short:9/12", t)!;
      expect(short).toContain("9");
      expect(short).toContain("12");
      expect(warningText("citations_dropped:2", t)).toContain("2");
      expect(warningText("split_continuation@4", t)).toContain("4");
      expect(warningText("table_split@7", t)).toContain("7");
      expect(warningText("whatever", t)).toBeNull();
      for (const s of ["draft", "planning", "plan_ready", "generating", "ready", "failed"]) expect(t(`deck.status.${s}` as MessageKey)).not.toContain("deck.");
    });
  }
});
