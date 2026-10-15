import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTelegramUser, noHorizontalScroll } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");

/** Downloads a deck file the way the app does (signed /files link) and returns its bytes via the page's request context. */
async function downloadVia(page: Page, row: ReturnType<Page["locator"]>, format: "PPTX" | "PDF") {
  const button = row.getByRole("button", { name: `Yuklab olish ${format}` });
  await expect(button).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  const url = download.url();
  expect(url).toMatch(/\/files\/[0-9a-f-]+\/[0-9a-f-]+\.(pptx|pdf)\?name=.+&exp=\d+&sig=[0-9a-f]{64}$/);
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  return Buffer.from(await res.body());
}

function withTemp<T>(name: string, data: Buffer, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "talaba-e2e-deck-"));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, data);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("acceptance 11 in the Mini App: 12-slide deck from a book → edit → regenerate one slide → PPTX + PDF that open and match", async ({ page, browser }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await asTelegramUser(page, { id: 4500001, first_name: "Dilnoza", language_code: "uz" });

  // material
  await page.goto("/app/#/library/upload");
  await page.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "generated/iqtisodiyot.pdf"));
  await page.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(page.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });

  // empty list first
  await page.goto("/app/#/decks");
  await expect(page.getByText(/Hali prezentatsiya yoʻq/)).toBeVisible();
  await page.goBack();

  // create from the document page: the book is preselected and its title suggests the topic
  await page.getByRole("link", { name: /Prezentatsiya yaratish/ }).click();
  await expect(page.getByRole("heading", { name: "Prezentatsiya yaratish" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /iqtisodiyot/ })).toBeChecked();
  await expect(page.getByLabel("Mavzu")).toHaveValue("iqtisodiyot");
  await page.getByLabel("Mavzu").fill("Iqtisodiyot nazariyasi asoslari");
  await expect(page.getByLabel("Slaydlar soni")).toHaveValue("12");
  await expect(page.getByText(/Narxi: 4 kredit/)).toBeVisible();
  await expect(page.getByText(/AI ulanmagan/).first()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/30-deck-new-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Slaydlarni yaratish" }).click();

  // generation → 12 laid-out slides, every content slide marked with a checked source
  const cards = page.locator("article.deck-card");
  await expect(cards).toHaveCount(12, { timeout: 90_000 });
  await expect(page.getByText("12 ta slayd").first()).toBeVisible();
  await expect(page.getByText("Materialdan olingan").first()).toBeVisible();
  await expect(page.locator(".deck-slide")).toHaveCount(12);
  await expect(page.getByText("✓ Manba tekshirilgan").first()).toBeVisible();
  const deckUrl = page.url();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/30-deck-ready-390.png`, fullPage: true });

  // full-screen viewer: on a portrait phone the slide is turned sideways to be readable
  await page.getByRole("button", { name: "Katta koʻrinishda ochish: 4-slayd" }).click();
  const viewer = page.getByRole("dialog", { name: "4-slayd" });
  await expect(viewer.getByText("4 / 12")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/30-deck-viewer-390.png` });
  await viewer.getByRole("button", { name: "Keyingi slayd" }).click();
  await expect(page.getByText("5 / 12")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("5 / 12")).toBeHidden();

  // ── edit one slide's text (Uzbek Latin ʻ ʼ + Cyrillic) ──
  const intro = cards.filter({ has: page.getByRole("heading", { name: /: Kirish$/ }) });
  await intro.getByRole("button", { name: /Tahrirlash/ }).click();
  const editor = page.getByRole("dialog", { name: "Slaydni tahrirlash" });
  await expect(editor.getByLabel("Sarlavha", { exact: true })).toHaveValue("Kirish");
  const firstBullet = editor.getByLabel("Bandlar 1");
  await firstBullet.fill("Oʻzbekistonda taʼlim: ўқғҳ — tahrirlangan band.");
  await expect(editor.getByRole("button", { name: "Saqlash" })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/30-deck-editor-390.png` });

  // someone saves the same slide meanwhile → 409: the app shows the conflict and saves only on an explicit choice
  const token = await page.evaluate(() => sessionStorage.getItem("talaba.token"));
  const deckId = deckUrl.split("/decks/")[1]!;
  const deck = await (await page.request.get(`/api/decks/${deckId}`, { headers: { authorization: `Bearer ${token}` } })).json();
  const introSlide = deck.slides.find((s: { content: { title: string } }) => s.content.title === "Kirish");
  const concurrent = await page.request.put(`/api/decks/${deckId}/slides/${introSlide.id}`, {
    headers: { authorization: `Bearer ${token}` },
    data: { content: introSlide.content, notes: "Boshqa qurilmadan tahrir", revision: introSlide.revision },
  });
  expect(concurrent.status()).toBe(200);
  await editor.getByRole("button", { name: "Saqlash" }).click();
  await expect(editor.getByText("Bu slayd boshqa joyda oʻzgartirildi")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/30-deck-conflict-390.png` });
  await editor.getByRole("button", { name: "Mening versiyamni saqlash" }).click();
  await expect(editor).toBeHidden();
  await expect(intro.locator(".deck-slide")).toContainText("Oʻzbekistonda taʼlim: ўқғҳ");
  // the edited text is no longer the book's sentence: not shown as fully verified
  await expect(intro.getByText("✓ Manba tekshirilgan")).toHaveCount(0);
  await expect(intro.getByText("Tekshirilmagan")).toBeVisible();

  // ── regenerate exactly one slide (free in extractive mode) ──
  const target = cards.filter({ has: page.getByRole("heading", { name: /: Inflyatsiya$/ }) });
  const headings = await page.locator("article.deck-card h3").allTextContents();
  const targetIndex = headings.findIndex((h) => /: Inflyatsiya$/.test(h));
  expect(targetIndex).toBeGreaterThan(0);
  const before = await cards.allTextContents();
  await target.getByRole("button", { name: /Shu slaydni qayta yaratish/ }).click();
  const regen = page.getByRole("dialog", { name: "Shu slaydni qayta yaratish" });
  await expect(regen.getByText("Bepul")).toBeVisible();
  await expect(regen.getByText(/Faqat shu slayd qayta yaratiladi/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/30-deck-regenerate-390.png` });
  await regen.getByRole("button", { name: /Shu slaydni qayta yaratish/ }).click();
  await expect(regen).toBeHidden({ timeout: 60_000 });
  await target.getByRole("button", { name: /Oʻzgarishlar tarixi/ }).click();
  const hist = page.getByRole("dialog", { name: "Oʻzgarishlar tarixi" });
  await expect(hist.getByText("Qayta yaratildi")).toBeVisible();
  await hist.getByRole("button", { name: "Yopish" }).click();
  // the other eleven slides are untouched
  const after = await cards.allTextContents();
  expect(after).toHaveLength(12);
  for (let i = 0; i < 12; i++) if (i !== targetIndex) expect(after[i]).toBe(before[i]);

  // ── export PPTX + PDF, verify the actual files ──
  const pptxRow = page.locator('.deck-export[data-format="pptx"]');
  const pdfRow = page.locator('.deck-export[data-format="pdf"]');
  await pptxRow.getByRole("button", { name: "PPTX yuklab olish" }).click();
  await pdfRow.getByRole("button", { name: "PDF yuklab olish" }).click();
  const pptx = await downloadVia(page, pptxRow, "PPTX");
  const pdf = await downloadVia(page, pdfRow, "PDF");
  expect(pptx.subarray(0, 2).toString("latin1")).toBe("PK");
  withTemp("deck.pptx", pptx, (file) => {
    const listing = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
    expect(new Set(listing.match(/ppt\/slides\/slide\d+\.xml/g)).size).toBe(12);
    expect(new Set(listing.match(/ppt\/charts\/chart\d+\.xml/g) ?? []).size).toBe(0);
    const xml = execFileSync("unzip", ["-p", file, "ppt/slides/slide2.xml"], { encoding: "utf8" });
    expect(xml).toContain("Oʻzbekistonda taʼlim: ўқғҳ");
    expect(xml).not.toContain("<p:pic");
  });
  expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  withTemp("deck.pdf", pdf, (file) => {
    expect(execFileSync("pdfinfo", [file], { encoding: "utf8" })).toMatch(/^Pages:\s+12$/m);
    expect(execFileSync("pdftotext", ["-f", "2", "-l", "2", file, "-"], { encoding: "utf8" })).toContain("ўқғҳ");
  });
  // server-side checks and page renders are shown with the file
  await pdfRow.getByText(/Tekshiruv: \d+\/\d+/).click();
  await expect(pdfRow.getByText("Oʻzbek va kirill harflari buzilmagan")).toBeVisible();
  await expect(pdfRow.locator(".deck-thumbs img")).toHaveCount(12, { timeout: 30_000 });
  await page.locator(".deck-export").first().scrollIntoViewIfNeeded();
  await page.locator("section.card", { has: page.getByRole("heading", { name: /Fayllar/ }) }).screenshot({ path: `${SHOTS}/30-deck-exports-390.png` });
  expect(await noHorizontalScroll(page)).toBe(true);

  // "Shu materialdan quiz" opens the quiz editor
  await page.getByRole("button", { name: /Shu materialdan quiz/ }).click();
  await expect(page).toHaveURL(/#\/quiz\/[0-9a-f-]+\/edit$/);

  // wide and narrow screens, light and dark: no horizontal scrolling
  for (const [width, scheme] of [[1024, "light"], [320, "light"], [390, "dark"]] as const) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
    const p = await ctx.newPage();
    await asTelegramUser(p, { id: 4500001, first_name: "Dilnoza", language_code: "uz" }, { colorScheme: scheme });
    await p.goto(`/app/#/decks/${deckId}`);
    await expect(p.locator("article.deck-card")).toHaveCount(12);
    expect(await noHorizontalScroll(p)).toBe(true);
    if (width !== 320) await p.screenshot({ path: `${SHOTS}/30-deck-ready-${scheme === "dark" ? "dark-" : ""}${width}.png`, fullPage: true });
    await p.goto("/app/#/decks");
    await expect(p.getByText("Iqtisodiyot nazariyasi asoslari")).toBeVisible();
    expect(await noHorizontalScroll(p)).toBe(true);
    if (width === 1024) await p.screenshot({ path: `${SHOTS}/30-deck-list-1024.png`, fullPage: true });
    await p.goto("/app/#/decks/new");
    await expect(p.getByRole("heading", { name: "Prezentatsiya yaratish" })).toBeVisible();
    expect(await noHorizontalScroll(p)).toBe(true);
    if (width === 1024) await p.screenshot({ path: `${SHOTS}/30-deck-new-1024.png`, fullPage: true });
    await ctx.close();
  }
});

