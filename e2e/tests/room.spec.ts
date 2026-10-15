import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTelegramUser } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");

test("host shares a live room; a second account joins via the startapp invite and both play the same question", async ({ browser, request }) => {
  const host = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const hp = await host.newPage();
  await asTelegramUser(hp, { id: 4200001, first_name: "Ustoz", language_code: "uz" });
  await hp.goto("/app/#/library/upload");
  await hp.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "generated/iqtisodiyot.pdf"));
  await hp.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(hp.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
  await hp.getByRole("link", { name: /Quiz yaratish/ }).first().click();
  await hp.getByRole("button", { name: "5", exact: true }).click();
  await hp.getByRole("button", { name: "Quiz yaratish" }).last().click();
  await expect(hp.getByText(/ta savol/).first()).toBeVisible({ timeout: 60_000 });
  // extractive questions need human review: approve each, then publish
  const cards = hp.locator("article");
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const b = cards.nth(i).getByRole("button", { name: /Tasdiqlash/ });
    if (await b.count()) await b.click();
    await expect(cards.nth(i).getByText("Tasdiqlangan").first()).toBeVisible();
  }
  await hp.getByRole("button", { name: "Nashr qilish" }).click();
  await expect(hp.getByText("Nashr qilingan").first()).toBeVisible();
  await hp.getByRole("button", { name: /Oʻynash/ }).click();
  await hp.getByRole("dialog").getByRole("button", { name: "Xona ochish" }).click();
  await expect(hp.getByRole("heading", { name: "Qatnashchilarni taklif qiling" })).toBeVisible();
  // Share uses Telegram's own share sheet with a t.me startapp link (no secrets in the URL)
  await hp.getByRole("button", { name: "Ulashish" }).click();
  const opened = await hp.evaluate(() => (window as unknown as { __tg: { opened: string[] } }).__tg.opened);
  const shareUrl = decodeURIComponent(opened[0]!.split("url=")[1]!.split("&")[0]!);
  expect(shareUrl).toMatch(/^https:\/\/t\.me\/talaba_test_bot\?startapp=r[A-Za-z0-9_-]{22}$/);
  const startParam = shareUrl.split("startapp=")[1]!;
  await hp.screenshot({ path: `${SHOTS}/07-room-lobby-host-390.png`, fullPage: true });

  // participant opens the Mini App from that link: Telegram passes start_param inside signed initData
  const guest = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const gp = await guest.newPage();
  await asTelegramUser(gp, { id: 4200002, first_name: "Jasur", language_code: "uz" }, { startParam });
  await gp.goto("/app/");
  await expect(gp.getByRole("heading", { name: "Jonli xona" })).toBeVisible();
  await gp.getByRole("button", { name: "Qoʻshilish" }).click();
  await expect(gp.getByText("Boshlovchi boshlashini kuting…")).toBeVisible();
  await expect(hp.getByText("Qatnashchilar: 1")).toBeVisible();

  await hp.getByRole("button", { name: /Boshlash/ }).click();
  const hostQ = await hp.locator("h2.break").first().textContent();
  await expect(gp.locator("h2.break").first()).toHaveText(hostQ!);
  await gp.locator("button.choice").first().click();
  await expect(gp.getByText("Javob qabul qilindi").first()).toBeVisible();
  await gp.screenshot({ path: `${SHOTS}/08-room-answer-360.png`, fullPage: true });
  await expect(hp.getByText("Javob berdi: 1/1")).toBeVisible();
  await hp.getByRole("button", { name: "Javobni ochish" }).click();
  await expect(gp.locator("button.choice.correct")).toHaveCount(1);
  await hp.getByRole("button", { name: "Yakunlash" }).last().click();
  await expect(gp.getByRole("heading", { name: "Reyting" })).toBeVisible();
  await gp.screenshot({ path: `${SHOTS}/09-room-results-360.png`, fullPage: true });
  void request;
  await host.close();
  await guest.close();
});
