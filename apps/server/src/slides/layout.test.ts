import { describe, expect, it } from "vitest";
import { SLIDE_H, SLIDE_W, type SlideContent } from "@talaba/shared";
import { contrastRatio, THEMES, themeContrastIssues } from "./themes";
import { fontFileFor, missingGlyphs, textWidth, wrapText, WIDTH_SAFETY } from "./measure";
import { layoutDeck, renderedPages } from "./layout";
import { uzTypography } from "./labels";
import { fixParagraphProps } from "./render-pptx";
import { goodSentence, sentenceToBullets, splitHeading, analyzeTable } from "./extractive";
import { splitSentences } from "./material";
import { slideEvidence } from "./store";

describe("themes", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("000000", "FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("FFFFFF", "FFFFFF")).toBeCloseTo(1, 5);
    expect(contrastRatio("4F46E5", "FFFFFF")).toBeGreaterThan(4.5);
    expect(contrastRatio("10B981", "FFFFFF")).toBeLessThan(3); // emerald-500 is not a text color on white
  });

  it("every text/background pair of every theme passes 4.5:1 (graphics 3:1)", () => {
    for (const t of Object.values(THEMES)) expect(themeContrastIssues(t)).toEqual([]);
  });

  it("uses only fonts with metric-compatible substitutes", () => {
    for (const t of Object.values(THEMES)) for (const f of [t.fonts.heading, t.fonts.body]) expect(["Arial", "Times New Roman"]).toContain(f);
  });
});

describe("text measurement", () => {
  it("measures with Liberation fonts that cover Uzbek Latin/Cyrillic and typographic quotes", () => {
    expect(fontFileFor("Arial")).toMatch(/LiberationSans-Regular\.ttf$/);
    expect(fontFileFor("Arial", true)).toMatch(/LiberationSans-Bold\.ttf$/);
    expect(fontFileFor("Times New Roman", true)).toMatch(/LiberationSerif-Bold\.ttf$/);
    const uz = "Oʻzbekiston gʻalla taʼlim ‘’ “” — – … ўқғҳ ЎҚҒҲ № %";
    for (const face of ["Arial", "Times New Roman"]) for (const bold of [false, true]) expect(missingGlyphs(uz, face, bold)).toEqual([]);
  });

  it("uses real advance widths (Arial ‘M’ is wider than ‘i’) and wraps within the box", () => {
    expect(textWidth("M", "Arial", 72)).toBeGreaterThan(textWidth("i", "Arial", 72) * 3);
    expect(textWidth("Hello", "Arial", 72)).toBeCloseTo(2.279, 2);
    const text = "Talab qonuniga koʻra, boshqa omillar oʻzgarmagan holda tovar narxi oshsa, unga boʻlgan talab miqdori kamayadi.";
    const lines = wrapText(text, 6, "Arial", 24);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(text);
    for (const l of lines) expect(textWidth(l, "Arial", 24)).toBeLessThanOrEqual(6 * WIDTH_SAFETY);
  });
});

const bullets = (n: number, words = 18): SlideContent => ({
  layout: "bullets",
  title: "Sinov",
  bullets: Array.from({ length: n }, (_, i) => ({ text: `${i + 1}. ` + "soʻz ".repeat(words).trim() + ".", level: 0 as const })),
  sources: [{ label: "kitob, sahifa 1", verified: true }],
  aiWritten: false,
});

