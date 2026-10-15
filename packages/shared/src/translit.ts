/**
 * Uzbek Latin -> Cyrillic transliteration following the 1995 Latin alphabet
 * (oʻ, gʻ with U+02BB; tutuq belgisi ʼ U+02BC). Apostrophe look-alikes are
 * normalised first so user-typed text (o', g`, o‘) is handled as well.
 *
 * Used to derive the uz-Cyrl interface dictionary from the uz (Latin) one and
 * to offer a Cyrillic view of user content. Loanword spellings that differ
 * between scripts (e.g. "ts"/"ц") are intentionally not guessed.
 */
const SIMPLE: Record<string, string> = {
  a: "а", b: "б", d: "д", f: "ф", g: "г", h: "ҳ", i: "и", j: "ж", k: "к", l: "л",
  m: "м", n: "н", o: "о", p: "п", q: "қ", r: "р", s: "с", t: "т", u: "у", v: "в",
  x: "х", y: "й", z: "з", c: "к", w: "в",
};

const OKINA = "ʻ"; // ʻ
const TUTUQ = "ʼ"; // ʼ

export function normalizeUzbekLatin(input: string): string {
  // o/g followed by any apostrophe-like char -> oʻ / gʻ
  let s = input.replace(/([oOgG])['`‘’ʻʼ´]/g, (_m, ch: string) => ch + OKINA);
  // remaining apostrophes between letters -> tutuq belgisi
  s = s.replace(/([A-Za-z])['`’ʼ´]/g, (_m, ch: string) => ch + TUTUQ);
  return s;
}

function isVowelLatin(ch: string | undefined): boolean {
  return !!ch && /[aeiouAEIOU]/.test(ch);
}

function applyCase(src: string, out: string, nextSrc: string | undefined): string {
  if (src === src.toLowerCase()) return out;
  // Title-case digraph ("Sh") vs all-caps ("SH"): look at the following char.
  const allCaps = src.length > 1 ? src === src.toUpperCase() : !!nextSrc && /[A-Z]/.test(nextSrc);
  if (out.length === 1) return out.toUpperCase();
  return allCaps ? out.toUpperCase() : out.charAt(0).toUpperCase() + out.slice(1);
}

export function latinToCyrillic(input: string): string {
  const s = normalizeUzbekLatin(input);
  let out = "";
  let i = 0;
  // Do not transliterate placeholders like {name}, URLs or /commands.
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "{") {
      const end = s.indexOf("}", i);
      if (end > i) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    if (ch === "/" && /[a-z]/.test(s[i + 1] ?? "") && (i === 0 || /\s/.test(s[i - 1]!))) {
      const m = /^\/[a-z_]+/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (s.startsWith("http", i)) {
      const m = /^https?:\/\/\S+/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const two = s.slice(i, i + 2);
    const lower2 = two.toLowerCase();
    const prev = s[i - 1];
    const atWordStart = i === 0 || !/[A-Za-zʻʼ]/.test(prev ?? "");
    if (lower2 === "o" + OKINA) { out += applyCase(two[0]!, "ў", s[i + 2]); i += 2; continue; }
    if (lower2 === "g" + OKINA) { out += applyCase(two[0]!, "ғ", s[i + 2]); i += 2; continue; }
    if (lower2 === "sh") { out += applyCase(two, "ш", s[i + 2]); i += 2; continue; }
    if (lower2 === "ch") { out += applyCase(two, "ч", s[i + 2]); i += 2; continue; }
    if (lower2 === "yo") { out += applyCase(two, "ё", s[i + 2]); i += 2; continue; }
    if (lower2 === "yu") { out += applyCase(two, "ю", s[i + 2]); i += 2; continue; }
    if (lower2 === "ya") { out += applyCase(two, "я", s[i + 2]); i += 2; continue; }
    if (lower2 === "ye") { out += applyCase(two, "е", s[i + 2]); i += 2; continue; }
    if (ch === TUTUQ) { out += "ъ"; i += 1; continue; }
    const lower = ch.toLowerCase();
    if (lower === "e") {
      const e = atWordStart || isVowelLatin(prev) ? "э" : "е";
      out += applyCase(ch, e, s[i + 1]);
      i += 1;
      continue;
    }
    const mapped = SIMPLE[lower];
    out += mapped ? applyCase(ch, mapped, s[i + 1]) : ch;
    i += 1;
  }
  return out;
}
