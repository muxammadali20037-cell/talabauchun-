import type { RetrievedChunk } from "../search/retrieve";
import { DIRECTION_SETS, extractiveDistractors, isDirectionWord } from "./distractors";
import { detectLanguage } from "./lang";
import { capitalize, findDefinitions, type Definition } from "./terms";
import { contentStems, splitKeep } from "./text";
import type { Candidate, CandidateEvidence } from "./validate";

type Lang = "uz" | "uz-Cyrl" | "ru" | "en";

const T = {
  defToTerm: {
    uz: (d: string) => `Quyidagi taʼrif qaysi tushunchaga tegishli: «${d}»?`,
    "uz-Cyrl": (d: string) => `Қуйидаги таъриф қайси тушунчага тегишли: «${d}»?`,
    ru: (d: string) => `Какому понятию соответствует определение: «${d}»?`,
    en: (d: string) => `Which term matches this definition: “${d}”?`,
  },
  cloze: {
    uz: (s: string) => `Gapni toʻldiring: «${s}»`,
    "uz-Cyrl": (s: string) => `Гапни тўлдиринг: «${s}»`,
    ru: (s: string) => `Заполните пропуск: «${s}»`,
    en: (s: string) => `Fill in the blank: “${s}”`,
  },
  explainDef: {
    uz: (t: string, d: string) => `${t} — ${d}.`,
    "uz-Cyrl": (t: string, d: string) => `${t} — ${d}.`,
    ru: (t: string, d: string) => `${t} — ${d}.`,
    en: (t: string, d: string) => `${t}: ${d}.`,
  },
  explainCloze: {
    uz: (s: string) => `Manbadagi jumla: «${s}»`,
    "uz-Cyrl": (s: string) => `Манбадаги жумла: «${s}»`,
    ru: (s: string) => `Фраза из источника: «${s}»`,
    en: (s: string) => `Sentence in the source: “${s}”`,
  },
  tfStatement: {
    uz: (t: string, d: string) => `Toʻgʻrimi yoki notoʻgʻri: «${t} — ${d}»`,
    "uz-Cyrl": (t: string, d: string) => `Тўғрими ёки нотўғри: «${t} — ${d}»`,
    ru: (t: string, d: string) => `Верно или неверно: «${t} — ${d}»`,
    en: (t: string, d: string) => `True or false: “${t}: ${d}”`,
  },
  trueLabel: { uz: "Toʻgʻri", "uz-Cyrl": "Тўғри", ru: "Верно", en: "True" },
  falseLabel: { uz: "Notoʻgʻri", "uz-Cyrl": "Нотўғри", ru: "Неверно", en: "False" },
  tfFalseWhy: {
    uz: (t: string, d: string, other: string) => `Bu ${other} taʼrifi. ${t} — ${d}.`,
    "uz-Cyrl": (t: string, d: string, other: string) => `Бу ${other} таърифи. ${t} — ${d}.`,
    ru: (t: string, d: string, other: string) => `Это определение понятия «${other}». ${t} — ${d}.`,
    en: (t: string, d: string, other: string) => `That is the definition of ${other}. ${t}: ${d}.`,
  },
  otherTerm: {
    uz: (t: string, d: string) => `${t} — boshqa tushuncha: ${d}.`,
    "uz-Cyrl": (t: string, d: string) => `${t} — бошқа тушунча: ${d}.`,
    ru: (t: string, d: string) => `${t} — другое понятие: ${d}.`,
    en: (t: string, d: string) => `${t} is a different concept: ${d}.`,
  },
};