describe("layout engine", () => {
  const theme = THEMES.academic;

  it("keeps every element on the slide and the source note below the content", () => {
    const slides: SlideContent[] = [
      { layout: "title", title: "Iqtisodiyot nazariyasi asoslari", subtitle: "Taqdimot", meta: ["Muallif: A. Valiyev"], sources: [], aiWritten: false },
      bullets(4),
      { layout: "definition", title: "Talab tushunchasi", term: "Talab", definition: "Talab — bu isteʼmolchilarning sotib olishga tayyor va qodir boʻlgan tovar miqdoridir.", sources: [{ label: "kitob, sahifa 2" }], aiWritten: false },
      { layout: "chart", title: "Narx indeksi", chartKind: "line", categories: ["2021", "2022"], series: [{ name: "Indeks", values: [100, 110] }], dataOrigin: "source_table", unit: "bazaviy yil = 100", isExample: true, sources: [{ label: "namuna" }], aiWritten: false },
      { layout: "table", title: "Jadval", columns: ["Yil", "Qiymat"], rows: [["2021", "100"]], sources: [{ label: "namuna" }], aiWritten: false },
    ];
    for (const t of Object.values(THEMES)) {
      const laid = layoutDeck(slides.map((content, i) => ({ id: `s${i}`, content, notes: "n" })), t);
      expect(laid).toHaveLength(slides.length);
      for (const s of laid) {
        for (const e of s.elements) {
          expect(e.x).toBeGreaterThanOrEqual(0);
          expect(e.y).toBeGreaterThanOrEqual(0);
          expect(e.x + e.w).toBeLessThanOrEqual(SLIDE_W + 1e-6);
          expect(e.y + e.h).toBeLessThanOrEqual(SLIDE_H + 1e-6);
          if (e.kind === "text" && e.role === "body") expect(e.fontSizePt).toBeGreaterThanOrEqual(t.sizes.bodyMin);
          if (e.kind === "text" && e.role === "footer") expect(e.fontSizePt).toBeGreaterThanOrEqual(12);
        }
        const source = s.elements.find((e) => e.kind === "text" && e.name === "source");
        if (source) {
          for (const e of s.elements) if (e !== source && e.kind !== "rect" && !(e.kind === "text" && e.name === "page")) expect(e.y + e.h).toBeLessThanOrEqual(source.y + 1e-6);
        }
      }
      const chart = laid[3]!;
      expect(chart.elements.some((e) => e.kind === "text" && e.name === "example_badge")).toBe(true);
    }
  });

  it("splits instead of shrinking below the minimum body size, with a continuation title", () => {
    expect(renderedPages(bullets(3), theme)).toBe(1);
    const parts = layoutDeck([{ id: "x", content: bullets(10, 25) }], theme);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[1]!.continuationOf).toBe("x");
    expect(parts.map((p) => p.renderIndex)).toEqual(parts.map((_, i) => i));
    const title = parts[1]!.elements.find((e) => e.kind === "text" && e.name === "title");
    expect(title?.kind === "text" && title.paragraphs[0]!.runs[0]!.text).toBe("Sinov (davomi)");
    for (const p of parts) {
      const body = p.elements.find((e) => e.kind === "text" && e.name === "body");
      expect(body?.kind === "text" && body.fontSizePt).toBeGreaterThanOrEqual(22);
      expect(body?.kind === "text" && body.paragraphs.every((x) => x.bullet)).toBe(true);
    }
  });

  it("splits long tables across slides and repeats the header", () => {
    const rows = Array.from({ length: 14 }, (_, i) => [String(2000 + i), "Juda uzun izoh matni ".repeat(3).trim()]);
    const parts = layoutDeck([{ id: "t", content: { layout: "table", title: "Uzun jadval", columns: ["Yil", "Izoh"], rows, sources: [], aiWritten: false } }], theme);
    expect(parts.length).toBeGreaterThan(1);
    const tables = parts.map((p) => p.elements.find((e) => e.kind === "table")!);
    expect(tables.flatMap((t) => (t.kind === "table" ? t.rows : [])).map((r) => r[0])).toEqual(rows.map((r) => r[0]));
    for (const t of tables) if (t.kind === "table") expect(t.columns).toEqual(["Yil", "Izoh"]);
  });
});

