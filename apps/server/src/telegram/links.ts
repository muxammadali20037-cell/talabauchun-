import type { Config } from "../config";

/**
 * Mini App URL for web_app buttons. The path is a client-side route only; it
 * never carries secrets. Telegram requires HTTPS for web_app buttons, so in
 * non-HTTPS dev setups no button URL is produced.
 */
export function miniAppUrl(cfg: Config, route = "/"): string | null {
  if (!cfg.PUBLIC_BASE_URL.startsWith("https://")) return null;
  return `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/#${route.startsWith("/") ? route : "/" + route}`;
}

/** Main Mini App direct link with a start parameter (t.me/<bot>?startapp=<param>). */
export function startAppLink(cfg: Config, param: string): string | null {
  if (!cfg.TELEGRAM_BOT_USERNAME) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(param)) throw new Error("invalid startapp param");
  return `https://t.me/${cfg.TELEGRAM_BOT_USERNAME}?startapp=${param}`;
}

/** Link that asks the user to pick a group and adds the bot there with /start <param>. */
export function startGroupLink(cfg: Config, param: string): string | null {
  if (!cfg.TELEGRAM_BOT_USERNAME) return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(param)) throw new Error("invalid startgroup param");
  return `https://t.me/${cfg.TELEGRAM_BOT_USERNAME}?startgroup=${param}`;
}
