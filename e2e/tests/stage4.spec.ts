import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTelegramUser } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../../apps/server/test/fixtures");
const SHOTS = path.join(here, "../../docs/evidence/e2e");

async function uploadReady(p: Page) {
  await p.goto("/app/#/library/upload");
  await p.getByLabel("Fayl tanlang").setInputFiles(path.join(FIX, "generated/iqtisodiyot.pdf"));
  await p.getByRole("dialog").getByRole("button", { name: "Fayl yuklash" }).click();
  await expect(p.getByText("Foydalanishga tayyor").first()).toBeVisible({ timeout: 60_000 });
}

async function publishedQuiz(p: Page) {
  await uploadReady(p);
  await p.getByRole("link", { name: /Quiz yaratish/ }).first().click();
  await p.getByRole("button", { name: "5", exact: true }).click();
  await p.getByRole("button", { name: "Quiz yaratish" }).last().click();
  await expect(p.getByText(/ta savol/).first()).toBeVisible({ timeout: 60_000 });
  const cards = p.locator("article");
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const b = cards.nth(i).getByRole("button", { name: /Tasdiqlash/ });
    if (await b.count()) await b.click();
    await expect(cards.nth(i).getByText("Tasdiqlangan").first()).toBeVisible();
  }
  await p.getByRole("button", { name: "Nashr qilish" }).click();
  await expect(p.getByText("Nashr qilingan").first()).toBeVisible();
}

async function sharedStartParam(p: Page) {
  await p.getByRole("button", { name: "Ulashish" }).click();
  const opened = await p.evaluate(() => (window as unknown as { __tg: { opened: string[] } }).__tg.opened);
  const shareUrl = decodeURIComponent(opened.at(-1)!.split("url=")[1]!.split("&")[0]!);
  expect(shareUrl).toMatch(/^https:\/\/t\.me\/talaba_test_bot\?startapp=r[A-Za-z0-9_-]{22}$/);
  return shareUrl.split("startapp=")[1]!;
}

