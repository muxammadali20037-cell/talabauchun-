/** Sentence-aware chunking within one page/section so every chunk has a precise locator. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…\n]+(?:[.!?…]+["»”)]*|\n+|$)/gu;
  for (const m of text.matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

type Unit = { text: string; newPara: boolean };

function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (const para of text.split(/\n+/)) {
    const sentences = splitSentences(para);
    sentences.forEach((s, i) => out.push({ text: s, newPara: i === 0 }));
  }
  return out;
}

function join(us: Unit[]): string {
  return us.map((u, i) => (i === 0 ? u.text : (u.newPara ? "\n" : " ") + u.text)).join("");
}

/** Paragraph breaks are kept (headings stay on their own line) so sentence-level evidence stays exact. */
export function chunkText(text: string, maxChars = 1200, overlapSentences = 1): string[] {
  const all = units(text);
  const chunks: string[] = [];
  let cur: Unit[] = [];
  let len = 0;
  for (const u of all) {
    if (u.text.length > maxChars) {
      if (cur.length) {
        chunks.push(join(cur));
        cur = [];
        len = 0;
      }
      for (let i = 0; i < u.text.length; i += maxChars) chunks.push(u.text.slice(i, i + maxChars));
      continue;
    }
    if (len + u.text.length + 1 > maxChars && cur.length) {
      chunks.push(join(cur));
      cur = overlapSentences > 0 ? cur.slice(-overlapSentences).map((x, i) => (i === 0 ? { ...x, newPara: true } : x)) : [];
      len = cur.reduce((a, b) => a + b.text.length + 1, 0);
    }
    cur.push(u);
    len += u.text.length + 1;
  }
  if (cur.length) chunks.push(join(cur));
  return chunks.filter((c) => c.trim().length > 0);
}
