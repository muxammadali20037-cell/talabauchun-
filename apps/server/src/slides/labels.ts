import { latinToCyrillic } from "@talaba/shared";

/**
 * Fixed words that appear ON the slides (headings like "Reja", footnote
 * prefixes, the example-data badge). They follow the deck's language, which
 * may differ from the UI language, so they live here rather than in the UI
 * dictionaries. Uzbek Cyrillic is transliterated from the Latin strings.
 */
const uz = {
  goal: "Taqdimot maqsadi",
  agenda: "Reja",
  concepts: "Asosiy tushunchalar",
  concept: "Tushuncha",
  analysis: "Tahlil",
  example: "Amaliy misol",
  conclusion: "Xulosa",
  questions: "Savollar",
  questionsPrompt: "Eʼtiboringiz uchun rahmat! Savollaringiz boʻlsa, marhamat.",
  references: "Foydalanilgan manbalar",
  data: "Maʼlumotlar",
  table: "Jadval",
  source: "Manba",
  sources: "Manbalar",
  continued: "(davomi)",
  exampleBadge: "Namuna maʼlumot — haqiqiy statistika emas",
  indicator: "Koʻrsatkich",
  unit: "Birlik",
  period: "Davr",
  change: "Oʻzgarish",
  computed: "hisoblangan",
  from: "dan",
  notesSource: "Manbadagi matn",
  defenseQa: "Himoya uchun savol-javob",
  question: "Savol",
  answer: "Javob",
  whatIs: (term: string) => `“${term}” nima?`,
  fromTo: (a: string, b: string) => `${a} dan ${b} gacha`,
  author: "Muallif",
  university: "Oliy taʼlim muassasasi",
  subject: "Fan",
  teacher: "Oʻqituvchi",
  group: "Guruh",
  accessed: "murojaat qilingan sana",
  sheet: "varaq",
  columns: "ustunlar",
  part: "qism",
};

type Labels = Omit<typeof uz, "whatIs" | "fromTo"> & { whatIs: (term: string) => string; fromTo: (a: string, b: string) => string };

const ru: Labels = {
  goal: "Цель презентации",
  agenda: "План",
  concepts: "Основные понятия",
  concept: "Понятие",
  analysis: "Анализ",
  example: "Практический пример",
  conclusion: "Выводы",
  questions: "Вопросы",
  questionsPrompt: "Спасибо за внимание! Готов ответить на вопросы.",
  references: "Использованные источники",
  data: "Данные",
  table: "Таблица",
  source: "Источник",
  sources: "Источники",
  continued: "(продолжение)",
  exampleBadge: "Пример данных — не реальная статистика",
  indicator: "Показатель",
  unit: "Единица",
  period: "Период",
  change: "Изменение",
  computed: "расчёт",
  from: "",
  notesSource: "Текст источника",
  defenseQa: "Вопросы и ответы для защиты",
  question: "Вопрос",
  answer: "Ответ",
  whatIs: (term) => `Что такое «${term}»?`,
  fromTo: (a, b) => `с ${a} до ${b}`,
  author: "Автор",
  university: "Вуз",
  subject: "Предмет",
  teacher: "Преподаватель",
  group: "Группа",
  accessed: "дата обращения",
  sheet: "лист",
  columns: "столбцы",
  part: "часть",
};

const en: Labels = {
  goal: "Purpose of the talk",
  agenda: "Outline",
  concepts: "Key concepts",
  concept: "Concept",
  analysis: "Analysis",
  example: "Worked example",
  conclusion: "Conclusions",
  questions: "Questions",
  questionsPrompt: "Thank you! Questions are welcome.",
  references: "References",
  data: "Data",
  table: "Table",
  source: "Source",
  sources: "Sources",
  continued: "(continued)",
  exampleBadge: "Example data — not real statistics",
  indicator: "Indicator",
  unit: "Unit",
  period: "Period",
  change: "Change",
  computed: "calculated",
  from: "",
  notesSource: "Source text",
  defenseQa: "Defense Q&A",
  question: "Q",
  answer: "A",
  whatIs: (term) => `What is “${term}”?`,
  fromTo: (a, b) => `from ${a} to ${b}`,
  author: "Author",
  university: "University",
  subject: "Subject",
  teacher: "Supervisor",
  group: "Group",
  accessed: "accessed",
  sheet: "sheet",
  columns: "columns",
  part: "part",
};

function cyr(l: Labels): Labels {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(l)) out[k] = typeof v === "string" ? latinToCyrillic(v) : (...a: string[]) => latinToCyrillic((v as (...s: string[]) => string)(...a));
  return out as Labels;
}

const cache = new Map<string, Labels>();
export function labels(lang: string | undefined): Labels {
  const key = lang === "ru" || lang === "en" || lang === "uz-Cyrl" ? lang : "uz";
  let l = cache.get(key);
  if (!l) {
    l = key === "ru" ? ru : key === "en" ? en : key === "uz-Cyrl" ? cyr(uz) : uz;
    cache.set(key, l);
  }
  return l;
}

/** BCP-47 tag written into PPTX runs so PowerPoint spell-checks in the right language. */
export function pptxLang(lang: string | undefined): string {
  return lang === "ru" ? "ru-RU" : lang === "en" ? "en-US" : lang === "uz-Cyrl" ? "uz-Cyrl-UZ" : "uz-Latn-UZ";
}

/**
 * Uzbek Latin typography: oʻ/gʻ use U+02BB and the tutuq belgisi U+02BC
 * (sources often type ‘ ’ ' ` instead). Meaning is unchanged; quote
 * verification normalises apostrophes, so citations still match.
 */
export function uzTypography(text: string, lang: string | undefined): string {
  if (lang && lang !== "uz") return text;
  return text
    .replace(/([oOgG])[‘’'`ʼ]/g, "$1ʻ")
    .replace(/(\p{L})[’'`](?=\p{L})/gu, "$1ʼ");
}