test("assignment: students solve once before the deadline, answers stay hidden until the teacher closes it", async ({ browser }) => {
  const teacher = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tp = await teacher.newPage();
  await asTelegramUser(tp, { id: 4600001, first_name: "Ustoz", language_code: "uz" });
  await publishedQuiz(tp);
  await tp.getByRole("button", { name: /Oʻynash/ }).click();
  const sheet = tp.getByRole("dialog");
  await expect(sheet.getByText("Topshiriq berish (mustaqil vaqtda)")).toBeVisible();
  await sheet.getByRole("button", { name: "24 soat" }).click();
  await sheet.getByRole("button", { name: "Topshiriq yaratish" }).click();
  await expect(tp.getByText("Ochiq", { exact: true })).toBeVisible();
  await expect(tp.getByText(/Muddat: /)).toBeVisible();
  await expect(tp.getByText("Topshirganlar: 0 / 0")).toBeVisible();
  const startParam = await sharedStartParam(tp);

  // the student opens the startapp link and lands on the assignment, not on a live room
  const student = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const sp = await student.newPage();
  await asTelegramUser(sp, { id: 4600002, first_name: "Nodira", language_code: "uz" }, { startParam });
  await sp.goto("/app/");
  await sp.getByRole("button", { name: "Qoʻshilish" }).click();
  await expect(sp).toHaveURL(/#\/assignment\//);
  await expect(sp.getByText("Toʻgʻri javoblar va ball muddat tugaguncha koʻrsatilmaydi")).toBeVisible();
  await sp.screenshot({ path: `${SHOTS}/50-assignment-student-360.png`, fullPage: true });
  await sp.getByRole("button", { name: "Boshlash" }).click();
  await expect(sp).toHaveURL(/#\/attempt\//);

  // every answer is accepted without revealing whether it was correct
  for (let i = 1; i <= 5; i++) {
    await expect(sp.getByText(`${i}/5-savol`)).toBeVisible();
    await sp.locator("button.choice").first().click();
    await sp.getByRole("button", { name: "Tekshirish" }).click();
    await expect(sp.getByText("Javob qabul qilindi").first()).toBeVisible();
    await expect(sp.getByText(/Toʻgʻri!|Notoʻgʻri/)).toHaveCount(0);
  }
  await expect(sp.getByRole("heading", { name: "Topshirildi" })).toBeVisible();
  await expect(sp.getByText("Javob berildi: 5 / 5")).toBeVisible();
  await sp.screenshot({ path: `${SHOTS}/51-assignment-submitted-360.png`, fullPage: true });

  // one attempt per student: after submitting there is no way to start again
  await sp.getByRole("link", { name: "Ortga" }).click();
  await expect(sp.getByText("Topshirildi ✓ Natija muddat tugagach ochiladi.")).toBeVisible();
  await expect(sp.getByRole("button", { name: /Boshlash|Davom ettirish/ })).toHaveCount(0);

  // teacher sees progress, closes the assignment early; results open for everyone
  await tp.reload();
  await expect(tp.getByText("Topshirganlar: 1 / 1")).toBeVisible();
  await expect(tp.getByText("Nodira")).toBeVisible();
  await tp.getByRole("button", { name: "Hozir yakunlash" }).click();
  await expect(tp.getByText("Yopilgan", { exact: true })).toBeVisible();
  await expect(tp.getByRole("button", { name: "Ulashish" })).toHaveCount(0);
  await tp.screenshot({ path: `${SHOTS}/52-assignment-closed-teacher-390.png`, fullPage: true });

  await sp.reload();
  await expect(sp.getByText("Yopilgan", { exact: true })).toBeVisible();
  await expect(sp.getByRole("heading", { name: /Sizning ballingiz: \d+/ })).toBeVisible();
  await sp.getByRole("link", { name: "Javoblarimni koʻrish" }).click();
  await expect(sp.getByText(/\/5 toʻgʻri|Mashq tugadi/).first()).toBeVisible();
  await sp.screenshot({ path: `${SHOTS}/53-assignment-results-360.png`, fullPage: true });
  await teacher.close();
  await student.close();
});

test("writing helper: references only from entered source metadata, an outline without AI, AI-only modes say so", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await asTelegramUser(p, { id: 4600011, first_name: "Kamola", language_code: "uz" });
  await uploadReady(p);

  // the student fills in the bibliographic data; nothing is invented
  await p.getByRole("button", { name: /Manba maʼlumotlari/ }).click();
  const sheet = p.getByRole("dialog");
  await sheet.getByLabel("Muallif").fill("Karimov A.");
  await sheet.getByLabel("Nashr maʼlumoti").fill("Toshkent: Iqtisodiyot, 2021. — 240 b.");
  await sheet.getByRole("button", { name: "Saqlash" }).click();
  await expect(p.getByText("Saqlandi").first()).toBeVisible();

  await p.goto("/app/#/writing");
  await expect(p.getByText(/U ishni siz uchun yozmaydi/)).toBeVisible();
  await p.getByRole("radio", { name: "Adabiyotlar roʻyxati" }).click();
  await p.locator("label.list-item").first().getByRole("checkbox").check();
  await p.getByRole("button", { name: "Bajarish" }).click();
  const entry = p.locator("ol li").first();
  await expect(entry).toContainText("Karimov A.");
  await expect(entry).toContainText("Toshkent: Iqtisodiyot, 2021. — 240 b.");
  await expect(entry).toContainText(". — Toshkent: Iqtisodiyot, 2021. — 240 b.");
  await expect(entry).not.toContainText("..");
  await p.screenshot({ path: `${SHOTS}/54-writing-bibliography-390.png`, fullPage: true });

  await p.getByRole("radio", { name: "Reja" }).click();
  await p.getByLabel("Mavzu").fill("Inflyatsiya va uning oqibatlari");
  await p.locator("label.list-item").first().getByRole("checkbox").check();
  await p.getByRole("button", { name: "Bajarish" }).click();
  await expect(p.getByText("AI’siz: manba boblaridan tuzilgan skelet")).toBeVisible();
  expect(await p.locator("section.card ol > li").count()).toBeGreaterThan(1);

  // polish and rubric need AI; with no AI configured the button stays off and the reason is shown
  await p.getByRole("radio", { name: "Matnni ravonlashtirish" }).click();
  await expect(p.getByText("Bu rejim AI talab qiladi; AI hozir ulanmagan.")).toBeVisible();
  await expect(p.getByRole("button", { name: "Bajarish" })).toBeDisabled();
  await ctx.close();
});

test("live room: the host appoints a participant as co-host", async ({ browser }) => {
  const host = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const hp = await host.newPage();
  await asTelegramUser(hp, { id: 4600021, first_name: "Ustoz", language_code: "uz" });
  await publishedQuiz(hp);
  await hp.getByRole("button", { name: /Oʻynash/ }).click();
  await hp.getByRole("dialog").getByRole("button", { name: "Xona ochish" }).click();
  await expect(hp.getByRole("heading", { name: "Qatnashchilarni taklif qiling" })).toBeVisible();
  const startParam = await sharedStartParam(hp);

  const guest = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const gp = await guest.newPage();
  await asTelegramUser(gp, { id: 4600022, first_name: "Bekzod", language_code: "uz" }, { startParam });
  await gp.goto("/app/");
  await gp.getByRole("button", { name: "Qoʻshilish" }).click();
  await expect(gp.getByText("Boshlovchi boshlashini kuting…")).toBeVisible();

  await hp.getByLabel("Yordamchi (co-host) tayinlash:").selectOption({ label: "Bekzod" });
  await expect(hp.getByText("Co-host: Bekzod")).toBeVisible();
  await hp.screenshot({ path: `${SHOTS}/55-room-cohost-390.png`, fullPage: true });
  // the co-host can run the room: starting from the guest's side works
  await expect(gp.getByRole("button", { name: /Boshlash/ })).toBeVisible();
  await gp.getByRole("button", { name: /Boshlash/ }).click();
  const q = await gp.locator("h2.break").first().textContent();
  await expect(hp.locator("h2.break").first()).toHaveText(q!);
  await host.close();
  await guest.close();
});
