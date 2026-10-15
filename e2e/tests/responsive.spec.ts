import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asTelegramUser, noHorizontalScroll } from "./telegram-mock";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "../../docs/evidence/e2e");

const ROUTES = ["/", "/create", "/library", "/quiz/new", "/quizzes", "/cards", "/mistakes", "/plans", "/plans/new", "/tutor", "/games/matching", "/groups", "/workspaces/new", "/profile", "/help", "/decks", "/decks/new", "/billing", "/support", "/profile/data", "/writing"];
const WIDTHS = [320, 360, 390, 430, 1024, 1440];

test.setTimeout(360_000);

test("every main screen fits 320–1440 px without horizontal scrolling, in light and dark themes, with safe-area insets", async ({ browser }) => {
  const failures: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme });
      const page = await ctx.newPage();
      await asTelegramUser(page, { id: 4400001, first_name: "Shahzoda", language_code: "uz" }, { colorScheme: scheme, insets: { top: 24, bottom: 34 } });
      for (const r of ROUTES) {
        await page.goto(`/app/#${r}`);
        await expect(page.locator("main h1").first()).toBeVisible();
        if (!(await noHorizontalScroll(page))) failures.push(`${scheme} ${width}px ${r}`);
      }
      if (width === 320 || width === 1440) {
        await page.goto("/app/#/");
        await expect(page.locator("main h1").first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/20-home-${scheme}-${width}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  expect(failures).toEqual([]);
});

test("dark theme keeps readable contrast for body text, buttons and badges", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await asTelegramUser(page, { id: 4400002, first_name: "Kamola", language_code: "uz" }, { colorScheme: "dark" });
  await page.goto("/app/#/create");
  await expect(page.locator("main h1").first()).toBeVisible();
  const ratios = await page.evaluate(() => {
    const lum = (rgb: string) => {
      const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const bgOf = (el: Element | null): string => {
      while (el) {
        const c = getComputedStyle(el).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
        el = el.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const ratio = (el: Element) => {
      const a = lum(getComputedStyle(el).color), b = lum(bgOf(el));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return [...document.querySelectorAll("main h1, main strong, main .caption, nav a")].slice(0, 30).map((el) => ({ text: (el.textContent ?? "").slice(0, 30), r: Math.round(ratio(el) * 100) / 100 }));
  });
  const low = ratios.filter((x) => x.r < 4.5);
  expect(low).toEqual([]);
  await ctx.close();
});
