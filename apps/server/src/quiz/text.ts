import { stemToken } from "../search/retrieve";

/** Normalises apostrophe variants, case, punctuation and whitespace for matching. */
export function norm(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[ʻʼ'`‘’´]/g, "'")
    .replace(/[«»“”"„]/g, "")
    .replace(/[—–]/g, "-")
    .replace(/[^\p{L}\p{N}'%\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return (norm(s).match(/[\p{L}\p{N}']+/gu) ?? []).filter((t) => t.length > 1);
}

export function stems(s: string): string[] {
  return tokens(s).map(stemToken);
}

const FILLER = new Set(["va", "bu", "bilan", "uchun", "deb", "ham", "esa", "yoki", "the", "a", "an", "of", "and", "или", "и", "в", "на"]);
export function contentStems(s: string): string[] {
  return stems(s).filter((t) => !FILLER.has(t));
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Share of `needle` stems that occur (as prefixes either way) in `hay`. */
export function coverage(needle: string[], hay: string[]): number {
  if (!needle.length) return 0;
  let hit = 0;
  for (const n of needle) if (hay.some((h) => h === n || (n.length >= 4 && h.startsWith(n)) || (h.length >= 4 && n.startsWith(h)))) hit++;
  return hit / needle.length;
}

export function levenshteinRatio(a: string, b: string): number {
  const s = norm(a);
  const t = norm(b);
  if (s === t) return 1;
  const m = s.length;
  const n = t.length;
  if (!m || !n) return 0;
  const prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (s[i - 1] === t[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - prev[n]! / Math.max(m, n);
}

export function numbersIn(s: string): string[] {
  return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((x) => x.replace(",", "."));
}

/**
 * Locates `quote` inside `text` and returns the exact original substring.
 * Exact match after normalisation first; otherwise the best sentence-window
 * with ≥ 90% stem coverage (fuzzy). Returns null when the source does not
 * contain it — the caller must then drop the citation.
 */
export function locateQuote(quote: string, text: string): { quote: string; method: "exact_quote" | "fuzzy_quote" } | null {
  const q = norm(quote);
  if (q.length < 3) return null;
  const sentences = splitKeep(text);
  // exact (normalised) containment, return the original sentence span(s)
  const nt = norm(text);
  if (nt.includes(q)) {
    const span = sentences.filter((s) => q.includes(norm(s)) || norm(s).includes(q) || overlapsQuote(norm(s), q));
    const out = span.length ? span.join(" ") : quote;
    return { quote: out.trim().slice(0, 1200), method: "exact_quote" };
  }
  const qs = contentStems(quote);
  let best: { s: string; cov: number } | null = null;
  for (let i = 0; i < sentences.length; i++) {
    for (let w = 1; w <= 3 && i + w <= sentences.length; w++) {
      const win = sentences.slice(i, i + w).join(" ");
      const cov = coverage(qs, contentStems(win));
      if (!best || cov > best.cov || (cov === best.cov && win.length < best.s.length)) best = { s: win, cov };
    }
  }
  if (best && best.cov >= 0.9) return { quote: best.s.trim().slice(0, 1200), method: "fuzzy_quote" };
  return null;
}

function overlapsQuote(sentenceNorm: string, q: string): boolean {
  if (sentenceNorm.length < 10) return false;
  const head = sentenceNorm.slice(0, Math.min(30, sentenceNorm.length));
  return q.includes(head);
}

export function splitKeep(text: string): string[] {
  return (text.match(/[^.!?…\n]+(?:[.!?…]+|\n|$)/gu) ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}
