import { contentStems, jaccard, norm, numbersIn } from "./text";
import { capitalize } from "./terms";

const UZ_NUMBER_WORDS = ["bir", "ikki", "uch", "toʻrt", "besh", "olti", "yetti", "sakkiz", "toʻqqiz", "oʻn"];
const NUMWORD_RE = /^(bir|ikki|uch|to[ʻ'‘]?rt|besh|olti|yetti|sakkiz|to[ʻ'‘]?qqiz|o[ʻ'‘]?n)(ta|tasi|nchi)?$/iu;

export const DIRECTION_SETS: Record<string, string[]> = {
  uz: ["ortadi", "kamayadi", "oʻzgarmaydi", "nolga tushadi"],
  ru: ["увеличивается", "уменьшается", "не меняется", "становится нулевым"],
  en: ["increases", "decreases", "stays the same", "drops to zero"],
};
const DIRECTION_WORDS = new Set(["ortadi", "oshadi", "kamayadi", "pasayadi", "o'zgarmaydi", "oʻzgarmaydi", "увеличивается", "уменьшается", "растет", "растёт", "снижается", "increases", "decreases", "rises", "falls"]);

export function isDirectionWord(w: string) {
  return DIRECTION_WORDS.has(norm(w));
}

function numberWordNeighbours(answer: string): string[] | null {
  const m = NUMWORD_RE.exec(norm(answer).replace(/'/g, "ʻ"));
  if (!m) return null;
  const base = norm(m[1]!).replace(/'/g, "ʻ");
  const idx = UZ_NUMBER_WORDS.findIndex((w) => norm(w).replace(/'/g, "ʻ") === base);
  if (idx < 0) return null;
  const suffix = m[2] ?? "";
  const picks = [idx - 1, idx + 1, idx + 2, idx - 2].filter((i) => i >= 0 && i < UZ_NUMBER_WORDS.length && i !== idx);
  return picks.slice(0, 3).map((i) => UZ_NUMBER_WORDS[i] + suffix);
}

function numericNeighbours(answer: string, pool: string[]): string[] {
  const nums = numbersIn(answer);
  if (nums.length !== 1) return [];
  const raw = nums[0]!;
  const n = Number(raw);
  const isYear = /^\d{4}$/.test(raw) && n >= 1800 && n <= 2100;
  const out = new Set<string>();
  // prefer other numbers of the same shape from the material
  for (const p of pool) {
    const pn = numbersIn(p);
    if (pn.length === 1 && pn[0] !== raw && (isYear ? /^\d{4}$/.test(pn[0]!) : true)) out.add(answer.replace(raw, pn[0]!));
    if (out.size >= 3) break;
  }
  const deltas = isYear ? [1, -1, 2, -3] : Number.isInteger(n) ? (n < 10 ? [1, -1, 2] : [Math.round(n * 0.1) || 1, -(Math.round(n * 0.1) || 1), Math.round(n * 0.25) || 2]) : [n * 0.1, -n * 0.1, n * 0.5];
  for (const d of deltas) {
    if (out.size >= 3) break;
    const v = isYear || Number.isInteger(n) ? Math.round(n + d) : Math.round((n + d) * 100) / 100;
    if (v !== n && v >= 0) out.add(answer.replace(raw, String(v)));
  }
  return [...out].slice(0, 3);
}

/**
 * Extractive distractors: values of the same kind taken from the material
 * itself (other defined terms, other answers, nearby numbers), never random
 * words. Returns fewer than requested when the material does not offer enough
 * plausible alternatives; the question then stays in review.
 */
export function extractiveDistractors(answer: string, pool: string[], n = 3, lang = "uz"): string[] {
  const nw = numberWordNeighbours(answer);
  if (nw) return nw.slice(0, n);
  if (numbersIn(answer).length === 1 && contentStems(answer.replace(/\d+([.,]\d+)?/g, "")).length <= 2) return numericNeighbours(answer, pool).slice(0, n);
  if (isDirectionWord(answer)) {
    const set = DIRECTION_SETS[lang.startsWith("uz") ? "uz" : lang] ?? DIRECTION_SETS.uz!;
    const normAns = norm(answer);
    const synonyms: Record<string, string> = { oshadi: "ortadi", pasayadi: "kamayadi" };
    const canonical = synonyms[normAns] ?? normAns;
    return set.filter((w) => norm(w) !== canonical && norm(w) !== normAns).slice(0, n);
  }
  const aStems = contentStems(answer);
  const aWords = answer.trim().split(/\s+/).length;
  const scored = [...new Set(pool.map((p) => p.trim()).filter(Boolean))]
    .filter((p) => {
      const np = norm(p);
      const na = norm(answer);
      if (np === na || np.includes(na) || na.includes(np)) return false;
      return jaccard(contentStems(p), aStems) < 0.5;
    })
    .map((p) => ({ p, score: -Math.abs(p.trim().split(/\s+/).length - aWords) - Math.abs(p.length - answer.length) / 40 }))
    .sort((a, b) => b.score - a.score);
  const isCapital = /^\p{Lu}/u.test(answer.trim());
  return scored.slice(0, n).map((s) => (isCapital ? capitalize(s.p) : s.p));
}
