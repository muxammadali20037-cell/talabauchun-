import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast } from "./contrast";

const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
function tokens(selector: string) {
  const block = css.split(selector)[1]!.split("}")[0]!;
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

describe("design token contrast", () => {
  for (const [name, sel] of [["light", ":root {"], ["dark", ':root[data-theme="dark"] {']] as const) {
    const t = tokens(sel);
    it(`${name}: text on backgrounds`, () => {
      expect(contrast(t["c-text"]!, t["c-bg"]!)).toBeGreaterThanOrEqual(7);
      expect(contrast(t["c-text"]!, t["c-surface"]!)).toBeGreaterThanOrEqual(7);
      expect(contrast(t["c-text-2"]!, t["c-surface"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-text-3"]!, t["c-surface"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-text-3"]!, t["c-surface-2"]!)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: buttons, links and status text`, () => {
      expect(contrast(t["c-on-primary"]!, t["c-primary"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-primary"]!, t["c-surface"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-primary"]!, t["c-primary-soft"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-success"]!, t["c-success-bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-warn"]!, t["c-warn-bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["c-danger"]!, t["c-danger-bg"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
