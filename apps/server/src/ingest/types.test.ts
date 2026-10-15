import { describe, expect, it } from "vitest";
import { reflowLines } from "./types";

describe("reflowLines", () => {
  it("joins wrapped lines inside a sentence and keeps headings", () => {
    expect(reflowLines("1.1. Talab tushunchasi\nTalab — bu tayyor va qodir\nbo‘lgan tovar miqdoridir.\nTalab qonuniga ko‘ra")).toBe(
      "1.1. Talab tushunchasi\nTalab — bu tayyor va qodir bo‘lgan tovar miqdoridir.\nTalab qonuniga ko‘ra",
    );
  });
  it("keeps numbered headings apart but joins numbers that continue a sentence", () => {
    expect(reflowLines("1-bob. Talab va taklif\n1.1. Talab tushunchasi")).toBe("1-bob. Talab va taklif\n1.1. Talab tushunchasi");
    expect(reflowLines("indeks\n110 ga teng bo‘lgani uchun")).toBe("indeks 110 ga teng bo‘lgani uchun");
  });
  it("removes soft hyphenation across lines", () => {
    expect(reflowLines("iqti-\nsodiyot nazariyasi")).toBe("iqtisodiyot nazariyasi");
  });
});
