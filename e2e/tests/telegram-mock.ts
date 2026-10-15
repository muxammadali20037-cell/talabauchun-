import type { Page } from "@playwright/test";
import { signInitData } from "../../apps/server/src/auth/init-data";
import { TEST_BOT_TOKEN } from "../playwright.config";

/**
 * Stand-in for window.Telegram.WebApp inside the test browser. initData is
 * signed with the test bot token exactly like Telegram does, so the server's
 * real signature check runs. The official SDK request is blocked (no network).
 */
export async function asTelegramUser(page: Page, user: { id: number; first_name: string; language_code?: string }, opts: { startParam?: string; colorScheme?: "light" | "dark"; insets?: { top: number; bottom: number } } = {}) {
  const initData = signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: `AAE${user.id}`,
      user: JSON.stringify({ ...user, allows_write_to_pm: true }),
      ...(opts.startParam ? { start_param: opts.startParam } : {}),
    },
    TEST_BOT_TOKEN,
  );
  await page.route("https://telegram.org/**", (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  await page.addInitScript(
    ({ initData, user, startParam, colorScheme, insets }) => {
      const noop = () => {};
      (window as unknown as { __tg: { opened: string[]; back: boolean } }).__tg = { opened: [], back: false };
      const state = (window as unknown as { __tg: { opened: string[]; back: boolean } }).__tg;
      (window as unknown as { Telegram: unknown }).Telegram = {
        WebApp: {
          initData,
          initDataUnsafe: { user, start_param: startParam },
          version: "9.1",
          platform: "android",
          colorScheme,
          themeParams: {},
          viewportStableHeight: window.innerHeight,
          safeAreaInset: { top: insets.top, bottom: insets.bottom, left: 0, right: 0 },
          contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
          ready: noop, expand: noop, isVersionAtLeast: () => true,
          setHeaderColor: noop, setBackgroundColor: noop, setBottomBarColor: noop, disableVerticalSwipes: noop,
          onEvent: noop, offEvent: noop,
          openTelegramLink: (u: string) => state.opened.push(u),
          openLink: (u: string) => state.opened.push(u),
          showConfirm: (_m: string, cb: (ok: boolean) => void) => cb(true),
          BackButton: { show: () => (state.back = true), hide: () => (state.back = false), onClick: noop, offClick: noop, isVisible: false },
          MainButton: { hide: noop },
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
        },
      };
    },
    { initData, user, startParam: opts.startParam ?? null, colorScheme: opts.colorScheme ?? "light", insets: opts.insets ?? { top: 0, bottom: 0 } },
  );
}

export async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
