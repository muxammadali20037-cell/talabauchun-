import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTelegramUser, noHorizontalScroll } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");

async function upload(page: Page, file: string) {
  await page.goto("/app/#/library/upload");
  await page.getByLabel("Fayl tanlang").setInputFiles(file);
  await page.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(page.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
}

test("study tools: summary → flashcards review, sourced tutor answer, matching game, exam plan", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await asTelegramUser(page, { id: 4300001, first_name: "Dilnoza", language_code: "uz" });
  await upload(page, path.join(FIX, "generated/iqtisodiyot.pdf"));
  const docUrl = page.url();

  // Konspekt: points are quoted from the book with their location
  await page.getByRole("link", { name: /Konspekt/ }).click();
  await expect(page.getByRole("heading", { name: "Konspekt" })).toBeVisible();
  await expect(page.getByText(/📖 sahifa \d+/).first()).toBeVisible();
  await page.getByRole("button", { name: /Taʼriflardan kartochka yaratish/ }).click();
  await expect(page.getByText(/ta kartochka yaratildi/)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/10-summary-390.png`, fullPage: true });

  // Flashcards: flip shows the answer with its source; grading schedules the card
  await page.goto("/app/#/cards");
  await expect(page.getByRole("heading", { name: "Kartochkalar" })).toBeVisible();
  const stats = await page.locator("p.caption").first().textContent();
  await page.getByRole("button", { name: "Javobni koʻrsatish" }).click();
  await expect(page.locator(".evidence").first()).toContainText("📖");
  await page.screenshot({ path: `${SHOTS}/11-flashcard-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Yaxshi" }).click();
  await expect(page.locator("p.caption").first()).not.toHaveText(stats!);
  await expect(page.locator("p.caption").first()).toContainText("Takrorlandi: 1");

  // Tutor (no AI configured): answers only with sentences found in the book, each with its page
  await page.goto(`${docUrl.replace(/#\/library\/([^/]+).*/, "#/tutor?doc=$1")}`);
  await page.getByLabel("Savolingiz").fill("Talab qonuni nima?");
  await page.getByRole("button", { name: "Soʻrash" }).click();
  await expect(page.getByText("AI oʻchiq: manbadagi eng mos jumlalar")).toBeVisible();
  await expect(page.locator(".bubble li").first()).toContainText("Talab qonuniga");
  await expect(page.locator(".bubble li").first()).toContainText("📖");
  // a question the book does not answer is reported as not found instead of being invented
  await page.getByLabel("Savolingiz").fill("Kvant kompyuterlari qanday ishlaydi?");
  await page.getByRole("button", { name: "Soʻrash" }).click();
  await expect(page.getByText(/materialingizda topilmadi/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/12-tutor-390.png`, fullPage: true });

  // Matching game: server keeps the key and scores the submitted pairing
  await page.goto(`${docUrl.replace(/#\/library\/([^/]+).*/, "#/games/matching?doc=$1")}`);
  await page.getByRole("button", { name: "Boshlash" }).click();
  const terms = page.locator("section").first().locator("button.list-item");
  const defs = page.locator("section").nth(1).locator("button.list-item");
  await expect(terms.first()).toBeVisible();
  const n = await terms.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) {
    await terms.nth(i).click();
    await defs.nth(i).click();
  }
  await page.getByRole("button", { name: "Tekshirish" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`/ ${n} toʻgʻri`) })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/13-matching-390.png`, fullPage: true });

  // Exam plan: tasks per day until the exam, the last day reserved for review
  await page.goto("/app/#/plans/new");
  const exam = new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10);
  await page.getByLabel("Fan yoki imtihon nomi").fill("Iqtisodiyot nazariyasi");
  await page.getByLabel("Imtihon sanasi").fill(exam);
  await page.getByLabel("Mavzular").fill("Talab va taklif\nBozor muvozanati\nInflyatsiya");
  await page.getByRole("button", { name: "Reja tuzish" }).click();
  await expect(page.getByText(`Imtihon: ${exam}`)).toBeVisible();
  await expect(page.getByText("Umumiy takrorlash")).toBeVisible();
  await page.getByRole("checkbox").first().check();
  await expect(page.getByText(/Bajarildi: 1 \//)).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/14-plan-390.png`, fullPage: true });
  await ctx.close();
});

test("statistics from the user's table: exact values, computed change with formula, sample-data warning, quiz", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await ctx.newPage();
  await asTelegramUser(page, { id: 4300003, first_name: "Aziz", language_code: "uz" });
  await upload(page, path.join(FIX, "source/namuna-statistika.csv"));
  await page.getByRole("link", { name: /Statistika/ }).click();
  await page.getByLabel("Davr / nom ustuni").selectOption({ index: 0 });
  await page.getByLabel("Qiymat ustuni").selectOption({ index: 1 });
  await page.getByLabel("Koʻrsatkich nomi").fill("Narx indeksi");
  await page.getByLabel("Oʻlchov birligi").fill("indeks");
  await page.getByRole("button", { name: "Qiymatlarni saqlash" }).click();
  // the CSV rows say they are a teaching example → flagged automatically
  await expect(page.getByText("Namuna maʼlumot").first()).toBeVisible();
  await page.getByLabel("Boshlangʻich davr").selectOption({ label: "2021" });
  await page.getByLabel("Oxirgi davr").selectOption({ label: "2023" });
  await page.getByRole("button", { name: "Foiz oʻzgarishini hisoblash" }).click();
  await expect(page.locator(".evidence strong")).toHaveText("+21 %");
  await expect(page.getByText("(121 − 100) / 100 × 100")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/15-stats-360.png`, fullPage: true });
  await page.getByRole("button", { name: /Shu qatordan quiz/ }).click();
  await expect(page.getByText(/Namuna maʼlumot — Narx indeksi/).first()).toBeVisible();
  await ctx.close();
});

test("group project: owner invites by startapp link, member joins with the invite role, task assigned and completed, comment", async ({ browser }) => {
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const op = await owner.newPage();
  await asTelegramUser(op, { id: 4300010, first_name: "Malika", language_code: "uz" });
  await op.goto("/app/#/workspaces/new");
  await op.getByLabel("Loyiha nomi").fill("Kurs ishi: Inflyatsiya");
  await op.getByRole("button", { name: "Yaratish" }).click();
  await expect(op.getByRole("heading", { name: "Kurs ishi: Inflyatsiya" })).toBeVisible();
  await op.getByRole("button", { name: /Taklif qilish/ }).click();
  await op.getByRole("dialog").getByRole("button", { name: "Havola yaratish" }).click();
  const link = await op.getByLabel("Taklif havolasi").inputValue();
  expect(link).toMatch(/^https:\/\/t\.me\/talaba_test_bot\?startapp=w[A-Za-z0-9_-]{22}$/);
  await op.getByRole("dialog").getByRole("button", { name: "Yopish" }).click();
  await expect(op.getByRole("dialog")).toHaveCount(0);

  const member = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const mp = await member.newPage();
  await asTelegramUser(mp, { id: 4300011, first_name: "Bekzod", language_code: "uz" }, { startParam: link.split("startapp=")[1]! });
  await mp.goto("/app/");
  await expect(mp.getByRole("heading", { name: "Kurs ishi: Inflyatsiya" })).toBeVisible();
  await expect(mp.getByText("Tahrirlovchi").first()).toBeVisible();

  // owner assigns a task to the new member
  await op.reload();
  await op.getByRole("button", { name: "Vazifalar" }).click();
  await op.getByRole("button", { name: "+ Yangi vazifa" }).click();
  await op.getByLabel("Vazifa", { exact: true }).fill("Ikkinchi bobni oʻqish");
  await op.getByLabel("Masʼul").selectOption({ label: "Bekzod" });
  await op.getByRole("dialog").getByRole("button", { name: "Saqlash" }).click();
  await expect(op.getByText("Ikkinchi bobni oʻqish")).toBeVisible();

  // member completes it and comments
  await mp.reload();
  await mp.getByRole("button", { name: "Vazifalar" }).click();
  await mp.getByRole("checkbox", { name: "Ikkinchi bobni oʻqish" }).check();
  await mp.getByRole("button", { name: /Ikkinchi bobni oʻqish/ }).click();
  await mp.getByLabel("Izoh yozish").fill("Tayyor, konspekt yozdim");
  await mp.getByRole("dialog").getByRole("button", { name: "Yuborish" }).click();
  await expect(mp.getByRole("dialog").getByText("Tayyor, konspekt yozdim")).toBeVisible();
  expect(await noHorizontalScroll(mp)).toBe(true);
  await mp.screenshot({ path: `${SHOTS}/16-workspace-task-360.png`, fullPage: true });

  // owner sees the change in the activity log
  await op.reload();
  await op.getByRole("button", { name: "Tarix" }).click();
  await expect(op.getByText(/Bekzod · guruhga qoʻshildi \(Tahrirlovchi\)/)).toBeVisible();
  await expect(op.getByText(/Bekzod · izoh yozdi/)).toBeVisible();
  await op.screenshot({ path: `${SHOTS}/17-workspace-activity-390.png`, fullPage: true });
  await owner.close();
  await member.close();
});
