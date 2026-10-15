/** Rough script/language guess for a text sample: uz (Latin), uz-Cyrl, ru or en. */
export function detectLanguage(sample: string): "uz" | "uz-Cyrl" | "ru" | "en" {
  const s = sample.slice(0, 4000);
  const cyr = (s.match(/[Ѐ-ӿ]/g) ?? []).length;
  const lat = (s.match(/[A-Za-z]/g) ?? []).length;
  if (cyr > lat) return /[ўқғҳЎҚҒҲ]/.test(s) ? "uz-Cyrl" : "ru";
  const uzMarkers = (s.match(/\b(va|bu|uchun|bilan|qanday|haqida|boʻlgan|bo'lgan|hamda|ham|deb|esa)\b|[oOgG][ʻ'‘`]/g) ?? []).length;
  return uzMarkers >= 2 ? "uz" : "en";
}
