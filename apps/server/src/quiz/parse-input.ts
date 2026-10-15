export type ParsedQa = {
  question: string;
  answer: string | null;
  /** When the user already supplied options (A) … D)), with the correct ones marked. */
  options: { text: string; correct: boolean }[] | null;
  explanation: string | null;
  line: number;
};

// Short labels ("J:", "A:") need a colon so that an option line "a) …" is not read as an answer.
const ANSWER_RE = /^\s*(?:(?:javob|answer|ans|ответ|отв|жавоб|жавоби)\s*[:.)-]|(?:j|a|о)\s*:)\s*(.+)$/iu;
const EXPL_RE = /^\s*(izoh|explanation|пояснение|изоҳ)\s*[:.-]\s*(.+)$/iu;
const OPTION_RE = /^\s*([*+#]?)\s*([A-Fa-fА-Еа-е]|[1-6])\s*[).]\s*(.+?)\s*([*+])?\s*$/u;
const NUMBERED_Q_RE = /^\s*(\d{1,3})\s*[.)]\s*(.+)$/u;
const QUESTION_PREFIX_RE = /^\s*(savol|question|q|вопрос|савол)\s*[:.-]\s*/iu;
const LETTERS = "abcdefабвгде";

function letterIndex(ch: string): number {
  const i = LETTERS.indexOf(ch.toLowerCase());
  if (i < 0) return Number(ch) - 1;
  return i >= 6 ? i - 6 : i;
}

/**
 * Parses pasted question/answer lists. Supported shapes (any language):
 *   1. Savol matni?            Savol: …            1. Savol?
 *   Javob: …                   Javob: …            A) …  *B) …  C) …  D) …   (or "Javob: B")
 * Blank lines separate items. Unparseable fragments are returned in `skipped`.
 */
export function parseQaText(raw: string): { items: ParsedQa[]; skipped: string[] } {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const items: ParsedQa[] = [];
  const skipped: string[] = [];
  let cur: (ParsedQa & { answerLetter?: string }) | null = null;
  const flush = () => {
    if (!cur) return;
    if (cur.options && cur.answerLetter) {
      const idx = letterIndex(cur.answerLetter);
      cur.options = cur.options.map((o, i) => ({ ...o, correct: o.correct || i === idx }));
    }
    if (cur.options && !cur.options.some((o) => o.correct) && cur.answer) {
      const a = cur.answer.trim().toLowerCase();
      cur.options = cur.options.map((o) => ({ ...o, correct: o.text.trim().toLowerCase() === a }));
    }
    if (cur.options && cur.options.length < 2) cur.options = null;
    if (cur.question.length >= 3) items.push({ question: cur.question.trim(), answer: cur.answer, options: cur.options, explanation: cur.explanation, line: cur.line });
    cur = null;
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const ans = ANSWER_RE.exec(t);
    if (ans && cur) {
      const val = ans[1]!.trim();
      if (cur.options && /^[A-Fa-fА-Еа-е1-6]\)?$/u.test(val)) cur.answerLetter = val[0];
      else cur.answer = val;
      return;
    }
    const expl = EXPL_RE.exec(t);
    if (expl && cur) {
      cur.explanation = expl[2]!.trim();
      return;
    }
    const opt = OPTION_RE.exec(t);
    if (opt && cur && !NUMBERED_Q_RE.test(t.replace(/^[*+#]/, "")) ) {
      cur.options = cur.options ?? [];
      cur.options.push({ text: opt[3]!.trim(), correct: !!opt[1] || !!opt[4] });
      return;
    }
    if (opt && cur && /^[A-Fa-fА-Еа-е]/u.test(opt[2]!)) {
      cur.options = cur.options ?? [];
      cur.options.push({ text: opt[3]!.trim(), correct: !!opt[1] || !!opt[4] });
      return;
    }
    // new question
    const numbered = NUMBERED_Q_RE.exec(t);
    const text = (numbered ? numbered[2]! : t).replace(QUESTION_PREFIX_RE, "").trim();
    if (cur && !cur.answer && !cur.options && !numbered && !QUESTION_PREFIX_RE.test(t)) {
      // continuation of a multi-line question
      cur.question += " " + text;
      return;
    }
    flush();
    cur = { question: text, answer: null, options: null, explanation: null, line: i + 1 };
  });
  flush();
  for (const it of items) if (!it.answer && !it.options) skipped.push(it.question);
  return { items, skipped };
}

/** One question per line (numbering optional). */
export function parseQuestionList(raw: string): string[] {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim().replace(/^\d{1,3}\s*[.)]\s*/, "").replace(QUESTION_PREFIX_RE, ""))
    .filter((l) => l.length >= 5)
    .slice(0, 200);
}
