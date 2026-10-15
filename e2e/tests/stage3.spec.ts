import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { asTelegramUser, noHorizontalScroll } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");
export const E2E_ADMIN_TG = 4500001;

test("plan & credits page, support request answered by an admin, data export download and account deletion", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await asTelegramUser(page, { id: 4500010, first_name: "Zarina", language_code: "uz" });

  // pricing is explained before anything is charged; payments are off in this environment and the page says so
  await page.goto("/app/#/billing");
  await expect(page.getByRole("heading", { name: /Balans/ })).toBeVisible();
  await expect(page.getByText("Nima qancha turadi")).toBeVisible();
  await expect(page.getByText("Toʻlovlar hozircha yoqilmagan").first()).toBeVisible();
  await expect(page.getByText("Bepul oylik kredit")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/40-billing-390.png`, fullPage: true });

  // support request from the Mini App
  await page.goto("/app/#/support");
  await page.getByLabel("Xabar").fill("PDF faylimning 3-sahifasi oʻqilmadi, nima qilay?");
  await page.getByRole("button", { name: "Yuborish" }).click();
  await expect(page.getByText(/qabul qilindi|#\d+/).first()).toBeVisible();

  // an admin answers it in the admin panel
  const actx = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const ap = await actx.newPage();
  await asTelegramUser(ap, { id: E2E_ADMIN_TG, first_name: "Operator", language_code: "uz" });
  await ap.goto("/app/#/admin");
  await expect(ap.getByRole("heading", { name: "Administrator paneli" })).toBeVisible();
  await expect(ap.getByText("Ochiq murojaatlar")).toBeVisible();
  await ap.screenshot({ path: `${SHOTS}/41-admin-overview-1024.png`, fullPage: true });
  await ap.goto("/app/#/admin/tickets");
  await expect(ap.getByText("PDF faylimning 3-sahifasi")).toBeVisible();
  await ap.getByLabel("Javob").fill("Sahifa skan sifati past. Yaxshiroq nusxa yuboring.");
  await ap.getByRole("button", { name: "Javob berish va yopish" }).click();
  await expect(ap.getByText("Hal qilindi").first()).toBeVisible();
  await ap.goto("/app/#/admin/audit");
  await expect(ap.getByText("ticket.reply")).toBeVisible();
  await actx.close();

  await page.reload();
  await expect(page.getByText("Sahifa skan sifati past. Yaxshiroq nusxa yuboring.")).toBeVisible();
  await expect(page.getByText("Hal qilindi").first()).toBeVisible();

  // a non-admin cannot open the panel
  await page.goto("/app/#/admin");
  await expect(page.getByRole("heading", { name: "Administrator paneli" })).toHaveCount(0);

  // data export: upload something, export, download the zip and check it contains the original file
  await page.goto("/app/#/library/upload");
  await page.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "source/savollar.txt"));
  await page.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(page.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
  await page.goto("/app/#/profile/data");
  await page.getByRole("button", { name: "Eksport tayyorlash" }).click();
  await expect(page.getByRole("button", { name: "Yuklab olish" })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/42-my-data-390.png`, fullPage: true });
  await page.getByRole("button", { name: "Yuklab olish" }).click();
  const token = await page.evaluate(() => sessionStorage.getItem("talaba.token"));
  const data = await (await request.get("/api/me/data", { headers: { authorization: `Bearer ${token}` } })).json();
  const dl = await request.get(data.items[0].download.url);
  expect(dl.status()).toBe(200);
  const zip = await JSZip.loadAsync(await dl.body());
  expect(Object.keys(zip.files).some((n) => n.startsWith("files/") && n.endsWith("savollar.txt"))).toBe(true);

  // account deletion with typed confirmation
  await page.getByRole("button", { name: "Hisobni oʻchirish…" }).click();
  await expect(page.getByRole("button", { name: "Butunlay oʻchirish" })).toBeDisabled();
  await page.getByLabel("Tasdiqlash uchun DELETE deb yozing").fill("DELETE");
  await page.getByRole("button", { name: "Butunlay oʻchirish" }).click();
  await expect(page.getByText("Oʻchirish boshlandi")).toBeVisible();
  await expect.poll(async () => (await request.get("/api/me", { headers: { authorization: `Bearer ${token}` } })).status(), { timeout: 30_000 }).toBe(401);
  await ctx.close();
});
