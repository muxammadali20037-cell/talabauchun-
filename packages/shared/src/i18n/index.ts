import type { Lang } from "../locales";
import { latinToCyrillic } from "../translit";
import { en } from "./en";
import { ru } from "./ru";
import { uz, type Messages } from "./uz";

export type { Messages } from "./uz";

/** Hand-written corrections where mechanical transliteration is not idiomatic. */
const UZ_CYRL_OVERRIDES: Record<string, string> = {
  "app.name": "TALABA AI",
  "quiz.title": "Quiz Studio",
  "deck.themeAcademic": "Academic Clean",
  "deck.themeData": "Modern Data",
  "deck.themeCreative": "Creative Seminar",
};

function mapDeep(obj: unknown, path: string[], fn: (value: string, key: string) => string): unknown {
  if (typeof obj === "string") return fn(obj, path.join("."));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k] = mapDeep(v, [...path, k], fn);
  return out;
}

function cyrillicPreservingMarkup(value: string): string {
  // Keep HTML tags (bot messages use parse_mode=HTML) and brand names intact.
  return value
    .split(/(<[^>]+>|TALABA AI|Telegram|Anthropic \(Claude\) API|Mini App|PDF|DOCX|PPTX|TXT|JPG\/PNG|CSV\/XLSX|OCR|AI|ID|Quiz Studio)/g)
    .map((part, i) => (i % 2 === 1 ? part : latinToCyrillic(part)))
    .join("");
}

const uzCyrl = mapDeep(uz, [], (value, key) => UZ_CYRL_OVERRIDES[key] ?? cyrillicPreservingMarkup(value)) as Messages;

export const dictionaries: Record<Lang, Messages> = { uz, "uz-Cyrl": uzCyrl, ru, en };

export type MessageKey = Leaves<Messages>;
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const parts = key.split(".");
  let node: unknown = dictionaries[lang] ?? dictionaries.uz;
  for (const p of parts) node = (node as Record<string, unknown> | undefined)?.[p];
  let text = typeof node === "string" ? node : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  }
  return text;
}

export function translator(lang: Lang) {
  return (key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
}