const BLANK = "_____";
const NUMWORD = /\b((?:bir|ikki|uch|to[ʻ'‘]?rt|besh|olti|yetti|sakkiz|to[ʻ'‘]?qqiz|o[ʻ'‘]?n)ta)\b/iu;
const CONDITIONAL = /(oshsa|ortsa|pasaysa|kamaysa|oshirilsa|kamaytirilsa|если|when|if)/iu;
const DIRECTION_VERB = /\b(ortadi|oshadi|kamayadi|pasayadi|увеличивается|уменьшается|снижается|растёт|increases|decreases)\b/iu;

function evidenceFor(chunk: RetrievedChunk, sentence: string): CandidateEvidence {
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    documentVersionId: chunk.documentVersionId,
    documentTitle: chunk.documentTitle,
    locator: chunk.locator,
    quote: sentence,
    method: "exact_quote",
  };
}

/**
 * Generates source-grounded questions without an LLM: definition → term,
 * number cloze, cause/effect direction cloze and term cloze. Every question
 * carries the exact sentence it came from as evidence. Output language follows
 * the source text (templates exist for uz, uz-Cyrl, ru, en).
 */
export function extractiveQuestions(chunks: RetrievedChunk[], opts: { max: number; language?: Lang; trueFalse?: boolean }): Candidate[] {
  const texts = chunks.map((c) => c.text);
  const srcLang = detectLanguage(texts.join("\n"));
  const lang: Lang = srcLang;
  const defs = findDefinitions(texts);
  const termPool = defs.map((d) => d.term);
  const out: Candidate[] = [];
  const usedSentences = new Set<string>();
  const base = { language: lang, sourceLanguage: srcLang, generator: "extractive" as const, evidenceStatus: "verified" as const, topic: null };

  // 1) definition → which term
  for (const d of defs) {
    const distract = extractiveDistractors(d.term, termPool, 3, lang);
    const chunk = chunks[d.chunkIndex]!;
    const termCap = capitalize(d.term);
    const whyWrong = (t: string) => {
      const other = defs.find((x) => contentStems(x.term).join(" ") === contentStems(t).join(" "));
      return other ? T.otherTerm[lang](capitalize(other.term), other.definition) : null;
    };
    out.push({
      ...base,
      text: T.defToTerm[lang](d.definition),
      type: "single",
      options: [{ text: termCap, correct: true }, ...distract.map((t) => ({ text: capitalize(t), correct: false, whyWrong: whyWrong(t) }))],
      explanation: T.explainDef[lang](termCap, d.definition),
      difficulty: "easy",
      cognitiveLevel: "recall",
      evidence: evidenceFor(chunk, d.sentence),
      topic: chunk.locator.heading ?? null,
    });
    usedSentences.add(d.sentence);
  }

  // 1b) true / false from the same definitions: a false statement pairs a term with
  // another term's definition from the same source; both quotes are kept as evidence.
  if (opts.trueFalse && defs.length >= 2) {
    defs.forEach((d, i) => {
      const chunk = chunks[d.chunkIndex]!;
      const termCap = capitalize(d.term);
      const makeFalse = i % 2 === 1;
      const other = defs.find((x, j) => j !== i && contentStems(x.term).join(" ") !== contentStems(d.term).join(" "));
      if (makeFalse && !other) return;
      const shown = makeFalse ? other!.definition : d.definition;
      out.push({
        ...base,
        text: T.tfStatement[lang](termCap, shown),
        type: "true_false",
        // fixed order (True, False) — it is a convention, not a hint
        options: [{ text: T.trueLabel[lang], correct: !makeFalse }, { text: T.falseLabel[lang], correct: makeFalse }],
        explanation: makeFalse ? T.tfFalseWhy[lang](termCap, d.definition, capitalize(other!.term)) : T.explainDef[lang](termCap, d.definition),
        difficulty: "medium",
        cognitiveLevel: "understand",
        evidence: evidenceFor(chunk, d.sentence),
        topic: chunk.locator.heading ?? null,
        notes: { userOptions: true },
      });
    });
  }

  // 2) number / 3) direction / 4) term cloze
  chunks.forEach((chunk) => {
    for (const sentence of splitKeep(chunk.text)) {
      if (usedSentences.has(sentence) || sentence.length < 25 || sentence.length > 260) continue;
      const num = NUMWORD.exec(sentence);
      if (num) {
        const answer = num[1]!;
        const opts = extractiveDistractors(answer, [], 3, lang);
        if (opts.length >= 3) {
          out.push({
            ...base,
            text: T.cloze[lang](sentence.replace(answer, BLANK)),
            type: "single",
            options: [{ text: answer, correct: true }, ...opts.map((o) => ({ text: o, correct: false }))],
            explanation: T.explainCloze[lang](sentence),
            difficulty: "easy",
            cognitiveLevel: "recall",
            evidence: evidenceFor(chunk, sentence),
            topic: chunk.locator.heading ?? null,
          });
          usedSentences.add(sentence);
          continue;
        }
      }
      if (CONDITIONAL.test(sentence)) {
        const verbs = [...sentence.matchAll(new RegExp(DIRECTION_VERB.source, "giu"))];
        const last = verbs[verbs.length - 1];
        if (last && isDirectionWord(last[1]!)) {
          const answer = last[1]!;
          const set = DIRECTION_SETS[lang.startsWith("uz") ? "uz" : lang] ?? DIRECTION_SETS.uz!;
          // keep the source's own verb as the correct option; replace its synonym in the option set
          const synonymOf: Record<string, string> = { oshadi: "ortadi", pasayadi: "kamayadi", "снижается": "уменьшается", "растёт": "увеличивается", rises: "increases", falls: "decreases" };
          const canonical = synonymOf[answer.toLowerCase()] ?? answer.toLowerCase();
          const before = sentence.slice(0, last.index) + BLANK + sentence.slice(last.index! + answer.length);
          out.push({
            ...base,
            text: T.cloze[lang](before),
            type: "single",
            options: [{ text: answer, correct: true }, ...set.filter((w) => w !== canonical).slice(0, 3).map((w) => ({ text: w, correct: false }))],
            explanation: T.explainCloze[lang](sentence),
            difficulty: "medium",
            cognitiveLevel: "understand",
            evidence: evidenceFor(chunk, sentence),
            topic: chunk.locator.heading ?? null,
          });
          usedSentences.add(sentence);
          continue;
        }
      }
      // term cloze: a defined term used in another sentence
      // skip comparative sentences ("X ham …" = "X too …"): other options may be equally true
      const term = defs.find(
        (d: Definition) =>
          d.sentence !== sentence &&
          new RegExp(`(^|[^\\p{L}])${escapeRe(d.term)}(?=[^\\p{L}]|$)`, "iu").test(sentence) &&
          !new RegExp(`${escapeRe(d.term)}\\s+(ham|too|also|тоже|также)\\b`, "iu").test(sentence),
      );
      // anaphoric openers ("Bu omillar…", "Shuning uchun…") need the previous sentence; a term that
      // also appears elsewhere in the sentence would give the answer away
      const anaphoric = /^(bu|shu|ushbu|shuning|bunday|shunday|u|ular|this|that|these|it|они|это|этот|поэтому)\b/iu.test(sentence.trim());
      const cue = term ? (sentence.toLowerCase().split(term.term.toLowerCase()).length - 1) > 1 || contentStems(sentence).filter((x) => contentStems(term.term).includes(x)).length > contentStems(term.term).length : false;
      if (term && !anaphoric && !cue) {
        const distract = extractiveDistractors(term.term, termPool, 3, lang);
        if (distract.length >= 3) {
          const re = new RegExp(escapeRe(term.term), "iu");
          const matched = re.exec(sentence)![0];
          out.push({
            ...base,
            text: T.cloze[lang](sentence.replace(re, BLANK)),
            type: "single",
            options: [{ text: matchCase(matched, term.term), correct: true }, ...distract.map((t) => ({ text: matchCase(matched, t), correct: false }))],
            explanation: T.explainCloze[lang](sentence),
            difficulty: "medium",
            cognitiveLevel: "understand",
            evidence: evidenceFor(chunk, sentence),
            topic: chunk.locator.heading ?? null,
          });
          usedSentences.add(sentence);
        }
      }
    }
  });
  return out.slice(0, Math.max(opts.max * 2, opts.max));
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCase(sample: string, word: string) {
  return /^\p{Lu}/u.test(sample) ? capitalize(word) : word.toLocaleLowerCase("uz");
}

/** Picks up to `count` candidates following the requested difficulty mix, keeping source order. */
export function pickByDifficulty<T extends { difficulty: "easy" | "medium" | "hard" }>(items: T[], count: number, mix: { easy: number; medium: number; hard: number }): T[] {
  if (items.length <= count) return items;
  const total = mix.easy + mix.medium + mix.hard || 1;
  const want = { easy: Math.round((count * mix.easy) / total), medium: Math.round((count * mix.medium) / total), hard: 0 };
  want.hard = Math.max(0, count - want.easy - want.medium);
  const chosen = new Set<T>();
  for (const level of ["easy", "medium", "hard"] as const) {
    for (const it of items) if (it.difficulty === level && [...chosen].filter((c) => c.difficulty === level).length < want[level]) chosen.add(it);
  }
  for (const it of items) if (chosen.size < count) chosen.add(it);
  return items.filter((i) => chosen.has(i));
}
