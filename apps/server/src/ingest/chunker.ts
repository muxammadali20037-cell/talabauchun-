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

export function chunkText(text: string, maxChars = 1200, overlapSentences = 1): string[] {
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const s of sentences) {
    // very long "sentence" (tables, lists without punctuation): hard split
    if (s.length > maxChars) {
      if (cur.length) {
        chunks.push(cur.join(" "));
        cur = [];
        len = 0;
      }
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
      continue;
    }
    if (len + s.length + 1 > maxChars && cur.length) {
      chunks.push(cur.join(" "));
      cur = overlapSentences > 0 ? cur.slice(-overlapSentences) : [];
      len = cur.reduce((a, b) => a + b.length + 1, 0);
    }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks.filter((c) => c.trim().length > 0);
}
