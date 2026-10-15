import { describe, expect, it } from "vitest";
import { latinToCyrillic, normalizeUzbekLatin } from "./translit";
import { dictionaries } from "./i18n/index";

describe("latinToCyrillic", () => {
  it("handles digraphs and okina letters", () => {
    expect(latinToCyrillic("Oʻzbekiston")).toBe("Ўзбекистон");
    expect(latinToCyrillic("shahar")).toBe("шаҳар");
    expect(latinToCyrillic("Choʻl")).toBe("Чўл");
    expect(latinToCyrillic("gʻalaba")).toBe("ғалаба");
    expect(latinToCyrillic("yangi yil")).toBe("янги йил");
    expect(latinToCyrillic("maʼno")).toBe("маъно");
    expect(latinToCyrillic("ekran")).toBe("экран");
    expect(latinToCyrillic("SH")).toBe("Ш");
  });
  it("normalizes apostrophe look-alikes", () => {
    expect(normalizeUzbekLatin("o'qish g`oya")).toBe("oʻqish gʻoya");
    expect(latinToCyrillic("o'qish")).toBe("ўқиш");
  });
  it("keeps placeholders, commands and urls", () => {
    expect(latinToCyrillic("Salom, {name}! /help https://t.me/x")).toBe("Салом, {name}! /help https://t.me/x");
  });
  it("derives a complete Cyrillic dictionary without Latin leftovers", () => {
    const cyr = dictionaries["uz-Cyrl"];
    const flat: string[] = [];
    const walk = (o: unknown) => {
      if (typeof o === "string") flat.push(o);
      else for (const v of Object.values(o as object)) walk(v);
    };
    walk(cyr);
    const allowed = /TALABA AI|Telegram|Anthropic \(Claude\) API|Mini App|\bID\b|PDF|DOCX|PPTX|TXT|JPG\/PNG|CSV\/XLSX|OCR|AI|Quiz Studio|Academic Clean|Modern Data|Creative Seminar|\{[a-z]+\}|<\/?b>|\/[a-z_]+|https?:\S+|MB/g;
    const leftovers = flat
      .map((s) => s.replace(allowed, ""))
      .filter((s) => /[A-Za-z]/.test(s));
    expect(leftovers).toEqual([]);
  });
});
