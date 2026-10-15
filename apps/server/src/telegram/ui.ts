import { translate, type Lang, type MessageKey } from "@talaba/shared";
import type { Config } from "../config";
import { miniAppUrl } from "./links";

export type InlineButton = { text: string; callback_data?: string; web_app?: { url: string }; url?: string };
export type Keyboard = { inline_keyboard: InlineButton[][] };

export function t(lang: Lang, key: MessageKey, vars?: Record<string, string | number>) {
  return translate(lang, key, vars);
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function mainMenu(cfg: Config, lang: Lang): Keyboard {
  const app = miniAppUrl(cfg, "/");
  const rows: InlineButton[][] = [];
  if (app) rows.push([{ text: t(lang, "bot.menuOpenApp"), web_app: { url: app } }]);
  rows.push([{ text: t(lang, "bot.menuQuiz"), callback_data: "m:quiz" }, { text: t(lang, "bot.menuSlides"), callback_data: "m:slides" }]);
  rows.push([{ text: t(lang, "bot.menuSendBook"), callback_data: "m:book" }, { text: t(lang, "bot.menuAsk"), callback_data: "m:ask" }]);
  rows.push([{ text: t(lang, "bot.menuMyWork"), callback_data: "m:work" }, { text: "🌐 " + t(lang, "profile.language"), callback_data: "m:lang" }]);
  return { inline_keyboard: rows };
}

export function appButton(cfg: Config, lang: Lang, route: string, labelKey: MessageKey = "common.open"): InlineButton[] {
  const url = miniAppUrl(cfg, route);
  return url ? [{ text: t(lang, labelKey), web_app: { url } }] : [];
}

/** uuid <-> 22-char base64url, to fit ids into 64-byte callback_data. */
export function shortId(uuid: string): string {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}
export function longId(short: string): string {
  const hex = Buffer.from(short, "base64url").toString("hex");
  if (hex.length !== 32) throw new Error("bad id");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
