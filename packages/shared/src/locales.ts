export const LANGS = ["uz", "uz-Cyrl", "ru", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const LANG_LABELS: Record<Lang, string> = {
  uz: "Oʻzbekcha (lotin)",
  "uz-Cyrl": "Ўзбекча (кирилл)",
  ru: "Русский",
  en: "English",
};

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/**
 * Suggest an interface language from Telegram's `language_code` (IETF tag).
 * The suggestion is only a default; the user's explicit choice is stored and wins.
 */
export function suggestLang(telegramLanguageCode: string | undefined | null): Lang {
  const code = (telegramLanguageCode ?? "").toLowerCase();
  if (code.startsWith("uz")) return code.includes("cyrl") ? "uz-Cyrl" : "uz";
  if (code.startsWith("ru") || code.startsWith("kk") || code.startsWith("ky") || code.startsWith("tg")) return "ru";
  if (code.startsWith("en")) return "en";
  // Primary audience is Uzbekistan; unknown languages fall back to Uzbek Latin.
  return "uz";
}

export const DEFAULT_TIMEZONE = "Asia/Tashkent";
