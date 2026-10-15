import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SlideContent } from "@talaba/shared";
import type { Deps } from "../src/deps";
import { AiClient } from "../src/ai/client";
import { buildApp } from "../src/http/app";
import { createSession } from "../src/auth/sessions";
import { DEFAULT_PRICING, estimateCredits, getBalance } from "../src/billing/credits";
import { createDocumentFromFile } from "../src/ingest/documents";
import { getJob } from "../src/jobs/queue";
import * as decks from "../src/slides/service";
import { renderDeck } from "../src/slides/generate";
import { getTheme } from "../src/slides/themes";
import { pdfWords, pptxChartData, pptxSlideTexts } from "../src/slides/verify";
import { createTestDeps, makeUser } from "./helpers/deps";
import { fixture, sourceFixture } from "./helpers/fixtures";
import { anthropicStub } from "./helpers/ai-stub";
import { testWorker } from "./helpers/worker";

let deps: Deps;
let cleanup: () => Promise<void>;
const here = path.dirname(fileURLToPath(import.meta.url));
/** Set SAVE_SLIDES_EVIDENCE=1 to write the rendered samples to docs/evidence/slides. */
const EVIDENCE = process.env.SAVE_SLIDES_EVIDENCE === "1" ? path.resolve(here, "../../../docs/evidence/slides") : null;

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
});
afterAll(async () => cleanup());

type User = Awaited<ReturnType<typeof makeUser>>;

async function upload(user: User, filename: string, data: Buffer) {
  const r = await createDocumentFromFile(deps, { user, filename, data, via: "miniapp" });
  await testWorker(deps).drain();
  return r.documentId;
}
const bookFor = (user: User) => upload(user, "iqtisodiyot.pdf", fixture("iqtisodiyot.pdf"));

