import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { asTelegramUser, noHorizontalScroll } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");

test("Telegram sign-in → upload book → sourced quiz from Q&A → review/edit → publish → practice", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asTelegramUser(page, { id: 4100001, first_name: "Malika", language_code: "uz" });
  await page.goto("/app/");

  // onboarding: language suggested from Telegram (uz), three short skippable steps
  await expect(page.getByRole("heading", { name: "Tilni tanlang" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-onboarding-390.png` });
  await page.getByRole("button", { name: "Davom ettirish" }).click();
  await expect(page.getByRole("heading", { name: "Nima qilmoqchisiz?" })).toBeVisible();
  await page.getByRole("button", { name: "Kitob bilan ishlash" }).click();
  await page.getByRole("button", { name: "Keyinroq" }).first().click();

  // upload the book (lands on the upload sheet because of the "book" goal)
  await expect(page.getByRole("dialog", { name: "Fayl yuklash" })).toBeVisible();
  await page.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "generated/iqtisodiyot.pdf"));
  await page.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(page.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Jami sahifa: 5")).toBeVisible();
  await expect(page.getByRole("link", { name: "2-bob. Inflyatsiya" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-document-390.png`, fullPage: true });
  expect(await noHorizontalScroll(page)).toBe(true);

  // physical page vs printed page label
  await page.getByRole("link", { name: "2-bob. Inflyatsiya" }).click();
  await expect(page.getByText("Kitobdagi raqam: 2")).toBeVisible();
  await page.goBack();

  // quiz from the user's own Q&A list + the book
  await page.getByRole("link", { name: /Quiz yaratish/ }).first().click();
  await page.getByRole("radio", { name: /Savol-javoblarni variantga aylantirish/ }).click();
  await page.getByLabel(/Savol-javoblarni joylang/).fill(readFileSync(path.join(FIX, "source/savollar-javoblar.txt"), "utf8"));
  await expect(page.getByText(/Taxminiy sarf: \d+ kredit/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-quiz-create-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Quiz yaratish" }).last().click();

  // editor: 6 questions, sources shown, the out-of-book question is blocked
  await expect(page.getByText("6 ta savol").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Dalil manbadan tekshirildi/).first()).toBeVisible();
  await expect(page.getByText(/sahifa 2 \(kitobda: 1\)/).first()).toBeVisible();
  const outside = page.locator("article", { hasText: "Oʻzbekiston soʻmi" }).or(page.locator("article", { hasText: "so‘mi" }));
  await expect(outside.getByText("Javob manbada topilmadi")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-quiz-editor-390.png`, fullPage: true });

  // publishing is refused while questions are unreviewed / without evidence
  await page.getByRole("button", { name: "Nashr qilish" }).click();
  await expect(page.getByText(/Dalilsiz yoki tekshirilmagan savollar nashr qilinmaydi/)).toBeVisible();

  // edit one question (explanation), then approve the five sourced ones and remove the unsupported one
  const first = page.locator("article").first();
  await first.getByRole("button", { name: /Tahrirlash/ }).click();
  await page.getByLabel("Izoh").fill("Talab — xohish emas, toʻlov qobiliyati bilan taʼminlangan ehtiyoj.");
  await page.getByRole("button", { name: "Saqlash" }).click();
  await expect(first.getByText(/toʻlov qobiliyati bilan taʼminlangan/)).toBeVisible();
  for (let i = 0; i < 5; i++) {
    const card = page.locator("article").nth(i);
    const approve = card.getByRole("button", { name: /Tasdiqlash/ });
    if (await approve.count()) await approve.click();
    await expect(card.getByText("Tasdiqlangan").first()).toBeVisible();
  }
  await outside.getByRole("button", { name: /Oʻchirish 6/ }).click();
  await expect(page.getByText("5 ta savol").first()).toBeVisible();
  await page.getByRole("button", { name: "Nashr qilish" }).click();
  await expect(page.getByText("Nashr qilingan").first()).toBeVisible();

  // practice: answer, see explanation + book source, finish
  await page.getByRole("button", { name: /Oʻynash/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Boshlash" }).click();
  for (let i = 0; i < 5; i++) {
    await page.locator("button.choice").first().click();
    await page.getByRole("button", { name: "Tekshirish" }).click();
    await expect(page.getByText(/📖/)).toBeVisible();
    if (i === 0) await page.screenshot({ path: `${SHOTS}/05-practice-feedback-390.png`, fullPage: true });
    await page.getByRole("button", { name: i === 4 ? "Natijani koʻrish" : "Keyingi" }).click();
  }
  await expect(page.getByRole("heading", { name: /Natija: \d\/5/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-practice-result-390.png`, fullPage: true });
});
