import { describe, expect, it } from "vitest";
import { parseQaText, parseQuestionList } from "./parse-input";

describe("parseQaText", () => {
  it("parses numbered question + Javob lines", () => {
    const r = parseQaText("1. Talab nima?\nJavob: Xarid qilishga tayyor miqdor\n\n2. Inflyatsiya nima?\nJavob: Narxlar o‘sishi");
    expect(r.items.map((i) => [i.question, i.answer])).toEqual([
      ["Talab nima?", "Xarid qilishga tayyor miqdor"],
      ["Inflyatsiya nima?", "Narxlar o‘sishi"],
    ]);
  });
  it("parses options with a marked or lettered answer", () => {
    const r = parseQaText("1. Pul nechta funksiya bajaradi?\nA) uchta\n*B) to‘rtta\nC) beshta\nD) ikkita\n\n2) Deflyatsiya nima?\na) narx oshishi\nb) narx pasayishi\nc) ish haqi\nd) soliq\nJavob: b");
    expect(r.items[0]!.options!.filter((o) => o.correct).map((o) => o.text)).toEqual(["to‘rtta"]);
    expect(r.items[1]!.options!.filter((o) => o.correct).map((o) => o.text)).toEqual(["narx pasayishi"]);
  });
  it("supports Russian and English labels", () => {
    const r = parseQaText("Вопрос: Что такое инфляция?\nОтвет: Рост цен\nQ: What is demand?\nAnswer: Willingness to buy");
    expect(r.items.map((i) => i.answer)).toEqual(["Рост цен", "Willingness to buy"]);
  });
});

describe("parseQuestionList", () => {
  it("strips numbering", () => {
    expect(parseQuestionList("1. Birinchi savol?\n2) Ikkinchi savol?\n\nUchinchi savol?")).toEqual(["Birinchi savol?", "Ikkinchi savol?", "Uchinchi savol?"]);
  });
});