async function readExport(user: User, deckId: string, format: "pptx" | "pdf") {
  const list = await decks.listExports(deps, user, deckId);
  const item = list.items.find((e) => e.format === format && e.current)!;
  expect(item.status).toBe("ready");
  expect(item.download?.url).toMatch(/^\/files\/[0-9a-f-]+\/[0-9a-f-]+\.(pptx|pdf)\?name=.+&exp=\d+&sig=[0-9a-f]{64}$/);
  const u = new URL(item.download!.url, "https://x.test");
  const key = u.pathname.replace(/^\/files\//, "");
  expect(deps.storage.verify(key, u.searchParams.get("name")!, Number(u.searchParams.get("exp")), u.searchParams.get("sig")!)).toBe(true);
  return { item, file: await deps.storage.get(key) };
}

function pdfInfoPages(file: Buffer): number {
  const dir = mkdtempSync(path.join(tmpdir(), "talaba-pdfcheck-"));
  try {
    writeFileSync(path.join(dir, "d.pdf"), file);
    return Number(/^Pages:\s+(\d+)/m.exec(execFileSync("pdfinfo", [path.join(dir, "d.pdf")], { encoding: "utf8" }))![1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pdfPages(file: Buffer) {
  const dir = mkdtempSync(path.join(tmpdir(), "talaba-pdfcheck-"));
  try {
    writeFileSync(path.join(dir, "d.pdf"), file);
    return await pdfWords(path.join(dir, "d.pdf"), "pdftotext");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes the sample files and 80 dpi PNG renders of every page for manual review. */
function saveEvidence(name: string, pptx: Buffer, pdf: Buffer) {
  if (!EVIDENCE) return;
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, `${name}.pptx`), pptx);
  writeFileSync(path.join(EVIDENCE, `${name}.pdf`), pdf);
  const pngDir = path.join(EVIDENCE, `${name}-png`);
  rmSync(pngDir, { recursive: true, force: true });
  mkdirSync(pngDir, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir(), "talaba-ev-"));
  writeFileSync(path.join(tmp, "d.pdf"), pdf);
  execFileSync("pdftoppm", ["-r", "80", "-png", path.join(tmp, "d.pdf"), path.join(tmp, "slide")]);
  for (const f of readdirSync(tmp).filter((x) => x.endsWith(".png"))) copyFileSync(path.join(tmp, f), path.join(pngDir, f));
  rmSync(tmp, { recursive: true, force: true });
}

const bulletTexts = (c: SlideContent) => (c.layout === "bullets" ? c.bullets.map((b) => b.text) : c.layout === "two_column" ? [...c.left.bullets, ...c.right.bullets].map((b) => b.text) : []);

describe("Presentation Studio — extractive mode (no AI configured)", () => {
  it("acceptance 11: 12-slide deck from the book → edit → regenerate one slide → reorder → undo → editable PPTX + PDF", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const balance0 = await getBalance(deps.sql, user.id);
    const created = await decks.createDeck(deps, user, {
      settings: { topic: "Iqtisodiyot nazariyasi asoslari", slideCount: 12, author: "Aliyev Vali", group: "IQ-21", language: "uz" },
      documentIds: [docId],
      idempotencyKey: "deck-acceptance-11",
    });
    // a double tap does not create a second deck or a second debit
    const again = await decks.createDeck(deps, user, { settings: { topic: "Iqtisodiyot nazariyasi asoslari" }, documentIds: [docId], idempotencyKey: "deck-acceptance-11" });
    expect(again).toMatchObject({ deckId: created.deckId, duplicate: true });
    await testWorker(deps).drain();
    const deckId = created.deckId;
    let view = await decks.getDeck(deps, user, deckId);
    expect(view.deck.status).toBe("ready");
    expect(view.job?.status).toBe("completed");
    expect(view.deck.generation.mode).toBe("extractive");
    expect(view.slides).toHaveLength(12);
    // nothing had to be split: the preview (= export model) has exactly 12 slides
    expect(view.preview.slides).toHaveLength(12);
    expect(created.credits).toBe(estimateCredits(DEFAULT_PRICING, { kind: "deck", slides: 12, ai: false }));
    expect(balance0 - (await getBalance(deps.sql, user.id))).toBe(created.credits);

    // flow: title first, questions + references last; every content slide cites a checked source
    const layouts = view.slides.map((s) => s.content.layout);
    expect(layouts[0]).toBe("title");
    expect(layouts.slice(-2)).toEqual(["questions", "references"]);
    expect(layouts).toContain("agenda");
    expect(layouts).toContain("definition");
    const facts = view.slides.filter((s) => s.evidence !== "not_applicable");
    expect(facts.length).toBeGreaterThanOrEqual(6);
    for (const s of facts) {
      expect(s.evidence).toBe("verified");
      expect(s.content.aiWritten).toBe(false);
      expect(s.content.sources.length).toBeGreaterThan(0);
      expect(s.content.sources[0]!.label).toMatch(/^iqtisodiyot, sahifa \d/);
    }
    // every bullet is a sentence (or verbatim list item) of the book: check against the stored quote
    for (const s of facts) {
      for (const src of s.content.sources) {
        const [ref] = await deps.sql<{ quote: string; verification: string }[]>`select quote, verification from source_references where id = ${src.sourceRefId!}`;
        expect(ref!.verification).toBe("exact_quote");
      }
      for (const t of bulletTexts(s.content)) expect(t.split(/\s+/).length).toBeLessThanOrEqual(30);
    }
    // speaker notes carry the full source sentences
    expect(facts.every((s) => s.notes.includes("Manbadagi matn"))).toBe(true);
    // references: only real document metadata (author from the PDF), no invented year/DOI/publisher
    const refsSlide = view.slides.find((s) => s.content.layout === "references")!.content as Extract<SlideContent, { layout: "references" }>;
    expect(refsSlide.items).toEqual(["iqtisodiyot / TALABA AI test materiali. — iqtisodiyot.pdf, 5 bet."]);
    expect(JSON.stringify(view.slides)).not.toMatch(/doi|ISBN|https?:\/\//i);
    // Uzbek typography: oʻ/gʻ with U+02BB in slide text
    expect(JSON.stringify(view.slides.map((s) => s.content))).toContain("oʻ");

    // ── edit one slide (Uzbek Latin ʻ ʼ + Cyrillic) ──
    const chapter = view.slides.find((s) => s.content.layout === "bullets" && s.origin?.kind === "chapter")!;
    const editedContent = { ...chapter.content, bullets: [{ text: "Oʻzbekistonda taʼlim va gʻalla: ўқғҳ — kirill harflari ham buzilmaydi.", level: 0 as const }, ...(chapter.content as Extract<SlideContent, { layout: "bullets" }>).bullets.slice(1)] } as SlideContent;
    const edited = await decks.updateSlide(deps, user, deckId, chapter.id, { content: editedContent, notes: "Tahrirlangan nutq", revision: chapter.revision });
    expect(edited.slide.revision).toBe(chapter.revision + 1);
    expect(bulletTexts(edited.slide.content)[0]).toContain("ўқғҳ");
    // the new first bullet is not in the source any more: the slide is no longer fully verified
    expect(edited.slide.evidence).not.toBe("verified");
    // a stale revision is rejected, never silently overwritten
    await expect(decks.updateSlide(deps, user, deckId, chapter.id, { content: chapter.content, revision: chapter.revision })).rejects.toMatchObject({ status: 409, code: "slide_conflict" });

    // ── regenerate exactly one other slide ──
    view = await decks.getDeck(deps, user, deckId);
    const target = view.slides.find((s) => s.id !== chapter.id && s.origin?.kind === "chapter")!;
    const before = new Map(view.slides.map((s) => [s.id, { revision: s.revision, content: JSON.stringify(s.content), notes: s.notes }]));
    const balance1 = await getBalance(deps.sql, user.id);
    const regen = await decks.regenerateSlide(deps, user, deckId, target.id, {});
    expect(regen.credits).toBe(estimateCredits(DEFAULT_PRICING, { kind: "slide_regen", ai: false }));
    await testWorker(deps).drain();
    expect((await getJob(deps.sql, regen.jobId))!.status).toBe("completed");
    view = await decks.getDeck(deps, user, deckId);
    for (const s of view.slides) {
      if (s.id === target.id) continue;
      expect({ revision: s.revision, content: JSON.stringify(s.content), notes: s.notes }).toEqual(before.get(s.id));
    }
    const regenerated = view.slides.find((s) => s.id === target.id)!;
    expect(regenerated.revision).toBe(before.get(target.id)!.revision + 1);
    expect(regenerated.evidence).toBe("verified");
    // only the single-slide price was charged (0 in extractive mode), not the deck price
    expect(balance1 - (await getBalance(deps.sql, user.id))).toBe(regen.credits);
    const hist = await decks.slideHistory(deps, user, deckId, target.id);
    expect(hist.items.map((h) => h.changeKind)).toEqual(["regenerate", "create"]);

    // ── reorder ──
    const order = view.slides.map((s) => s.id);
    const swapped = [...order];
    [swapped[3], swapped[4]] = [swapped[4]!, swapped[3]!];
    const ro = await decks.reorderSlides(deps, user, deckId, { slideIds: swapped });
    expect(ro.revision).toBeGreaterThan(view.deck.revision);
    await expect(decks.reorderSlides(deps, user, deckId, { slideIds: swapped.slice(1) })).rejects.toMatchObject({ code: "reorder_mismatch" });
    view = await decks.getDeck(deps, user, deckId);
    expect(view.slides.map((s) => s.id)).toEqual(swapped);
    await decks.reorderSlides(deps, user, deckId, { slideIds: order, revision: view.deck.revision });
    await expect(decks.reorderSlides(deps, user, deckId, { slideIds: swapped, revision: view.deck.revision })).rejects.toMatchObject({ status: 409, code: "deck_conflict" });
    view = await decks.getDeck(deps, user, deckId);
    expect(view.slides.map((s) => s.id)).toEqual(order);

    // ── edit another slide, then undo it ──
    const other = view.slides.find((s) => s.content.layout === "definition")!;
    const changed = { ...other.content, title: other.content.title + " (qoralama)" } as SlideContent;
    await decks.updateSlide(deps, user, deckId, other.id, { content: changed, revision: other.revision });
    const undone = await decks.undoSlide(deps, user, deckId, other.id);
    expect(undone.slide.content).toEqual(other.content);
    expect(undone.slide.revision).toBe(other.revision + 2);
    expect((await decks.slideHistory(deps, user, deckId, other.id)).items.map((h) => h.changeKind)).toEqual(["restore", "edit", "create"]);
    // a second undo walks further back: there is nothing before "create"
    await expect(decks.undoSlide(deps, user, deckId, other.id)).rejects.toMatchObject({ code: "nothing_to_undo" });

    // ── export PPTX + PDF ──
    const e1 = await decks.createExport(deps, user, deckId, { format: "pptx" });
    const e2 = await decks.createExport(deps, user, deckId, { format: "pdf" });
    expect((await decks.createExport(deps, user, deckId, { format: "pdf" })).exportId).toBe(e2.exportId); // no duplicate render
    await testWorker(deps).drain();
    expect((await getJob(deps.sql, e1.jobId!))!.status).toBe("completed");
    const pptx = await readExport(user, deckId, "pptx");
    const pdf = await readExport(user, deckId, "pdf");
    for (const x of [pptx, pdf]) {
      expect(x.item.checks.ok).toBe(true);
      expect(x.item.checks.slideCount).toBe(12);
    }
    // PPTX opens, 12 slides, every slide has real editable text, nothing rasterised, notes kept
    const zip = await JSZip.loadAsync(pptx.file);
    const slideParts = Object.keys(zip.files).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slideParts).toHaveLength(12);
    for (const p of slideParts) {
      const xml = await zip.file(p)!.async("string");
      expect(xml).toMatch(/<a:t>[^<]+<\/a:t>/);
      expect(xml).not.toMatch(/<p:pic\b/);
    }
    const texts = await pptxSlideTexts(pptx.file);
    const editedIndex = view.slides.findIndex((s) => s.id === chapter.id);
    expect(texts[editedIndex]).toContain("Oʻzbekistonda taʼlim va gʻalla: ўқғҳ");
    expect(Object.keys(zip.files).filter((p) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(p)).length).toBe(12);
    const notesXml = await zip.file(`ppt/notesSlides/notesSlide${editedIndex + 1}.xml`)!.async("string");
    expect(notesXml).toContain("Tahrirlangan nutq");
    const core = await zip.file("docProps/core.xml")!.async("string");
    expect(core).toContain("Iqtisodiyot nazariyasi asoslari");
    expect(core).toContain("Aliyev Vali");
    // bullets are real bullet paragraphs
    const chapterXml = await zip.file(`ppt/slides/slide${editedIndex + 1}.xml`)!.async("string");
    expect(chapterXml).toMatch(/<a:buChar /);

    // PDF: page count = slide count, 16:9, all words inside the page, Uzbek ʻ/ʼ and Cyrillic preserved
    expect(pdfInfoPages(pdf.file)).toBe(12);
    const pages = await pdfPages(pdf.file);
    expect(pages).toHaveLength(12);
    for (const pg of pages) {
      expect(Math.round(pg.width)).toBe(960);
      expect(Math.round(pg.height)).toBe(540);
      for (const w of pg.words) {
        expect(w.xMin).toBeGreaterThanOrEqual(0);
        expect(w.yMin).toBeGreaterThanOrEqual(0);
        expect(w.xMax).toBeLessThanOrEqual(pg.width);
        expect(w.yMax).toBeLessThanOrEqual(pg.height);
      }
    }
    const editedPage = pages[editedIndex]!.words.map((w) => w.text).join(" ");
    expect(editedPage).toContain("Oʻzbekistonda");
    expect(editedPage).toContain("taʼlim");
    expect(editedPage).toContain("ўқғҳ");
    const checkNames = (pdf.item.checks.items as { name: string; ok: boolean }[]).filter((c) => c.ok).map((c) => c.name);
    expect(checkNames).toEqual(expect.arrayContaining(["pptx_text_editable", "pdf_page_count", "pdf_fonts", "pdf_text_in_page", "pdf_text_in_boxes", "pdf_special_chars"]));
    const [artifacts] = await deps.sql<{ n: number }[]>`select count(*)::int as n from artifact_versions av join artifacts a on a.id = av.artifact_id where a.target_id = ${deckId}`;
    expect(artifacts!.n).toBe(2);
    saveEvidence("sample-12", pptx.file, pdf.file);
    if (EVIDENCE) {
      // the same content in the other two designs (only the layout changes)
      for (const theme of ["data", "creative"] as const) {
        const r = await renderDeck(deps, { title: view.deck.title, theme, settings: view.deck.settings }, view.slides, "pdf", { thumbnails: false });
        expect(r.checks.ok).toBe(true);
        saveEvidence(`sample-12-${theme}`, r.pptx, r.pdf!);
      }
    }
  });

  it("acceptance 12: chart values, unit and period match the source table exactly; example data is labelled", async () => {
    const user = await makeUser(deps);
    const xlsx = await upload(user, "namuna.xlsx", fixture("namuna.xlsx"));
    const csv = await upload(user, "namuna-statistika.csv", sourceFixture("namuna-statistika.csv"));
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Narx indeksi dinamikasi (namuna)", slideCount: 6, theme: "data" }, documentIds: [xlsx, csv], idempotencyKey: "deck-acceptance-12" });
    await testWorker(deps).drain();
    let view = await decks.getDeck(deps, user, deckId);
    expect(view.deck.status).toBe("ready");
    const chart = view.slides.find((s) => s.content.layout === "chart")!;
    const c = chart.content as Extract<SlideContent, { layout: "chart" }>;
    expect(c.categories).toEqual(["2021", "2022", "2023", "2024"]);
    expect(c.series).toHaveLength(1);
    expect(c.series[0]!.values).toEqual([100, 110, 121, 130]);
    expect(c.unit).toBe("bazaviy yil = 100");
    expect(c.period).toBe("2021–2024");
    expect(c.dataOrigin).toBe("source_table");
    expect(c.isExample).toBe(true);
    expect(c.takeaway).toBe("Oʻzgarish 2021–2024: 100 dan 130 gacha (+30; +30%)");
    // both files that hold this table are cited (the identical CSV copy is not drawn twice)
    expect(c.sources.map((x) => x.label)).toEqual(["namuna, varaq “Namuna”", "namuna-statistika.csv"]);
    expect(chart.evidence).toBe("verified");
    const [ref] = await deps.sql<{ verification: string; quote: string }[]>`select verification, quote from source_references where id = ${c.sources[0]!.sourceRefId!}`;
    expect(ref!.verification).toBe("table_value");
    expect(ref!.quote).toContain("2024 | 130");
    // identical CSV and XLSX copies give one chart, not two
    expect(view.slides.filter((s) => s.content.layout === "chart")).toHaveLength(1);
    const table = view.slides.find((s) => s.content.layout === "table")!.content as Extract<SlideContent, { layout: "table" }>;
    expect(table.rows.map((r) => r[1])).toEqual(["100", "110", "121", "130"]);
    expect(table.isExample).toBe(true);
    // the deck is shorter than requested instead of padded with invented slides
    expect(view.slides.length).toBeLessThan(6);
    expect(view.deck.generation.warnings.some((w) => w.startsWith("material_short"))).toBe(true);

    // a fact the student types without a source is not shown as verified
    const added = await decks.addSlide(deps, user, deckId, { content: { layout: "bullets", title: "Mening xulosam", bullets: [{ text: "Narxlar 2025-yilda ham oʻsadi.", level: 0 }], sources: [{ label: "Internet", verified: true }] } });
    expect(added.slide.evidence).toBe("unverified");
    expect(added.slide.content.sources[0]!.verified).toBe(false);
    // changing a chart number makes it the student's data, no longer "from the source table"
    view = await decks.getDeck(deps, user, deckId);
    const ch = view.slides.find((s) => s.content.layout === "chart")!;
    const tampered = { ...ch.content, series: [{ ...c.series[0]!, values: [100, 110, 121, 140] }] } as SlideContent;
    const t1 = await decks.updateSlide(deps, user, deckId, ch.id, { content: tampered, revision: ch.revision });
    expect((t1.slide.content as Extract<SlideContent, { layout: "chart" }>).dataOrigin).toBe("user_input");
    expect(t1.slide.evidence).toBe("unverified");
    await decks.undoSlide(deps, user, deckId, ch.id);
    await decks.deleteSlide(deps, user, deckId, added.slide.id);
    view = await decks.getDeck(deps, user, deckId);
    const restored = view.slides.find((s) => s.id === ch.id)!;
    expect((restored.content as Extract<SlideContent, { layout: "chart" }>).dataOrigin).toBe("source_table");
    expect(restored.evidence).toBe("verified");

    await decks.createExport(deps, user, deckId, { format: "pptx" });
    await decks.createExport(deps, user, deckId, { format: "pdf" });
    await testWorker(deps).drain();
    const pptx = await readExport(user, deckId, "pptx");
    const pdf = await readExport(user, deckId, "pdf");
    // the native chart in the PPTX holds exactly the source numbers and categories
    const charts = await pptxChartData(pptx.file);
    expect(charts).toHaveLength(1);
    expect(charts[0]!.categories).toEqual(["2021", "2022", "2023", "2024"]);
    expect(charts[0]!.series).toEqual([{ name: "Narx indeksi (bazaviy yil = 100)", values: [100, 110, 121, 130] }]);
    const texts = (await pptxSlideTexts(pptx.file)).join("\n");
    for (const s of ["Namuna maʼlumot — haqiqiy statistika emas", "Birlik: bazaviy yil = 100", "Davr: 2021–2024", "Manbalar: [1] namuna, varaq “Namuna”; [2] namuna-statistika.csv", "Oʻzgarish 2021–2024: 100 dan 130 gacha (+30; +30%)"]) expect(texts).toContain(s);
    const pdfText = (await pdfPages(pdf.file)).map((p) => p.words.map((w) => w.text).join(" ")).join("\n");
    for (const s of ["Namuna", "maʼlumot", "2021–2024", "130"]) expect(pdfText).toContain(s);
    saveEvidence("sample-stats", pptx.file, pdf.file);
  });

  it("switching the theme keeps every slide's content and re-lays it out without AI", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Inflyatsiya", slideCount: 8 }, documentIds: [docId], idempotencyKey: "deck-theme-0001" });
    await testWorker(deps).drain();
    const a = await decks.getDeck(deps, user, deckId);
    for (const theme of ["data", "creative", "academic"] as const) {
      const r = await decks.updateDeck(deps, user, deckId, { theme });
      expect(r.theme).toBe(theme);
      const b = await decks.getDeck(deps, user, deckId);
      expect(b.slides.map((s) => [s.id, s.revision, s.content, s.notes])).toEqual(a.slides.map((s) => [s.id, s.revision, s.content, s.notes]));
      // generated slides fit on one page in every theme
      expect(b.preview.slides).toHaveLength(a.slides.length);
      const content = b.preview.slides.find((p) => b.slides.find((x) => x.id === p.slideId)!.content.layout === "bullets")!;
      expect(content.background).toBe(getTheme(theme).colors.bg);
    }
    const jobs = await deps.sql<{ n: number }[]>`select count(*)::int as n from generation_jobs where target_id = ${deckId}`;
    expect(jobs[0]!.n).toBe(1);
  });

  it("splits overflowing content onto a continuation slide instead of shrinking text", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Talab", slideCount: 5 }, documentIds: [docId], idempotencyKey: "deck-split-0001" });
    await testWorker(deps).drain();
    const view = await decks.getDeck(deps, user, deckId);
    const long = Array.from({ length: 9 }, (_, i) => ({ text: `${i + 1}-fikr: talab qonuniga koʻra boshqa omillar oʻzgarmagan holda tovar narxi oshsa, unga boʻlgan talab miqdori kamayadi va bu holat egri chiziqda koʻrinadi.`, level: 0 as const }));
    const r = await decks.addSlide(deps, user, deckId, { content: { layout: "bullets", title: "Uzun roʻyxat", bullets: long, sources: [] }, afterSlideId: view.slides[0]!.id });
    expect(r.preview.length).toBeGreaterThan(1);
    expect(r.preview[1]!.continuationOf).toBe(r.slide.id);
    expect(r.preview[0]!.warnings).toContain("split_continuation");
    for (const p of r.preview) {
      const body = p.elements.find((e) => e.kind === "text" && e.name === "body")!;
      expect(body.kind === "text" && body.fontSizePt).toBeGreaterThanOrEqual(22);
      const title = p.elements.find((e) => e.kind === "text" && e.name === "title");
      expect(title && title.kind === "text" && title.paragraphs[0]!.runs[0]!.text).toMatch(p.continuationOf ? /\(davomi\)$/ : /^Uzun roʻyxat$/);
    }
    // the export model and the preview are the same: the PDF has the continuation page too
    const all = await decks.getDeck(deps, user, deckId);
    const rendered = await renderDeck(deps, { title: "x", theme: "academic", settings: all.deck.settings }, all.slides, "pdf", { thumbnails: false });
    expect(rendered.slideCount).toBe(all.preview.slides.length);
    expect(rendered.checks.ok).toBe(true);
  });

  it("permissions: viewers read and export but cannot edit; other accounts get 404; edit locks expire", async () => {
    const owner = await makeUser(deps);
    const editor = await makeUser(deps);
    const viewer = await makeUser(deps);
    const stranger = await makeUser(deps);
    const [ws] = await deps.sql<{ id: string }[]>`insert into workspaces (name, kind, owner_id) values ('Guruh 21', 'group', ${owner.id}) returning id`;
    await deps.sql`insert into memberships (workspace_id, user_id, role) values (${ws!.id}, ${owner.id}, 'owner'), (${ws!.id}, ${editor.id}, 'editor'), (${ws!.id}, ${viewer.id}, 'viewer')`;
    const docId = await bookFor(owner);
    const { deckId } = await decks.createDeck(deps, owner, { settings: { topic: "Pul va bank", slideCount: 6 }, documentIds: [docId], workspaceId: ws!.id, idempotencyKey: "deck-perm-0001" });
    await testWorker(deps).drain();
    const view = await decks.getDeck(deps, viewer, deckId);
    expect(view.deck.role).toBe("viewer");
    const s = view.slides[1]!;
    await expect(decks.updateSlide(deps, viewer, deckId, s.id, { content: s.content, revision: s.revision })).rejects.toMatchObject({ status: 403 });
    await expect(decks.regenerateSlide(deps, viewer, deckId, s.id, {})).rejects.toMatchObject({ status: 403 });
    await expect(decks.reorderSlides(deps, viewer, deckId, { slideIds: view.slides.map((x) => x.id) })).rejects.toMatchObject({ status: 403 });
    const ex = await decks.createExport(deps, viewer, deckId, { format: "pptx" });
    expect(ex.status).toBe("queued");
    for (const fn of [() => decks.getDeck(deps, stranger, deckId), () => decks.listExports(deps, stranger, deckId), () => decks.createExport(deps, stranger, deckId, { format: "pdf" }), () => decks.slideHistory(deps, stranger, deckId, s.id)]) {
      await expect(fn()).rejects.toMatchObject({ status: 404 });
    }
    expect((await decks.listDecks(deps, stranger)).items).toEqual([]);
    expect((await decks.listDecks(deps, viewer)).items.map((d) => d.id)).toContain(deckId);

    // the owner holds an edit lock: the editor gets 409 until it is released or expires
    await decks.lockSlide(deps, owner, deckId, s.id);
    await expect(decks.updateSlide(deps, editor, deckId, s.id, { content: s.content, revision: s.revision })).rejects.toMatchObject({ status: 409, code: "slide_locked" });
    const locked = (await decks.getDeck(deps, editor, deckId)).slides[1]!;
    expect(locked.lock).toMatchObject({ lockedBy: owner.id, byMe: false });
    await deps.sql`update slides set lock_expires_at = now() - interval '1 second' where id = ${s.id}`;
    const ok = await decks.updateSlide(deps, editor, deckId, s.id, { content: s.content, revision: s.revision });
    expect(ok.slide.revision).toBe(s.revision + 1);
    // concurrent edit from the owner based on the old revision → 409 with the current version
    await expect(decks.updateSlide(deps, owner, deckId, s.id, { content: s.content, revision: s.revision })).rejects.toMatchObject({ status: 409, code: "slide_conflict", details: { currentRevision: s.revision + 1 } });
  });

  it("plans first, then builds the deck from the edited outline", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Iqtisodiyot", slideCount: 8 }, documentIds: [docId], planOnly: true, idempotencyKey: "deck-plan-0001" });
    await testWorker(deps).drain();
    let view = await decks.getDeck(deps, user, deckId);
    expect(view.deck.status).toBe("plan_ready");
    expect(view.slides).toHaveLength(0);
    const outline = view.deck.outline as { layout: string; title: string; idea: string; key?: string }[];
    expect(outline.length).toBe(8);
    // drop one planned slide and add one of our own
    const edited = [...outline.filter((_, i) => i !== 2), { layout: "bullets", title: "Markaziy bank va inflyatsiya", idea: "asosiy stavka" }];
    await decks.generateFromOutline(deps, user, deckId, { outline: edited, idempotencyKey: "deck-plan-gen-01" });
    await testWorker(deps).drain();
    view = await decks.getDeck(deps, user, deckId);
    expect(view.deck.status).toBe("ready");
    expect(view.slides.map((s) => s.content.title)).toEqual(edited.map((o) => o.title));
    const own = view.slides[view.slides.length - 1]!;
    expect(bulletTexts(own.content).join(" ")).toMatch(/Markaziy bank|stavka/);
    expect(own.evidence).toBe("verified");
  });

  it("an export whose renderer fails ends as failed with a clear code and never offers a file", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Bank", slideCount: 5 }, documentIds: [docId], idempotencyKey: "deck-brokenlo-1" });
    await testWorker(deps).drain();
    const broken = { ...deps, cfg: { ...deps.cfg, LIBREOFFICE_BIN: "/bin/false" } };
    const ex = await decks.createExport(broken, user, deckId, { format: "pdf" });
    for (let i = 0; i < 3; i++) {
      await testWorker(broken).drain();
      await deps.sql`update generation_jobs set run_after = now() where id = ${ex.jobId!}`; // skip the retry back-off
    }
    const job = (await getJob(deps.sql, ex.jobId!))!;
    expect(job.status).toBe("failed");
    expect(job.error_code).toBe("render_failed");
    const item = (await decks.listExports(deps, user, deckId)).items.find((e) => e.id === ex.exportId)!;
    expect(item).toMatchObject({ status: "failed", error: "render_failed", download: null });
    const [arts] = await deps.sql<{ n: number }[]>`select count(*)::int as n from artifacts where target_id = ${deckId}`;
    expect(arts!.n).toBe(0);
    // a later export with a working renderer succeeds (the failed row does not block it)
    const ok = await decks.createExport(deps, user, deckId, { format: "pdf" });
    expect(ok.exportId).not.toBe(ex.exportId);
  });

  it("creates a draft quiz from the deck's source material", async () => {
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const { deckId } = await decks.createDeck(deps, user, { settings: { topic: "Iqtisodiyot", slideCount: 6 }, documentIds: [docId], idempotencyKey: "deck-quiz-00001" });
    await testWorker(deps).drain();
    const q = await decks.quizFromDeck(deps, user, deckId, { count: 5, idempotencyKey: "deck-quiz-btn-1" });
    await testWorker(deps).drain();
    const [quiz] = await deps.sql<{ source_document_ids: string[]; title: string }[]>`select source_document_ids, title from quizzes where id = ${q.quizId}`;
    expect(quiz!.source_document_ids).toEqual([docId]);
    expect(quiz!.title).toBe("Iqtisodiyot — quiz");
    const [n] = await deps.sql<{ n: number }[]>`select count(*)::int as n from questions qs join quizzes z on z.draft_version_id = qs.quiz_version_id where z.id = ${q.quizId}`;
    expect(n!.n).toBeGreaterThanOrEqual(3);
  });
});

