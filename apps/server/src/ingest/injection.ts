/**
 * Flags instruction-like text inside uploaded material ("ignore previous
 * instructions", "show the system prompt"…). Such text is always treated as
 * data — this detector only records it for audit and lets prompts wrap the
 * material in explicit data delimiters.
 */
const PATTERNS: RegExp[] = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /(reveal|show|print|output) (the |your )?(system prompt|secrets?|api key|instructions)/i,
  /you are now (a|an|in) /i,
  /oldingi (barcha )?(ko[ʻ'‘`]?rsatma|qoida|buyruq)lar(ni)? (unut|e[ʼ'`]?tiborsiz)/i,
  /(maxfiy|sir)(lar)?(ni)? (ko[ʻ'‘`]?rsat|chiqar|ayt)/i,
  /(игнорируй|забудь) (все )?(предыдущие|прошлые) (инструкции|правила)/i,
  /(покажи|выведи) (системный промпт|секреты|ключ)/i,
];

export function detectInjection(text: string): string[] {
  const hits: string[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push(m[0].slice(0, 120));
  }
  return hits;
}
