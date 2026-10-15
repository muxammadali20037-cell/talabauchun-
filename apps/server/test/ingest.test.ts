import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { createDocumentFromFile, createDocumentFromText, getDocument, listDocuments } from "../src/ingest/documents";
import { ingestHandler } from "../src/ingest/pipeline";
import { JobWorker } from "../src/jobs/queue";
import { retrieve } from "../src/search/retrieve";
import { createTestDeps, makeUser } from "./helpers/deps";
import { fixture, sourceFixture } from "./helpers/fixtures";

let deps: Deps;
let cleanup: () => Promise<void>;
let worker: JobWorker;

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
  worker = new JobWorker(deps.sql, { ingest_document: ingestHandler(deps) }, { concurrency: 1, leaseSec: 60 });
});
afterAll(async () => cleanup());

describe("ingestion", () => {
  it("reads a text PDF with page labels and chapters (outline)", async () => {
    const user = await makeUser(deps);
    const r = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
    await worker.drain();
    const doc = await getDocument(deps, user, r.documentId);
    expect(doc.version?.status).toBe("ready");
    expect(doc.version?.pageCount).toBe(5);
    expect(doc.version?.pagesOk).toBe(5);
    expect(doc.pages.map((p) => p.page_label)).toEqual(["i", "1", "2", "3", "4"]);
    const chapterTitles = doc.sections.filter((s) => s.level === 1).map((s) => s.title);
    expect(chapterTitles).toEqual(expect.arrayContaining(["1-bob. Talab va taklif", "2-bob. Inflyatsiya", "3-bob. Pul va bank tizimi"]));
    const inflation = doc.sections.find((s) => s.title === "2-bob. Inflyatsiya")!;
    expect([inflation.start_page, inflation.end_page]).toEqual([3, 3]);
  });

  it("OCRs a scanned PDF and reports blank and unreadable pages honestly", async () => {
    const user = await makeUser(deps);
    const r = await createDocumentFromFile(deps, { user, filename: "skan.pdf", data: fixture("iqtisodiyot-skan.pdf"), via: "bot" });
    await worker.drain();
    const doc = await getDocument(deps, user, r.documentId);
    expect(doc.version?.pageCount).toBe(6);
    const byIndex = new Map(doc.pages.map((p) => [p.page_index, p]));
    for (const i of [1, 2, 3, 4]) {
      expect(byIndex.get(i)?.method).toBe("ocr");
      expect(["ok", "low_confidence"]).toContain(byIndex.get(i)?.status);
    }
    expect(byIndex.get(5)?.status).toBe("empty");
    expect(["failed", "empty", "low_confidence"]).toContain(byIndex.get(6)?.status);
    expect(doc.version?.status === "partial" || doc.version?.status === "ready").toBe(true);
    // the OCR text is searchable and points at the physical page
    const hits = await retrieve(deps, { query: "Inflyatsiya narxlar umumiy darajasi", userId: user.id, documentIds: [r.documentId] });
    expect(hits[0]?.locator.pageIndex).toBe(3);
  });

  it("reads DOCX by headings and paragraphs without inventing page numbers", async () => {
    const user = await makeUser(deps);
    const r = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.docx", data: fixture("iqtisodiyot.docx"), via: "miniapp" });
    await worker.drain();
    const doc = await getDocument(deps, user, r.documentId);
    expect(doc.version?.status).toBe("ready");
    expect(doc.pages.every((p) => p.kind === "section" && p.page_label === null)).toBe(true);
    expect(doc.sections.map((s) => s.title)).toContain("2.3. Inflyatsiyani o‘lchash");
    const hits = await retrieve(deps, { query: "iste’mol narxlari indeksi", userId: user.id, documentIds: [r.documentId] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.locator.pageIndex).toBeUndefined();
    expect(hits[0]!.locator.heading).toBeTruthy();
  });

  it("reads PPTX slides with slide numbers, CSV/XLSX tables and pasted text", async () => {
    const user = await makeUser(deps);
    const p = await createDocumentFromFile(deps, { user, filename: "maruza.pptx", data: fixture("iqtisodiyot.pptx"), via: "miniapp" });
    const x = await createDocumentFromFile(deps, { user, filename: "namuna.xlsx", data: fixture("namuna.xlsx"), via: "miniapp" });
    const c = await createDocumentFromFile(deps, { user, filename: "namuna.csv", data: sourceFixture("namuna-statistika.csv"), via: "miniapp" });
    const t = await createDocumentFromText(deps, { user, title: "Konspekt", text: "Markaziy bank asosiy stavkani oshirsa kreditlar qimmatlashadi.\n\nBu inflyatsiyani pasaytirishga yordam beradi.", via: "miniapp" });
    await worker.drain();
    const pptx = await getDocument(deps, user, p.documentId);
    expect(pptx.pages.map((pg) => [pg.page_index, pg.kind, pg.heading])).toEqual([
      [1, "slide", "Talab va taklif"],
      [2, "slide", "Inflyatsiya"],
      [3, "slide", "Markaziy bank"],
    ]);
    for (const id of [x.documentId, c.documentId, t.documentId]) expect((await getDocument(deps, user, id)).version?.status).toBe("ready");
    const [ver] = await deps.sql<{ metadata: { tables: { columns: string[]; rows: unknown[][] }[] } }[]>`select metadata from document_versions where id = ${x.versionId}`;
    expect(ver!.metadata.tables[0]!.columns[1]).toBe("Narx indeksi (bazaviy yil = 100)");
    expect(ver!.metadata.tables[0]!.rows.map((r) => r[1])).toEqual([100, 110, 121, 130]);
  });

  it("rejects password-protected and corrupted PDFs with a clear code", async () => {
    const user = await makeUser(deps);
    const a = await createDocumentFromFile(deps, { user, filename: "himoyalangan.pdf", data: fixture("himoyalangan.pdf"), via: "miniapp" });
    const b = await createDocumentFromFile(deps, { user, filename: "buzilgan.pdf", data: fixture("buzilgan.pdf"), via: "miniapp" });
    await worker.drain();
    expect((await getDocument(deps, user, a.documentId)).version).toMatchObject({ status: "failed", errorCode: "password_protected" });
    expect((await getDocument(deps, user, b.documentId)).version).toMatchObject({ status: "failed", errorCode: "corrupted" });
  });

  it("rejects disguised and macro files by content, not by name", async () => {
    const user = await makeUser(deps);
    await expect(createDocumentFromFile(deps, { user, filename: "virus.pdf", data: Buffer.from("MZ\x90\x00 this is an exe"), via: "miniapp" })).rejects.toMatchObject({ code: "file_unsupported" });
    await expect(createDocumentFromFile(deps, { user, filename: "kitob.docm", data: fixture("iqtisodiyot.docx"), via: "miniapp" })).rejects.toMatchObject({ code: "file_macro_not_allowed" });
    await expect(createDocumentFromFile(deps, { user, filename: "rasm.png", data: fixture("iqtisodiyot.pdf"), via: "miniapp" })).resolves.toBeTruthy(); // real PDF bytes are treated as PDF
  });

  it("isolates libraries between accounts", async () => {
    const owner = await makeUser(deps);
    const other = await makeUser(deps);
    const r = await createDocumentFromText(deps, { user: owner, title: "Maxfiy konspekt", text: "Bu faqat egasiga koʻrinadigan maxfiy konspekt matni, boshqa hisobga koʻrinmasligi kerak.", via: "bot" });
    await worker.drain();
    expect((await listDocuments(deps, owner, {})).items.map((d) => d.id)).toContain(r.documentId);
    expect((await listDocuments(deps, other, {})).items.map((d) => d.id)).not.toContain(r.documentId);
    await expect(getDocument(deps, other, r.documentId)).rejects.toMatchObject({ status: 404 });
    expect(await retrieve(deps, { query: "maxfiy konspekt", userId: other.id })).toEqual([]);
    expect((await retrieve(deps, { query: "maxfiy konspekt", userId: owner.id })).length).toBeGreaterThan(0);
  });
});