describe("content helpers", () => {
  it("normalises Uzbek apostrophes without touching quotes", () => {
    expect(uzTypography("o‘quv g'alla ta’lim ‘test’", "uz")).toBe("oʻquv gʻalla taʼlim ‘test’");
    expect(uzTypography("o'quv", "ru")).toBe("o'quv");
  });

  it("splits sentences but keeps decimals and turns colon lists into verbatim sub-bullets", () => {
    expect(splitSentences("Narx 2.5 foizga oshdi. Keyin pasaydi.")).toEqual(["Narx 2.5 foizga oshdi.", "Keyin pasaydi."]);
    expect(sentenceToBullets("Pul toʻrtta funksiyani bajaradi: ayirboshlash vositasi, qiymat oʻlchovi, jamgʻarish vositasi va toʻlov vositasi.")).toEqual([
      { text: "Pul toʻrtta funksiyani bajaradi:", level: 0 },
      { text: "ayirboshlash vositasi", level: 1 },
      { text: "qiymat oʻlchovi", level: 1 },
      { text: "jamgʻarish vositasi va toʻlov vositasi", level: 1 },
    ]);
    expect(goodSentence("2021 100 2022 110 2023 121 Jadval.")).toBe(false);
    expect(splitHeading("1-bob. Talab va taklif")).toEqual({ kicker: "1-bob", title: "Talab va taklif" });
    expect(splitHeading("2.3. Inflyatsiyani oʻlchash")).toEqual({ title: "Inflyatsiyani oʻlchash" });
  });

  it("recognises year columns, numeric series and example-data notes in tables", () => {
    const a = analyzeTable({ docId: "d", versionId: "v", docTitle: "namuna", filename: "n.xlsx", sheet: "S", columns: ["Yil", "Indeks", "Izoh"], rows: [[2021, 100, "Oʻquv misoli — haqiqiy statistika emas"], [2022, 110, "Oʻquv misoli — haqiqiy statistika emas"]], truncated: false, locator: { sheet: "S" } })!;
    expect(a).toMatchObject({ catCol: 0, numCols: [1], yearLike: true, isExample: true });
    const b = analyzeTable({ docId: "d", versionId: "v", docTitle: "hisobot", filename: null, sheet: "S", columns: ["Viloyat", "Aholi"], rows: [["A", 5], ["B", 7]], truncated: false, locator: {} })!;
    expect(b).toMatchObject({ catCol: 0, numCols: [1], yearLike: false, isExample: false });
  });

  it("never reports a slide without a checked source as verified", () => {
    const base = { title: "x", aiWritten: false } as const;
    expect(slideEvidence({ ...base, layout: "bullets", bullets: [{ text: "a", level: 0 }], sources: [] })).toBe("unverified");
    expect(slideEvidence({ ...base, layout: "bullets", bullets: [{ text: "a", level: 0 }], sources: [{ label: "Internet", verified: true }] })).toBe("unverified");
    const ref = "00000000-0000-4000-8000-000000000000";
    expect(slideEvidence({ ...base, layout: "bullets", bullets: [{ text: "a", level: 0, ref: 1 }, { text: "b", level: 0 }], sources: [{ label: "k", sourceRefId: ref, verified: true }, { label: "l" }] })).toBe("partial");
    expect(slideEvidence({ ...base, layout: "chart", chartKind: "bar", categories: ["a"], series: [{ name: "s", values: [1] }], dataOrigin: "user_input", sources: [{ label: "k", sourceRefId: ref, verified: true }] })).toBe("unverified");
    expect(slideEvidence({ ...base, layout: "title", meta: [], sources: [] })).toBe("not_applicable");
  });

  it("keeps a single paragraph-properties element per paragraph (pptxgenjs multi-run quirk)", () => {
    const xml = '<a:p><a:pPr marL="1"><a:buChar char="•"/></a:pPr><a:r><a:t>A</a:t></a:r><a:pPr indent="0" marL="0"><a:buNone/></a:pPr><a:r><a:t>B</a:t></a:r></a:p>';
    expect(fixParagraphProps(xml)).toBe('<a:p><a:pPr marL="1"><a:buChar char="•"/></a:pPr><a:r><a:t>A</a:t></a:r><a:r><a:t>B</a:t></a:r></a:p>');
  });
});
