import { contentStems, splitKeep } from "./text";

export type Definition = { term: string; definition: string; sentence: string; chunkIndex: number };

const DASH_BU = /^\s*([\p{Lu}][\p{L}ʻʼ'‘’\- ]{1,60}?)\s+[—–-]\s+(?:bu|бу|это)\s+(.{8,400}?)[.!]?\s*$/u;
const DASH_PLAIN = /^\s*([\p{Lu}][\p{L}ʻʼ'‘’\- ]{1,40}?)\s+[—–]\s+(.{8,400}?)[.!]?\s*$/u;
const DEB_ATALADI = /^(.{8,300}?)\s+((?:[\p{L}ʻʼ'‘’-]+\s+){0,2}[\p{L}ʻʼ'‘’-]+)\s+deb\s+(?:ataladi|aytiladi|nomlanadi)\.?\s*$/iu;
const EN_IS = /^\s*(?:An?\s+|The\s+)?([\p{Lu}][\p{L}\- ]{1,40}?)\s+(?:is defined as|refers to)\s+(.{8,400}?)\.?\s*$/u;
const RU_NAZ = /^(.{8,300}?)\s+называется\s+([\p{L}\- ]{2,50}?)\.?\s*$/iu;

/** Drops the Uzbek copula "-dir" ("miqdoridir" → "miqdori") but never shortens real words like "qodir". */
function stripCopula(s: string): string {
  return s.replace(/(\p{L}{4,})(dir|дир)$/u, "$1").replace(/\s+$/, "");
}

/**
 * Finds definitions in source text ("X — bu Y", "Y … X deb ataladi",
 * "X — это Y", "X is defined as Y", "Y называется X"). For "deb ataladi"
 * the term length (1–3 words) is chosen by whether that phrase recurs
 * elsewhere in the material, which avoids swallowing words of the definition.
 */
export function findDefinitions(chunks: string[]): Definition[] {
  const out: Definition[] = [];
  chunks.forEach((chunk, chunkIndex) => {
    for (const sentence of splitKeep(chunk)) {
      let m = DASH_BU.exec(sentence) ?? EN_IS.exec(sentence);
      if (m) {
        out.push({ term: m[1]!.trim(), definition: stripCopula(m[2]!.trim().replace(/[.!]$/, "")), sentence, chunkIndex });
        continue;
      }
      m = DEB_ATALADI.exec(sentence);
      if (m) {
        const words = m[2]!.trim().split(/\s+/);
        // Uzbek compound terms are izofa chains ending in a possessive (-i/-si):
        // "muvozanat narxi", "isteʼmol narxlari indeksi". Grow the term leftwards
        // only while the leftmost word carries that suffix.
        const term: string[] = [words[words.length - 1]!];
        for (let k = words.length - 2; k >= 0 && term.length < 3; k--) {
          if (/\p{L}{3,}(i|si)$/u.test(term[0]!)) term.unshift(words[k]!);
          else break;
        }
        const rest = words.slice(0, words.length - term.length).join(" ");
        const def = [m[1]!.trim(), rest].filter(Boolean).join(" ");
        out.push({ term: term.join(" "), definition: def, sentence, chunkIndex });
        continue;
      }
      m = RU_NAZ.exec(sentence);
      if (m) out.push({ term: m[2]!.trim(), definition: m[1]!.trim(), sentence, chunkIndex });
      else {
        const p = DASH_PLAIN.exec(sentence);
        if (p && p[1]!.split(/\s+/).length <= 3 && !/\d/.test(p[1]!)) out.push({ term: p[1]!.trim(), definition: stripCopula(p[2]!.trim()), sentence, chunkIndex });
      }
    }
  });
  // one definition per term (first occurrence)
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = contentStems(d.term).join(" ");
    if (!k || seen.has(k)) return false;
    seen.add(k);
    // Definitions that start with a demonstrative ("Shu nuqtadagi…", "This value…") depend on
    // surrounding context and make unanswerable questions on their own.
    if (/^(shu|bu|ushbu|u|bunday|shunday|this|that|these|такой|этот|эта|это)\b/iu.test(d.definition.trim())) return false;
    return d.definition.length >= 8 && contentStems(d.definition).length >= 3;
  });
}

export function capitalize(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase("uz") + s.slice(1) : s;
}