test("plan first: the outline is shown, edited (remove + add a slide), then the deck is built from it", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await asTelegramUser(page, { id: 4500002, first_name: "Bekzod", language_code: "uz" });
  await page.goto("/app/#/library/upload");
  await page.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "generated/iqtisodiyot.pdf"));
  await page.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(page.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: /Prezentatsiya yaratish/ }).click();
  await page.getByLabel("Mavzu").fill("Pul va inflyatsiya");
  await page.getByLabel("Slaydlar soni").fill("8");
  await page.getByRole("switch", { name: "Avval rejani koʻrsatish" }).check();
  await page.getByRole("button", { name: "Reja tuzish" }).click();

  // the outline: 8 planned slides, editable before anything is generated
  await expect(page.getByText(/Reja tayyor\. Sarlavhalarni tahrirlang/)).toBeVisible({ timeout: 60_000 });
  const items = page.locator("ol.deck-outline > li");
  await expect(items).toHaveCount(8);
  await items.nth(2).getByRole("button", { name: /Olib tashlash/ }).click();
  await expect(items).toHaveCount(7);
  await page.getByRole("button", { name: /Reja bandini qoʻshish/ }).click();
  await items.last().getByLabel(/^Sarlavha 8$/).fill("Markaziy bank va inflyatsiya");
  await items.last().getByLabel(/^Asosiy fikr 8$/).fill("asosiy stavka");
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/30-deck-plan-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Slaydlarni yaratish" }).click();

  const cards = page.locator("article.deck-card");
  await expect(cards).toHaveCount(8, { timeout: 90_000 });
  await expect(cards.last().getByRole("heading", { name: /Markaziy bank va inflyatsiya$/ })).toBeVisible();
  await expect(cards.last().getByText("✓ Manba tekshirilgan")).toBeVisible();
});
