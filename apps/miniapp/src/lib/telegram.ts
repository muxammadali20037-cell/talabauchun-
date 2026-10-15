/** Thin typed wrapper over window.Telegram.WebApp (official SDK loaded from telegram.org). */
type ThemeParams = Record<string, string | undefined>;
type Inset = { top: number; bottom: number; left: number; right: number };
export type TgWebApp = {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { language_code?: string } };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: ThemeParams;
  viewportStableHeight: number;
  safeAreaInset?: Inset;
  contentSafeAreaInset?: Inset;
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  enableClosingConfirmation?(): void;
  disableClosingConfirmation?(): void;
  onEvent(e: string, cb: () => void): void;
  offEvent(e: string, cb: () => void): void;
  openTelegramLink(url: string): void;
  openLink(url: string, opts?: { try_instant_view?: boolean }): void;
  downloadFile?(params: { url: string; file_name: string }, cb?: (ok: boolean) => void): void;
  showConfirm?(message: string, cb: (ok: boolean) => void): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void; isVisible: boolean };
  MainButton: { hide(): void };
  HapticFeedback?: { impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void; notificationOccurred(t: "error" | "success" | "warning"): void; selectionChanged(): void };
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export function tg(): TgWebApp | null {
  const w = window.Telegram?.WebApp;
  // Outside Telegram the SDK still loads but initData is empty.
  return w && typeof w.ready === "function" ? w : null;
}

export function insideTelegram(): boolean {
  return !!tg()?.initData;
}

/** Applies colour scheme + safe-area insets as CSS variables and keeps them updated. */
export function initTelegramChrome() {
  const w = tg();
  const root = document.documentElement;
  const apply = () => {
    const dark = w ? w.colorScheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "dark" : "light";
    const bg = getComputedStyle(root).getPropertyValue("--c-bg").trim() || (dark ? "#0b1120" : "#f8fafc");
    if (w?.isVersionAtLeast?.("6.1")) {
      try {
        w.setHeaderColor?.(bg);
        w.setBackgroundColor?.(bg);
        if (w.isVersionAtLeast("7.10")) w.setBottomBarColor?.(getComputedStyle(root).getPropertyValue("--c-surface").trim());
      } catch {
        /* older clients */
      }
    }
    const set = (name: string, v?: number) => root.style.setProperty(name, `${v ?? 0}px`);
    set("--tg-safe-area-inset-top", w?.safeAreaInset?.top);
    set("--tg-safe-area-inset-bottom", w?.safeAreaInset?.bottom);
    set("--tg-safe-area-inset-left", w?.safeAreaInset?.left);
    set("--tg-safe-area-inset-right", w?.safeAreaInset?.right);
    set("--tg-content-safe-area-inset-top", w?.contentSafeAreaInset?.top);
    if (w?.viewportStableHeight) root.style.setProperty("--tg-viewport-stable-height", `${w.viewportStableHeight}px`);
  };
  apply();
  if (w) {
    w.ready();
    w.expand();
    if (w.isVersionAtLeast?.("7.7")) w.disableVerticalSwipes?.();
    for (const e of ["themeChanged", "safeAreaChanged", "contentSafeAreaChanged", "viewportChanged"]) w.onEvent(e, apply);
    w.MainButton?.hide();
  } else {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
  }
  // Hide fixed bottom bars while the on-screen keyboard is likely open (text field focused).
  document.addEventListener("focusin", (e) => {
    const el = e.target as HTMLElement;
    if (el.matches("input:not([type=checkbox]):not([type=radio]), textarea, select")) document.body.classList.add("kb-open");
  });
  document.addEventListener("focusout", () => setTimeout(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !a.matches("input, textarea, select")) document.body.classList.remove("kb-open");
  }, 50));
}

export function haptic(kind: "success" | "error" | "warning" | "light") {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  if (kind === "light") h.impactOccurred("light");
  else h.notificationOccurred(kind);
}

/** Share through Telegram's own share sheet — an explicit user action; the app never posts by itself. */
export function shareToTelegram(url: string, text: string) {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  const w = tg();
  if (w) w.openTelegramLink(share);
  else window.open(share, "_blank", "noopener");
}

export function openTelegramLink(url: string) {
  const w = tg();
  if (w) w.openTelegramLink(url);
  else window.open(url, "_blank", "noopener");
}

export function downloadFile(url: string, fileName: string) {
  const w = tg();
  const abs = new URL(url, window.location.origin).toString();
  if (w?.downloadFile && w.isVersionAtLeast("8.0")) {
    w.downloadFile({ url: abs, file_name: fileName });
    return;
  }
  const a = document.createElement("a");
  a.href = abs;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