describe("Presentation Studio HTTP API", () => {
  it("serves the deck with its laid-out preview, rejects stale edits with 409, hides other workspaces, signs downloads", async () => {
    const app = await buildApp(deps, { logger: false });
    try {
      const owner = await makeUser(deps);
      const other = await makeUser(deps);
      const h = { authorization: `Bearer ${(await createSession(deps.sql, deps.cfg, owner.id, "dev")).token}` };
      const ho = { authorization: `Bearer ${(await createSession(deps.sql, deps.cfg, other.id, "dev")).token}` };
      const docId = await bookFor(owner);
      const est = await app.inject({ method: "POST", url: "/api/decks/estimate", headers: h, payload: { slideCount: 9 } });
      expect(est.json()).toMatchObject({ credits: 3, ai: false, aiAvailable: false, regenerateCredits: 0 });
      expect((await app.inject({ method: "POST", url: "/api/decks", headers: h, payload: { settings: { topic: "Pul", slideCount: 35 }, documentIds: [docId], idempotencyKey: "http-deck-big1" } })).json().error.code).toBe("deck_too_many_slides");
      expect((await app.inject({ method: "POST", url: "/api/decks", headers: h, payload: { settings: { topic: "Pul" }, documentIds: [], idempotencyKey: "http-deck-nosrc" } })).json().error.code).toBe("deck_needs_source");
      const res = await app.inject({ method: "POST", url: "/api/decks", headers: h, payload: { settings: { topic: "Pul va bank tizimi", slideCount: 9 }, documentIds: [docId], idempotencyKey: "http-deck-0001" } });
      expect(res.statusCode).toBe(200);
      const { deckId, jobId } = res.json() as { deckId: string; jobId: string };
      expect((await app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: h })).json().status).toBe("queued");
      await testWorker(deps).drain();
      const g = await app.inject({ method: "GET", url: `/api/decks/${deckId}`, headers: h });
      expect(g.statusCode).toBe(200);
      const body = g.json() as Awaited<ReturnType<typeof decks.getDeck>>;
      expect(body.deck).toMatchObject({ status: "ready", role: "owner", theme: "academic" });
      expect(body.preview).toMatchObject({ width: 13.333, height: 7.5 });
      expect(body.preview.slides).toHaveLength(body.slides.length);
      expect(body.preview.slides[1]!.elements.some((e) => e.kind === "text" && e.name === "title")).toBe(true);
      const list = await app.inject({ method: "GET", url: "/api/decks?limit=1", headers: h });
      expect(list.json().items.map((d: { id: string }) => d.id)).toEqual([deckId]);
      expect((await app.inject({ method: "GET", url: `/api/decks/${deckId}`, headers: ho })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/decks/${deckId}/exports`, headers: ho })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/decks", headers: ho })).json().items).toEqual([]);
      const s = body.slides[2]!;
      const put = (revision: number) => app.inject({ method: "PUT", url: `/api/decks/${deckId}/slides/${s.id}`, headers: h, payload: { content: s.content, notes: "yangi", revision } });
      expect((await put(s.revision)).statusCode).toBe(200);
      const stale = await put(s.revision);
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({ code: "slide_conflict", details: { currentRevision: s.revision + 1 } });
      expect((await app.inject({ method: "PUT", url: `/api/decks/${deckId}/slides/${s.id}`, headers: h, payload: { content: { layout: "bullets", title: "x", bullets: [] }, revision: 2 } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/api/decks/${deckId}/slides/${s.id}/lock`, headers: h })).json().locked).toBe(true);
      expect((await app.inject({ method: "DELETE", url: `/api/decks/${deckId}/slides/${s.id}/lock`, headers: h })).json().locked).toBe(false);
      const hist = await app.inject({ method: "GET", url: `/api/decks/${deckId}/slides/${s.id}/history?limit=1`, headers: h });
      expect(hist.json().items).toHaveLength(1);
      expect(hist.json().nextCursor).toBe("2");
      const ex = await app.inject({ method: "POST", url: `/api/decks/${deckId}/exports`, headers: h, payload: { format: "pptx" } });
      expect(ex.json().status).toBe("queued");
      await testWorker(deps).drain();
      const exports = (await app.inject({ method: "GET", url: `/api/decks/${deckId}/exports`, headers: h })).json().items as { id: string; status: string; download: { url: string } }[];
      expect(exports[0]!.status).toBe("ready");
      const file = await app.inject({ method: "GET", url: exports[0]!.download.url });
      expect(file.statusCode).toBe(200);
      expect(file.headers["content-type"]).toContain("presentationml");
      expect(file.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");
      const thumb = await app.inject({ method: "GET", url: `/api/decks/${deckId}/exports/${exports[0]!.id}/thumbnails/1`, headers: h });
      expect(thumb.statusCode).toBe(200);
      expect(thumb.headers["content-type"]).toBe("image/png");
      expect((await app.inject({ method: "GET", url: `/api/decks/${deckId}/exports/${exports[0]!.id}/thumbnails/1`, headers: ho })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("Presentation Studio with an AI provider (SDK test double)", () => {
  it("plans and writes with the model, drops a fabricated quote's citation, and charges one slide for a regenerate", async () => {
    const stub = anthropicStub((call) => {
      const src = (needle: string) => {
        for (const m of call.user.matchAll(/<source id="(s\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)) if (m[2]!.includes(needle)) return m[1]!;
        return "s1";
      };
      if (call.system.includes("You plan the content slides")) {
        return {
          slides: [
            { layout: "definition", title: "Inflyatsiya nima", idea: "Inflyatsiya taʼrifi", source_ids: [src("Inflyatsiya — bu")] },
            { layout: "bullets", title: "Talab qonuni", idea: "Narx va talab miqdori teskari bogʻliq", source_ids: [src("Talab qonuniga")] },
            { layout: "bullets", title: "Markaziy bank", idea: "Markaziy bank vazifalari", source_ids: [src("Markaziy bank")] },
          ],
          note: null,
        };
      }
      const empty = { left_heading: null, right_heading: null, right_bullets: [], term: null, definition: null, definition_source_id: null, definition_quote: null };
      if (call.system.includes("You rewrite one presentation slide")) {
        return { slide: { index: 0, title: "Talab qonuni (soddalashtirilgan)", ...empty, notes: "Qayta yozilgan nutq.",
          bullets: [{ text: "Narx oshsa, talab miqdori kamayadi.", level: 0, source_id: src("Talab qonuniga"), quote: "tovar narxi oshsa, unga bo‘lgan talab miqdori kamayadi" }] } };
      }
      return {
        slides: [
          { index: 0, title: "Inflyatsiya nima", bullets: [], ...empty, term: "Inflyatsiya", definition: "Narxlar umumiy darajasining uzoq muddat barqaror oʻsishi.", definition_source_id: src("Inflyatsiya — bu"),
            definition_quote: "Inflyatsiya — bu iqtisodiyotda narxlar umumiy darajasining uzoq muddat davomida barqaror o‘sishidir.", notes: "Inflyatsiya haqida gapiramiz." },
          { index: 1, title: "Talab qonuni", ...empty, notes: "Talab qonuni.", bullets: [
            { text: "Narx oshsa, talab miqdori kamayadi.", level: 0, source_id: src("Talab qonuniga"), quote: "tovar narxi oshsa, unga bo‘lgan talab miqdori kamayadi" },
            { text: "Bu bogʻliqlik talab egri chizigʻida koʻrinadi.", level: 0, source_id: null, quote: null },
          ] },
          { index: 2, title: "Markaziy bank", ...empty, notes: "Markaziy bank.", bullets: [
            { text: "Pul-kredit siyosatini amalga oshiradi.", level: 0, source_id: src("Markaziy bank"), quote: "Markaziy bank mamlakatning pul-kredit siyosatini amalga oshiradi" },
            { text: "1991-yilda tashkil etilgan.", level: 0, source_id: src("Markaziy bank"), quote: "Markaziy bank 1991-yilda tashkil etilgan." },
          ] },
        ],
        defense_qa: [{ question: "Inflyatsiya qanday oʻlchanadi?", answer: "Isteʼmol narxlari indeksi orqali." }],
      };
    });
    const ai = new AiClient({ ...deps.cfg, AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test" }, deps.sql, stub.client);
    const aiDeps = { ...deps, ai };
    const user = await makeUser(deps);
    const docId = await bookFor(user);
    const created = await decks.createDeck(aiDeps, user, { settings: { topic: "Iqtisodiyot asoslari", slideCount: 7 }, documentIds: [docId], idempotencyKey: "deck-ai-000001" });
    expect(created.credits).toBe(estimateCredits(DEFAULT_PRICING, { kind: "deck", slides: 7, ai: true }));
    await testWorker(aiDeps).drain();
    let view = await decks.getDeck(aiDeps, user, deckId(created));
    expect(view.deck.status).toBe("ready");
    expect(view.deck.generation.mode).toBe("ai");
    expect(view.slides.map((s) => s.content.layout)).toEqual(["title", "agenda", "definition", "bullets", "bullets", "questions", "references"]);
    const [def, law, bank] = view.slides.slice(2, 5);
    expect(def!.content.aiWritten).toBe(true);
    expect(def!.evidence).toBe("verified");
    // AI-written explanation without a quote has no citation: the slide is only partially verified
    expect(law!.evidence).toBe("partial");
    // the invented "1991" quote is not in the book: its citation is dropped
    const bankBullets = (bank!.content as Extract<SlideContent, { layout: "bullets" }>).bullets;
    expect(bankBullets.find((b) => b.text.includes("1991"))!.ref).toBeUndefined();
    expect(bankBullets.find((b) => b.text.includes("Pul-kredit"))!.ref).toBe(1);
    expect(view.deck.generation.warnings).toContain("citations_dropped:1");
    expect(view.slides.find((s) => s.content.layout === "questions")!.notes).toContain("Inflyatsiya qanday oʻlchanadi?");
    // the planner saw the material as data, and the student's material never reached the system prompt
    expect(stub.calls.find((c) => c.system.includes("You plan"))!.user).toContain("<source id=");
    expect(stub.calls.every((c) => !c.system.includes("Talab qonuniga"))).toBe(true);

    // regenerate one slide with AI: only that slide changes and only the single-slide price is charged
    const before = new Map(view.slides.map((s) => [s.id, s.revision]));
    const balance = await getBalance(deps.sql, user.id);
    const r = await decks.regenerateSlide(aiDeps, user, deckId(created), law!.id, { instruction: "soddaroq qil" });
    expect(r.credits).toBe(DEFAULT_PRICING.slideRegenAi);
    await testWorker(aiDeps).drain();
    view = await decks.getDeck(aiDeps, user, deckId(created));
    for (const s of view.slides) expect(s.revision).toBe(before.get(s.id)! + (s.id === law!.id ? 1 : 0));
    const newLaw = view.slides.find((s) => s.id === law!.id)!;
    expect(newLaw.content.title).toBe("Talab qonuni (soddalashtirilgan)");
    expect(newLaw.evidence).toBe("verified");
    expect(balance - (await getBalance(deps.sql, user.id))).toBe(DEFAULT_PRICING.slideRegenAi);
    expect(stub.calls.find((c) => c.system.includes("You rewrite"))!.user).toContain("soddaroq qil");
    const [usage] = await deps.sql<{ n: number }[]>`select count(*)::int as n from usage_events where kind = 'ai_tokens' and user_id = ${user.id}`;
    expect(usage!.n).toBe(3);
  });
});

function deckId(c: { deckId: string }) {
  return c.deckId;
}
