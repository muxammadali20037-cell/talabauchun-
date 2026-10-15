/**
 * Builds the acceptance-test material set from the original source text in
 * test/fixtures/source (written by the project for testing, CC0):
 *  - iqtisodiyot.docx  (LibreOffice HTML→DOCX, real heading styles)
 *  - iqtisodiyot.pdf   (LibreOffice DOCX→PDF with bookmarks) + PageLabels: i, ii, 1, 2, …
 *  - iqtisodiyot-skan.pdf (image-only "scan": rasterised pages + one blank + one noise page)
 *  - iqtisodiyot.pptx  (pptxgenjs), namuna.xlsx (exceljs), himoyalangan.pdf (qpdf AES), buzilgan.pdf
 * Run: pnpm tsx scripts/make-fixtures.ts
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import PptxGenJS from "pptxgenjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "../test/fixtures/source");
const OUT = path.join(here, "../test/fixtures/generated");
mkdirSync(OUT, { recursive: true });
const work = path.join(tmpdir(), `talaba-fixtures-${process.pid}`);
mkdirSync(work, { recursive: true });
const lo = (args: string[]) =>
  execFileSync("soffice", [`-env:UserInstallation=file://${work}/lo-profile`, "--headless", ...args], { cwd: work, stdio: "pipe", timeout: 180_000 });

// 1) DOCX from HTML (LibreOffice maps <h1>/<h2> to Heading 1/2 styles)
copyFileSync(path.join(SRC, "iqtisodiyot.html"), path.join(work, "iqtisodiyot.html"));
lo(["--convert-to", "docx:MS Word 2007 XML", "--outdir", work, path.join(work, "iqtisodiyot.html")]);
copyFileSync(path.join(work, "iqtisodiyot.docx"), path.join(OUT, "iqtisodiyot.docx"));

// 2) PDF from DOCX with heading bookmarks
lo(["--convert-to", 'pdf:writer_pdf_Export:{"ExportBookmarks":{"type":"boolean","value":"true"}}', "--outdir", work, path.join(work, "iqtisodiyot.docx")]);
const pdfBytes = readFileSync(path.join(work, "iqtisodiyot.pdf"));
const pdf = await PDFDocument.load(pdfBytes);
const n = pdf.getPageCount();
// PageLabels: the first physical page is front matter ("i"); printed numbering 1, 2, … starts on physical page 2.
const ctx = pdf.context;
const labels = PDFDict.withContext(ctx);
const nums = PDFArray.withContext(ctx);
const roman = PDFDict.withContext(ctx);
roman.set(PDFName.of("S"), PDFName.of("r"));
const decimal = PDFDict.withContext(ctx);
decimal.set(PDFName.of("S"), PDFName.of("D"));
decimal.set(PDFName.of("St"), PDFNumber.of(1));
nums.push(PDFNumber.of(0));
nums.push(roman);
nums.push(PDFNumber.of(1));
nums.push(decimal);
labels.set(PDFName.of("Nums"), nums);
pdf.catalog.set(PDFName.of("PageLabels"), labels);
pdf.setTitle("Iqtisodiyot nazariyasi asoslari (o‘quv qo‘llanma namunasi)");
pdf.setAuthor("TALABA AI test materiali");
writeFileSync(path.join(OUT, "iqtisodiyot.pdf"), await pdf.save());
void PDFString;

// 3) "Scanned" PDF: rasterise the first 4 pages at 150 dpi, add a blank page and a noise page.
execFileSync("pdftoppm", ["-r", "150", "-gray", "-png", "-f", "1", "-l", String(Math.min(4, n)), path.join(OUT, "iqtisodiyot.pdf"), path.join(work, "scan")]);
const scan = await PDFDocument.create();
const pngs = readdirSync(work).filter((f) => f.startsWith("scan") && f.endsWith(".png")).sort();
for (const f of pngs) {
  const img = await scan.embedPng(readFileSync(path.join(work, f)));
  const page = scan.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
}
// blank page
execFileSync("convert", ["-size", "1240x1754", "xc:white", path.join(work, "blank.png")]);
scan.addPage([595, 842]).drawImage(await scan.embedPng(readFileSync(path.join(work, "blank.png"))), { x: 0, y: 0, width: 595, height: 842 });
// unreadable page: random noise with speckles (simulates a very poor scan)
execFileSync("convert", ["-size", "620x877", "xc:", "+noise", "Random", "-colorspace", "Gray", "-threshold", "55%", "-resize", "1240x1754", path.join(work, "noise.png")]);
scan.addPage([595, 842]).drawImage(await scan.embedPng(readFileSync(path.join(work, "noise.png"))), { x: 0, y: 0, width: 595, height: 842 });
writeFileSync(path.join(OUT, "iqtisodiyot-skan.pdf"), await scan.save());

// 4) PPTX lecture slides
const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
const slides: [string, string[]][] = [
  ["Talab va taklif", ["Talab — xarid qilishga tayyor va qodir bo‘lgan miqdor", "Talab qonuni: narx oshsa, talab miqdori kamayadi"]],
  ["Inflyatsiya", ["Narxlar umumiy darajasining barqaror o‘sishi", "Iste’mol narxlari indeksi orqali o‘lchanadi"]],
  ["Markaziy bank", ["Pul-kredit siyosatini amalga oshiradi", "Asosiy stavka orqali kredit narxiga ta’sir qiladi"]],
];
for (const [title, bullets] of slides) {
  const s = pptx.addSlide();
  s.addText(title, { placeholder: undefined, x: 0.6, y: 0.4, w: 12, h: 1, fontSize: 32, bold: true });
  s.addText(bullets.map((b) => ({ text: b, options: { bullet: true } })), { x: 0.8, y: 1.8, w: 11.5, h: 4, fontSize: 24 });
}
await pptx.writeFile({ fileName: path.join(OUT, "iqtisodiyot.pptx") });

// 5) XLSX sample statistics (clearly labelled example data)
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Namuna");
ws.addRow(["Yil", "Narx indeksi (bazaviy yil = 100)", "Izoh"]);
for (const [y, v] of [[2021, 100], [2022, 110], [2023, 121], [2024, 130]] as const) ws.addRow([y, v, "O‘quv misoli — haqiqiy statistika emas"]);
await wb.xlsx.writeFile(path.join(OUT, "namuna.xlsx"));

// 6) Password-protected and corrupted PDFs
execFileSync("qpdf", ["--encrypt", "user-pass", "owner-pass", "256", "--", path.join(OUT, "iqtisodiyot.pdf"), path.join(OUT, "himoyalangan.pdf")]);
writeFileSync(path.join(OUT, "buzilgan.pdf"), Buffer.concat([readFileSync(path.join(OUT, "iqtisodiyot.pdf")).subarray(0, 1200), Buffer.from("\n%%garbage")]));

if (existsSync(work)) rmSync(work, { recursive: true, force: true });
console.log("fixtures:", readdirSync(OUT).join(", "), `(text pdf pages: ${n})`);
