import type { DeckOutlineItem, DeckSettings, Locator, SlideContent } from "@talaba/shared";
import { findDefinitions, capitalize } from "../quiz/terms";
import { contentStems, coverage, norm } from "../quiz/text";
import { labels, uzTypography } from "./labels";
import { renderedPages } from "./layout";
import { chapters, sourceLabel, type Material, type MBlock, type MSentence, type MTable } from "./material";
import { THEMES } from "./themes";

/**
 * Extractive deck generator (no language model). Every content bullet is a
 * whole sentence (or a verbatim list item) from the student's material, with
 * the page it came from; numbers on charts are the source table's values.
 * Nothing is invented: when the material is short the deck is shorter.
 */

export type OriginKind = "title" | "goal" | "agenda" | "definition" | "chapter" | "chart" | "table" | "example" | "conclusion" | "questions" | "references" | "manual" | "ai";

export type SlideOrigin = {
  kind: OriginKind;
  mode: "extractive" | "ai" | "user";
  /** chapter title key, definition term, table key… */
  anchor?: string;
  layout?: SlideContent["layout"];
  variant?: number;
  /** plan idea (AI) */
  idea?: string;
};

export type DraftRef = {
  docId: string | null;
  versionId: string | null;
  docTitle: string;
  locator: Locator;
  quote: string;
  verification: "exact_quote" | "fuzzy_quote" | "table_value";
};

export type DraftSlide = { content: SlideContent; notes: string; origin: SlideOrigin; refs: DraftRef[] };

type Lang = "uz" | "uz-Cyrl" | "ru" | "en";
const langOf = (s: string | undefined): Lang => (s === "ru" || s === "en" || s === "uz-Cyrl" ? s : "uz");
export const anchorKey = (s: string) => norm(s).replace(/[^\p{L}\p{N}]/gu, "");

// ───────────────────────── sentence scoring ─────────────────────────

const DEMONSTRATIVE = /^(bu|shu|ushbu|u|ular|bular|shular|unda|undan|uni|uning|bunda|shunda|bunday|shunday|shuning uchun|buning|this|that|these|it|they|such|это|этот|эта|эти|они|такой|поэтому)\b/iu;
const EXAMPLE = /^(masalan|misol uchun|например|for example|for instance)\b/iu;

export function wordCount(s: string) {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Whole, readable sentence: not a table row, not a fragment, not mostly numbers. */
export function goodSentence(s: string): boolean {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 5 || words.length > 45) return false;
  if (!/[.!?…]["»”)]?$/.test(s)) return false;
  if (!/^[\p{Lu}«"“]/u.test(s)) return false;
  if (s.includes(" | ")) return false;
  const numeric = words.filter((w) => /^\(?[\d.,%=()-]+\)?$/.test(w)).length;
  return numeric / words.length <= 0.2;
}

type Scored = { s: MSentence; score: number };

function scoreSentences(m: Material): Map<number, number> {
  const blockStems = new Map<number, Set<string>>();
  const tf = new Map<string, number>();
  const stemsOf = new Map<number, string[]>();
  for (const s of m.sentences) {
    const st = contentStems(s.text).filter((x) => x.length >= 3);
    stemsOf.set(s.id, st);
    for (const x of st) tf.set(x, (tf.get(x) ?? 0) + 1);
    if (!blockStems.has(s.blockId)) blockStems.set(s.blockId, new Set());
    for (const x of st) blockStems.get(s.blockId)!.add(x);
  }
  const B = Math.max(1, blockStems.size);
  const df = new Map<string, number>();
  for (const set of blockStems.values()) for (const x of set) df.set(x, (df.get(x) ?? 0) + 1);
  const titleStems = new Map<number, Set<string>>();
  for (const b of m.blocks) titleStems.set(b.id, new Set(contentStems(b.title ?? "")));
  const out = new Map<number, number>();
  for (const s of m.sentences) {
    const uniq = [...new Set(stemsOf.get(s.id) ?? [])];
    if (!uniq.length) {
      out.set(s.id, 0);
      continue;
    }
    let score = uniq.reduce((acc, x) => acc + Math.log(1 + (tf.get(x) ?? 1)) * Math.log(1 + B / (df.get(x) ?? 1)), 0) / Math.sqrt(uniq.length);
    const block = m.blocks[s.blockId];
    const chapterTitle = block?.chapterId != null ? m.blocks[block.chapterId]?.title ?? "" : "";
    const ts = new Set([...(titleStems.get(s.blockId) ?? []), ...contentStems(chapterTitle)]);
    score += uniq.filter((x) => ts.has(x)).length * 0.6;
    // lead sentences of a section usually carry its main statement
    const pos = block ? block.sentences.indexOf(s) : -1;
    if (pos >= 0 && block!.sentences.length > 1) score += 0.8 * (1 - pos / block!.sentences.length);
    const wc = wordCount(s.text);
    if (wc < 8) score *= 0.7;
    if (wc > 30) score *= 0.6;
    if (DEMONSTRATIVE.test(s.text)) score *= 0.5;
    if (!goodSentence(s.text)) score *= 0.1;
    out.set(s.id, score);
  }
  return out;
}

// ───────────────────────── helpers ─────────────────────────

/** "1-bob. Talab va taklif" → { kicker: "1-bob", title: "Talab va taklif" }; "2.3. Inflyatsiyani o‘lchash" → title only. */
export function splitHeading(title: string): { kicker?: string; title: string } {
  const bob = /^(\d+\s*-\s*bob|глава\s+\d+|chapter\s+\d+|bob\s+\d+)\.?\s*[:.—–-]?\s*(.+)$/iu.exec(title);
  if (bob) return { kicker: bob[1]!.replace(/\s+/g, ""), title: bob[2]!.trim() };
  const num = /^(\d+(?:\.\d+)*)\.?\s+(.+)$/u.exec(title);
  if (num) return { title: num[2]!.trim() };
  return { title: title.trim() };
}

type Bullet = { text: string; level: 0 | 1; ref?: number };

/** A sentence "Lead: a, b, c hamda d." becomes a lead bullet with verbatim sub-items; otherwise the sentence itself. */
export function sentenceToBullets(text: string): Bullet[] {
  const m = /^(.{8,140}?):\s+(.+?)[.!]?$/u.exec(text);
  if (m) {
    const items = m[2]!.split(/,\s+|\s+hamda\s+|;\s+/u).map((x) => x.trim()).filter(Boolean);
    if (items.length >= 3 && items.every((x) => wordCount(x) <= 10)) return [{ text: `${m[1]!.trim()}:`, level: 0 }, ...items.map((x) => ({ text: x, level: 1 as const }))];
  }
  return [{ text, level: 0 }];
}

/** True when the slide renders on one page in every theme (theme switching must not split generated slides). */
export function fitsEverywhere(content: SlideContent, lang: string | undefined): boolean {
  return Object.values(THEMES).every((t) => renderedPages(content, t, lang) === 1);
}

export type Ctx = { m: Material; lang: Lang; L: ReturnType<typeof labels>; typo: (s: string) => string; scores: Map<number, number>; settings: DeckSettings };

export function makeCtx(m: Material, settings: DeckSettings): Ctx {
  const lang = langOf(settings.language);
  return { m, lang, L: labels(lang), typo: (s) => uzTypography(s, lang), scores: scoreSentences(m), settings };
}

/** Groups sentences into slide sources (one per document page) and returns refs + bullet ref indexes. */
function sourcesFor(ctx: Ctx, sents: MSentence[]): { sources: SlideContent["sources"]; refs: DraftRef[]; refOf: Map<number, number> } {
  const groups = new Map<string, MSentence[]>();
  for (const s of sents) {
    const k = `${s.docId}|${JSON.stringify(s.locator)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s);
  }
  const refs: DraftRef[] = [];
  const refOf = new Map<number, number>();
  const sources: SlideContent["sources"] = [];
  for (const list of [...groups.values()].slice(0, 6)) {
    const first = list[0]!;
    refs.push({ docId: first.docId, versionId: first.versionId, docTitle: first.docTitle, locator: first.locator, quote: list.map((x) => x.text).join(" ").slice(0, 1200), verification: "exact_quote" });
    sources.push({ label: sourceLabel(first.docTitle, first.locator, ctx.lang).slice(0, 300), verified: true });
    for (const s of list) refOf.set(s.id, refs.length);
  }
  return { sources, refs, refOf };
}

function notesFor(ctx: Ctx, sents: MSentence[], lead?: string): string {
  const byPage = new Map<string, MSentence[]>();
  for (const s of sents) {
    const label = sourceLabel(s.docTitle, s.locator, ctx.lang);
    if (!byPage.has(label)) byPage.set(label, []);
    byPage.get(label)!.push(s);
  }
  const parts = lead ? [lead] : [];
  for (const [label, list] of byPage) parts.push(`${ctx.L.notesSource} (${label}):\n${list.map((s) => s.text).join(" ")}`);
  return parts.join("\n\n").slice(0, 8000);
}

const rank = (ctx: Ctx, list: MSentence[]) => [...list].sort((a, b) => (ctx.scores.get(b.id) ?? 0) - (ctx.scores.get(a.id) ?? 0));

/**
 * Picks sentences in rank order while the slide still fits on one page, then
 * restores reading order. `avoid` (previous texts) are skipped first, which is
 * how "regenerate" yields a different selection when the material allows it.
 */
function pickBullets(ctx: Ctx, pool: MSentence[], make: (b: Bullet[], chosen: MSentence[]) => SlideContent, o: { max: number; maxWords: number; avoid?: Set<string>; variant?: number; ordered?: boolean }): MSentence[] {
  const usable = pool.filter((s) => goodSentence(s.text) && !EXAMPLE.test(s.text));
  const candidates = o.ordered ? usable : rank(ctx, usable);
  const avoid = o.avoid ?? new Set<string>();
  const fresh = candidates.filter((s) => !avoid.has(norm(s.text)));
  const rotated = (o.variant ?? 0) > 0 && fresh.length ? [...fresh, ...candidates.filter((s) => avoid.has(norm(s.text)))] : candidates;
  const chosen: MSentence[] = [];
  let words = 0;
  for (const s of rotated) {
    if (chosen.length >= o.max) break;
    const wc = wordCount(s.text);
    if (chosen.length && words + wc > o.maxWords) continue;
    const next = [...chosen, s].sort((a, b) => a.id - b.id);
    const bullets = next.flatMap((x) => sentenceToBullets(ctx.typo(x.text)));
    if (!fitsEverywhere(make(bullets, next), ctx.lang)) continue;
    chosen.push(s);
    words += wc;
  }
  return chosen.sort((a, b) => a.id - b.id);
}

function bulletsWithRefs(ctx: Ctx, chosen: MSentence[], refOf: Map<number, number>): Bullet[] {
  return chosen.flatMap((s) => sentenceToBullets(ctx.typo(s.text)).map((b) => ({ ...b, ref: refOf.get(s.id) })));
}

// ───────────────────────── slide builders ─────────────────────────

export function buildTitleSlide(ctx: Ctx, deckTitle: string): DraftSlide {
  const st = ctx.settings;
  const L = ctx.L;
  const meta = [
    st.author ? `${L.author}: ${st.author}` : null,
    st.university ? `${L.university}: ${st.university}` : null,
    st.teacher ? `${L.teacher}: ${st.teacher}` : null,
    st.group ? `${L.group}: ${st.group}` : null,
  ].filter((x): x is string => !!x).map((x) => ctx.typo(x).slice(0, 200));
  return {
    content: { layout: "title", title: ctx.typo(deckTitle).slice(0, 200), subtitle: st.audience && st.audience !== "talabalar" ? ctx.typo(st.audience).slice(0, 300) : undefined, meta, sources: [], aiWritten: false, ...(st.subject ? { kicker: ctx.typo(st.subject).slice(0, 80) } : {}) },
    notes: "",
    origin: { kind: "title", mode: "extractive" },
    refs: [],
  };
}

function introBlock(m: Material): MBlock | null {
  const firstChapter = m.blocks.find((b) => b.level === 1 && b.listed);
  return (
    m.blocks.find((b) => b.title && /^(kirish|muqaddima|введение|introduction|annotatsiya|аннотация|abstract)\b/iu.test(b.title) && b.sentences.length) ??
    m.blocks.find((b) => (firstChapter ? b.id < firstChapter.id : false) && b.sentences.some((s) => goodSentence(s.text))) ??
    null
  );
}

export function buildGoalSlide(ctx: Ctx, variant = 0, avoid?: Set<string>): DraftSlide | null {
  const intro = introBlock(ctx.m);
  if (!intro) return null;
  const title = ctx.typo(intro.title ? splitHeading(intro.title).title : ctx.L.goal).slice(0, 200);
  const make = (bullets: Bullet[]): SlideContent => ({ layout: "bullets", title, bullets, sources: [{ label: "x" }], aiWritten: false });
  const chosen = pickBullets(ctx, intro.sentences.filter((s) => !/^(ushbu|this|данн)/iu.test(s.text)), make, { max: 3, maxWords: 60, avoid, variant });
  if (!chosen.length) return null;
  const { sources, refs, refOf } = sourcesFor(ctx, chosen);
  return { content: { layout: "bullets", title, bullets: bulletsWithRefs(ctx, chosen, refOf), sources, aiWritten: false }, notes: notesFor(ctx, chosen), origin: { kind: "goal", mode: "extractive", variant }, refs };
}

export type FoundDefinition = { term: string; sentence: MSentence; extra: MSentence | null; chapterId: number | null };

export function findDeckDefinitions(m: Material): FoundDefinition[] {
  const intro = introBlock(m);
  const out: FoundDefinition[] = [];
  for (const b of m.blocks) {
    if (intro && b.id === intro.id) continue;
    const defs = findDefinitions(b.paragraphs.map((p) => p.text));
    for (const d of defs) {
      const sentence = b.sentences.find((s) => norm(s.text) === norm(d.sentence) || norm(s.text).includes(norm(d.sentence).slice(0, 40)));
      if (!sentence) continue;
      if (out.some((o) => anchorKey(o.term) === anchorKey(d.term))) continue;
      // the next sentence of the same paragraph often completes a definition ("Talab faqat xohish emas, balki…")
      const next = b.sentences.find((s) => s.id === sentence.id + 1 && s.para === sentence.para) ?? null;
      const extra = next && goodSentence(next.text) && contentStems(next.text.split(/\s+/).slice(0, 2).join(" ")).some((x) => contentStems(d.term).includes(x)) ? next : null;
      out.push({ term: d.term, sentence, extra, chapterId: b.chapterId });
    }
  }
  return out;
}

function conceptTitle(term: string, lang: Lang): string {
  const t = capitalize(term);
  if (lang === "ru") return `Понятие «${t}»`;
  if (lang === "en") return `${t}: definition`;
  return lang === "uz-Cyrl" ? `${t} тушунчаси` : `${t} tushunchasi`;
}

export function buildDefinitionSlide(ctx: Ctx, d: FoundDefinition): DraftSlide {
  const sents = d.extra ? [d.sentence, d.extra] : [d.sentence];
  const { sources, refs } = sourcesFor(ctx, sents);
  let definition = ctx.typo(sents.map((s) => s.text).join(" "));
  if (definition.length > 800) definition = ctx.typo(d.sentence.text).slice(0, 800);
  const chapterTitle = d.chapterId != null ? ctx.m.blocks[d.chapterId]?.title : null;
  return {
    content: {
      layout: "definition",
      title: ctx.typo(conceptTitle(d.term, ctx.lang)).slice(0, 200),
      kicker: ctx.typo(chapterTitle ? (splitHeading(chapterTitle).kicker ?? splitHeading(chapterTitle).title) : ctx.L.concepts).slice(0, 80),
      term: ctx.typo(capitalize(d.term)).slice(0, 160),
      definition,
      sources,
      aiWritten: false,
    },
    notes: notesFor(ctx, sents),
    origin: { kind: "definition", mode: "extractive", anchor: anchorKey(d.term) },
    refs,
  };
}

type Chapter = ReturnType<typeof chapters>[number];

export function buildChapterSlide(ctx: Ctx, ch: Chapter, layout: "bullets" | "two_column", o: { exclude?: Set<number>; variant?: number; avoid?: Set<string> } = {}): DraftSlide | null {
  const head = splitHeading(ch.block.title ?? "");
  const title = ctx.typo(head.title).slice(0, 200);
  const kicker = head.kicker ? ctx.typo(head.kicker) : undefined;
  const exclude = o.exclude ?? new Set<number>();
  const pool = (list: MSentence[]) => list.filter((s) => !exclude.has(s.id));
  if (layout === "two_column") {
    const subs = ch.subs
      .map((b) => ({ b, good: pool(b.sentences).filter((s) => goodSentence(s.text) && !EXAMPLE.test(s.text)) }))
      .filter((x) => x.good.length >= 1)
      .slice(0, 2);
    if (subs.length === 2) {
      const heads = subs.map((x) => ctx.typo(splitHeading(x.b.title ?? "").title).slice(0, 120));
      const picked: MSentence[][] = [[], []];
      // fill the columns alternately so both stay balanced and the slide fits in every theme
      for (let round = 0; round < 3; round++) {
        for (const i of [0, 1]) {
          const rest = rank(ctx, subs[i]!.good).filter((s) => !picked[i]!.includes(s) && !(o.avoid?.has(norm(s.text)) && (o.variant ?? 0) > 0 && subs[i]!.good.length > picked[i]!.length + 1));
          const cand = rest[0];
          if (!cand) continue;
          const trial = picked.map((p, j) => (j === i ? [...p, cand] : p).sort((a, b) => a.id - b.id));
          const content: SlideContent = { layout: "two_column", title, kicker, sources: [{ label: "x" }, { label: "y" }], aiWritten: false,
            left: { heading: heads[0]!, bullets: trial[0]!.flatMap((s) => sentenceToBullets(ctx.typo(s.text))) },
            right: { heading: heads[1]!, bullets: trial[1]!.flatMap((s) => sentenceToBullets(ctx.typo(s.text))) } };
          if (trial[i]!.length <= 2 && fitsEverywhere(content, ctx.lang)) picked[i] = trial[i]!;
        }
      }
      if (picked[0]!.length && picked[1]!.length) {
        const all = [...picked[0]!, ...picked[1]!].sort((a, b) => a.id - b.id);
        const { sources, refs, refOf } = sourcesFor(ctx, all);
        return {
          content: { layout: "two_column", title, kicker, sources, aiWritten: false,
            left: { heading: heads[0]!, bullets: bulletsWithRefs(ctx, picked[0]!, refOf) },
            right: { heading: heads[1]!, bullets: bulletsWithRefs(ctx, picked[1]!, refOf) } },
          notes: notesFor(ctx, all),
          origin: { kind: "chapter", mode: "extractive", anchor: anchorKey(ch.block.title ?? ""), layout: "two_column", variant: o.variant ?? 0 },
          refs,
        };
      }
    }
  }
  const make = (bullets: Bullet[], chosen: MSentence[]): SlideContent => ({ layout: "bullets", title, kicker, bullets, sources: [...new Set(chosen.map((s) => `${s.docId}${JSON.stringify(s.locator)}`))].map((label) => ({ label })), aiWritten: false });
  const chosen = pickBullets(ctx, pool(ch.sentences), make, { max: 4, maxWords: 65, avoid: o.avoid, variant: o.variant });
  if (!chosen.length) return null;
  const { sources, refs, refOf } = sourcesFor(ctx, chosen);
  return {
    content: { layout: "bullets", title, kicker, bullets: bulletsWithRefs(ctx, chosen, refOf), sources, aiWritten: false },
    notes: notesFor(ctx, chosen),
    origin: { kind: "chapter", mode: "extractive", anchor: anchorKey(ch.block.title ?? ""), layout: "bullets", variant: o.variant ?? 0 },
    refs,
  };
}

export function buildExampleSlide(ctx: Ctx, o: { variant?: number; avoid?: Set<string> } = {}): DraftSlide | null {
  const examples = rank(ctx, ctx.m.sentences.filter((s) => EXAMPLE.test(s.text) && wordCount(s.text) >= 6 && wordCount(s.text) <= 40));
  if (!examples.length) return null;
  const ordered = (o.variant ?? 0) > 0 && o.avoid ? [...examples.filter((s) => !o.avoid!.has(norm(s.text))), ...examples.filter((s) => o.avoid!.has(norm(s.text)))] : examples;
  const title = ctx.L.example;
  const chosen: MSentence[] = [];
  const bulletsOf = (list: MSentence[]): { b: Bullet[]; sents: MSentence[] } => {
    const sents: MSentence[] = [];
    const b: Bullet[] = [];
    for (const ex of [...list].sort((a, c) => a.id - c.id)) {
      // the sentence before an example states the rule the example illustrates
      const prev = ctx.m.sentences[ex.id - 1];
      if (prev && prev.blockId === ex.blockId && goodSentence(prev.text) && !EXAMPLE.test(prev.text)) {
        sents.push(prev);
        b.push({ text: ctx.typo(prev.text), level: 0 });
        sents.push(ex);
        b.push({ text: ctx.typo(ex.text), level: 1 });
      } else {
        sents.push(ex);
        b.push({ text: ctx.typo(ex.text), level: 0 });
      }
    }
    return { b, sents };
  };
  for (const ex of ordered.slice(0, 3)) {
    const trial = bulletsOf([...chosen, ex]);
    if (fitsEverywhere({ layout: "bullets", title, bullets: trial.b, sources: trial.sents.map(() => ({ label: "x" })).slice(0, 6), aiWritten: false }, ctx.lang)) chosen.push(ex);
    if (chosen.length >= 2) break;
  }
  if (!chosen.length) return null;
  const { b, sents } = bulletsOf(chosen);
  const { sources, refs, refOf } = sourcesFor(ctx, sents);
  let k = 0;
  const bullets = b.map((x) => ({ ...x, ref: refOf.get(sents[k++]!.id) }));
  return { content: { layout: "bullets", title, bullets, sources, aiWritten: false }, notes: notesFor(ctx, sents), origin: { kind: "example", mode: "extractive", variant: o.variant ?? 0 }, refs };
}

export function buildConclusionSlide(ctx: Ctx, used: Set<number>, o: { variant?: number; avoid?: Set<string> } = {}): DraftSlide | null {
  const chs = chapters(ctx.m);
  const groups = chs.length ? chs.map((c) => c.sentences) : [ctx.m.sentences];
  const title = ctx.L.conclusion;
  const chosen: MSentence[] = [];
  for (const g of groups) {
    const ranked = rank(ctx, g.filter((s) => goodSentence(s.text) && !EXAMPLE.test(s.text) && !DEMONSTRATIVE.test(s.text)));
    const avoid = o.avoid ?? new Set<string>();
    const pick = ranked.find((s) => !used.has(s.id) && !((o.variant ?? 0) > 0 && avoid.has(norm(s.text)))) ?? ranked.find((s) => !used.has(s.id)) ?? ranked[0];
    if (!pick || chosen.includes(pick)) continue;
    const trial = [...chosen, pick];
    const bullets = trial.flatMap((s) => sentenceToBullets(ctx.typo(s.text)).slice(0, 1));
    if (!fitsEverywhere({ layout: "bullets", title, bullets, sources: trial.map(() => ({ label: "x" })).slice(0, 6), aiWritten: false }, ctx.lang)) continue;
    chosen.push(pick);
    if (chosen.length >= 4) break;
  }
  if (chosen.length < (chs.length ? 1 : 2)) return null;
  const { sources, refs, refOf } = sourcesFor(ctx, chosen);
  const bullets = chosen.map((s) => ({ ...sentenceToBullets(ctx.typo(s.text))[0]!, level: 0 as const, ref: refOf.get(s.id) }));
  return { content: { layout: "bullets", title, bullets, sources, aiWritten: false }, notes: notesFor(ctx, chosen), origin: { kind: "conclusion", mode: "extractive", variant: o.variant ?? 0 }, refs };
}

export function buildQuestionsSlide(ctx: Ctx, defs: FoundDefinition[]): DraftSlide {
  const qa = ctx.settings.extras?.defenseQa !== false
    ? defs.slice(0, 8).map((d) => `${ctx.L.question}: ${ctx.typo(ctx.L.whatIs(d.term))}\n${ctx.L.answer}: ${ctx.typo(d.sentence.text)} (${sourceLabel(d.sentence.docTitle, d.sentence.locator, ctx.lang)})`)
    : [];
  return {
    content: { layout: "questions", title: ctx.L.questions, prompt: ctx.L.questionsPrompt, sources: [], aiWritten: false },
    notes: qa.length ? `${ctx.L.defenseQa}:\n\n${qa.join("\n\n")}`.slice(0, 8000) : "",
    origin: { kind: "questions", mode: "extractive" },
    refs: [],
  };
}

/** Bibliography from real document metadata only (title, author, publication info, URL, file); never invented. */
export function referenceItems(m: Material, lang: Lang): string[] {
  const L = labels(lang);
  return m.docs.map((d) => {
    const parts: string[] = [d.author ? `${d.title} / ${d.author}` : d.title];
    if (d.publishedInfo) parts.push(d.publishedInfo);
    const kind = d.sourceKind.toUpperCase();
    if (d.sourceUrl) parts.push(`URL: ${d.sourceUrl}`);
    else if (d.sourceKind === "xlsx" || d.sourceKind === "csv") {
      const sheets = [...new Set(m.tables.filter((t) => t.docId === d.id).map((t) => t.sheet))];
      parts.push(`${d.filename ?? kind}${sheets.length && d.sourceKind === "xlsx" ? `, ${L.sheet} ${sheets.map((s) => `“${s}”`).join(", ")}` : ""}`);
    } else if (d.filename) parts.push(`${d.filename}${d.pageCount && d.sourceKind === "pdf" ? `, ${d.pageCount} ${lang === "en" ? "p." : lang === "ru" ? "с." : "bet"}` : ""}`);
    return uzTypography(`${parts.join(". — ")}.`, lang).replace(/\.\.$/, ".").slice(0, 400);
  });
}

export function buildReferencesSlide(ctx: Ctx): DraftSlide | null {
  const items = referenceItems(ctx.m, ctx.lang);
  if (!items.length) return null;
  return { content: { layout: "references", title: ctx.L.references, items, sources: [], aiWritten: false }, notes: "", origin: { kind: "references", mode: "extractive" }, refs: [] };
}

export function buildAgendaSlide(ctx: Ctx, items: string[]): DraftSlide | null {
  const clean = items.map((s) => ctx.typo(s).slice(0, 200)).filter(Boolean).slice(0, 12);
  if (clean.length < 2) return null;
  return { content: { layout: "agenda", title: ctx.L.agenda, items: clean, sources: [], aiWritten: false }, notes: "", origin: { kind: "agenda", mode: "extractive" }, refs: [] };
}

// ───────────────────────── tables → table + chart ─────────────────────────

const EXAMPLE_DATA = /haqiqiy statistika emas|o[‘’'ʻ`]?quv misoli|namuna ma[ʼ’']?lumot|misol uchun o[‘’'ʻ`]?ylab topilgan|example data|sample data|not real (data|statistics)|fictional|учебный пример|не (являются )?реальн|пример данных/iu;

export type TableAnalysis = {
  table: MTable;
  /** identical tables from other documents (e.g. the same data as CSV and XLSX), cited as well */
  copies?: MTable[];
  key: string;
  catCol: number;
  numCols: number[];
  yearLike: boolean;
  isExample: boolean;
};

export function analyzeTable(t: MTable): TableAnalysis | null {
  const n = t.columns.length;
  const colVals = (i: number) => t.rows.map((r) => r[i] ?? null);
  const isNum = (i: number) => {
    const v = colVals(i).filter((x) => x !== null);
    return v.length >= 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
  };
  const yearCol = (i: number) => {
    const v = colVals(i);
    return v.length >= 2 && v.every((x) => (typeof x === "number" && Number.isInteger(x) && x >= 1800 && x <= 2200) || (typeof x === "string" && /^(1[89]|2[01])\d{2}(\s*[-–]\s*\d{2,4})?$/.test(x.trim())));
  };
  let catCol = Array.from({ length: n }, (_, i) => i).find(yearCol) ?? -1;
  const yearLike = catCol >= 0;
  if (catCol < 0) catCol = Array.from({ length: n }, (_, i) => i).find((i) => colVals(i).every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= 60)) ?? -1;
  const numCols = Array.from({ length: n }, (_, i) => i).filter((i) => i !== catCol && isNum(i)).slice(0, 4);
  const text = [t.docTitle, t.sheet, ...t.columns, ...t.rows.flat().filter((x): x is string => typeof x === "string")].join(" \n ");
  return { table: t, key: `${t.docId}:${t.sheet}`, catCol, numCols, yearLike, isExample: EXAMPLE_DATA.test(text) };
}

const fmtNum = (v: number, lang: Lang) => (Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString().replace(".", lang === "en" ? "." : ","));

function tableSourceRef(ctx: Ctx, t: MTable): { label: string; ref: DraftRef } {
  const quote = [t.columns.join(" | "), ...t.rows.slice(0, 30).map((r) => r.map((x) => (x === null ? "" : String(x))).join(" | "))].join("\n").slice(0, 1200);
  // a CSV has no sheets: cite the file itself
  const label = t.sheet === "CSV" ? (t.filename ?? t.docTitle) : sourceLabel(t.docTitle, t.locator, ctx.lang);
  return { label: label.slice(0, 300), ref: { docId: t.docId, versionId: t.versionId, docTitle: t.docTitle, locator: t.sheet === "CSV" ? {} : t.locator, quote, verification: "table_value" } };
}

function tableSources(ctx: Ctx, a: TableAnalysis) {
  const all = [a.table, ...(a.copies ?? [])].slice(0, 3).map((t) => tableSourceRef(ctx, t));
  return { sources: all.map((x) => ({ label: x.label, verified: true })), refs: all.map((x) => x.ref), label: all.map((x) => x.label).join("; ") };
}

function seriesName(col: string): { name: string; unit?: string } {
  const m = /^(.+?)\s*\(([^)]{1,40})\)\s*$/.exec(col.trim());
  return m ? { name: m[1]!.trim(), unit: m[2]!.trim() } : { name: col.trim() };
}

export function buildChartSlide(ctx: Ctx, a: TableAnalysis): DraftSlide | null {
  if (a.catCol < 0 || !a.numCols.length) return null;
  const t = a.table;
  const rows = t.rows.filter((r) => r[a.catCol] != null).slice(0, 24);
  const categories = rows.map((r) => String(r[a.catCol]).slice(0, 60));
  const series = a.numCols.slice(0, 3).map((ci) => ({ name: ctx.typo(t.columns[ci]!).slice(0, 80), values: rows.map((r) => (typeof r[ci] === "number" ? (r[ci] as number) : NaN)) })).filter((s) => s.values.every(Number.isFinite));
  if (!series.length) return null;
  const first = seriesName(t.columns[a.numCols[0]!]!);
  const units = [...new Set(a.numCols.map((ci) => seriesName(t.columns[ci]!).unit).filter(Boolean))];
  const unit = units.length === 1 ? ctx.typo(units[0]!) : undefined;
  const period = a.yearLike && categories.length >= 2 ? `${categories[0]}–${categories[categories.length - 1]}` : undefined;
  const s0 = series[0]!;
  let takeaway: string | undefined;
  let formula = "";
  if (s0.values.length >= 2 && a.yearLike) {
    const v0 = s0.values[0]!;
    const vN = s0.values[s0.values.length - 1]!;
    const diff = vN - v0;
    const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
    const pct = v0 !== 0 ? (diff / Math.abs(v0)) * 100 : null;
    takeaway = `${ctx.L.change} ${categories[0]}–${categories[categories.length - 1]}: ${ctx.L.fromTo(fmtNum(v0, ctx.lang), fmtNum(vN, ctx.lang))} (${sign}${fmtNum(Math.abs(diff), ctx.lang)}${pct !== null ? `; ${sign}${fmtNum(Math.round(Math.abs(pct) * 10) / 10, ctx.lang)}%` : ""})`;
    formula = pct !== null ? `${ctx.L.change} (${ctx.L.computed}): (${fmtNum(vN, ctx.lang)} − ${fmtNum(v0, ctx.lang)}) / ${fmtNum(Math.abs(v0), ctx.lang)} × 100 = ${fmtNum(Math.round(pct * 10) / 10, ctx.lang)}%` : "";
  }
  const kind: "line" | "column" | "pie" = a.yearLike && categories.length >= 3 ? "line" : "column";
  const src = tableSources(ctx, a);
  const title = ctx.typo(series.length === 1 ? first.name : ctx.L.data).slice(0, 200);
  const content: SlideContent = {
    layout: "chart",
    title,
    kicker: ctx.L.data,
    chartKind: kind,
    categories,
    series,
    ...(unit ? { unit: unit.slice(0, 40) } : {}),
    ...(period ? { period } : {}),
    caption: ctx.typo(`${ctx.L.indicator}: ${series.map((s) => seriesName(s.name).name).join(", ")}`).slice(0, 300),
    dataOrigin: "source_table",
    ...(takeaway ? { takeaway: takeaway.slice(0, 300) } : {}),
    ...(a.isExample ? { isExample: true } : {}),
    sources: src.sources,
    aiWritten: false,
  };
  const notes = [
    `${ctx.L.source}: ${src.label}. ${ctx.L.columns}: ${t.columns.join("; ")}.`,
    ...series.map((s) => `${s.name}: ${categories.map((c, i) => `${c} — ${fmtNum(s.values[i]!, ctx.lang)}`).join("; ")}`),
    formula,
    a.isExample ? ctx.L.exampleBadge : "",
  ].filter(Boolean).join("\n");
  return { content, notes, origin: { kind: "chart", mode: "extractive", anchor: a.key }, refs: src.refs };
}

export function buildTableSlide(ctx: Ctx, a: TableAnalysis): DraftSlide | null {
  const t = a.table;
  if (!t.columns.length || !t.rows.length) return null;
  const cols = t.columns.slice(0, 8);
  const rows = t.rows.slice(0, 12).map((r) => cols.map((_, i) => ctx.typo(r[i] === null || r[i] === undefined ? "" : typeof r[i] === "number" ? fmtNum(r[i] as number, ctx.lang) : String(r[i])).slice(0, 120)));
  const src = tableSources(ctx, a);
  const more = t.rows.length > 12 || t.columns.length > 8 || t.truncated;
  const caption = `${ctx.L.columns}: ${cols.join(", ")}${more ? ` (${t.rows.length}${t.truncated ? "+" : ""} × ${t.columns.length})` : ""}`;
  return {
    content: { layout: "table", title: ctx.typo(`${ctx.L.table}: ${seriesName(t.columns[a.numCols[0] ?? 0] ?? t.sheet).name}`).slice(0, 200), kicker: ctx.L.data, columns: cols.map((c) => ctx.typo(c).slice(0, 80)), rows, caption: ctx.typo(capitalize(caption)).slice(0, 300), ...(a.isExample ? { isExample: true } : {}), sources: src.sources, aiWritten: false },
    notes: `${ctx.L.source}: ${src.label}.${a.isExample ? `\n${ctx.L.exampleBadge}` : ""}`,
    origin: { kind: "table", mode: "extractive", anchor: a.key },
    refs: src.refs,
  };
}

/** Chart or table slide for one source table (used by the AI path too: numbers never come from a model). */
export function dataSlide(m: Material, settings: DeckSettings, a: TableAnalysis, kind: "chart" | "table"): DraftSlide | null {
  const ctx = makeCtx(m, settings);
  return kind === "chart" ? buildChartSlide(ctx, a) : buildTableSlide(ctx, a);
}

/** Distinct tables (identical CSV/XLSX copies are shown once). */
export function deckTables(m: Material): TableAnalysis[] {
  const seen = new Map<string, TableAnalysis>();
  const out: TableAnalysis[] = [];
  for (const t of m.tables) {
    const sig = JSON.stringify([t.columns, t.rows.slice(0, 50)]);
    const prev = seen.get(sig);
    if (prev) {
      if (prev.table.docId !== t.docId) prev.copies = [...(prev.copies ?? []), t];
      continue;
    }
    const a = analyzeTable(t);
    if (!a) continue;
    seen.set(sig, a);
    out.push(a);
  }
  return out;
}

// ───────────────────────── deck assembly ─────────────────────────

const ORDER: Record<OriginKind, number> = { title: 0, goal: 1, agenda: 2, definition: 3, chapter: 4, chart: 5, table: 6, example: 7, conclusion: 8, questions: 9, references: 10, manual: 4, ai: 4 };

/**
 * Builds the whole deck. Slides are chosen by priority until the requested
 * count is reached, then ordered along the recommended flow: title → goal →
 * outline → concepts → analysis/evidence → example → conclusion → questions →
 * references.
 */
export function buildExtractiveDeck(m: Material, settings: DeckSettings, deckTitle: string): { slides: DraftSlide[]; outline: DeckOutlineItem[]; warnings: string[] } {
  const ctx = makeCtx(m, settings);
  const N = settings.slideCount;
  const chs = chapters(m).filter((c) => c.sentences.some((s) => goodSentence(s.text)));
  // documents without an outline: titled blocks with prose stand in for chapters
  const parts: Chapter[] = chs.length
    ? chs
    : m.blocks.filter((b) => b.sentences.filter((s) => goodSentence(s.text)).length >= 2 && b !== introBlock(m)).map((b) => ({ block: { ...b, title: b.title ?? deckTitle }, sentences: b.sentences, subs: [] }));
  // one concept per chapter first, so the concept slides cover the whole material
  const defs = roundRobin(findDeckDefinitions(m), (d) => d.chapterId ?? -1);
  const tables = deckTables(m);
  const used = new Set<number>();
  const defSlot = (d: FoundDefinition, i: number) => ({
    order: ORDER.definition,
    sub: i,
    build: () => {
      used.add(d.sentence.id);
      if (d.extra) used.add(d.extra.id);
      return buildDefinitionSlide(ctx, d);
    },
  });
  const chapterSlot = (c: Chapter, i: number, second: boolean) => ({
    order: ORDER.chapter,
    sub: i * 2 + (second ? 1 : 0),
    build: () => {
      // sentences already shown on definition slides are not repeated as bullets
      const exclude = new Set(used);
      const layout: "bullets" | "two_column" = (i + (second ? 1 : 0)) % 2 === 0 && c.subs.length >= 2 ? "two_column" : "bullets";
      const d = buildChapterSlide(ctx, c, layout, { exclude, variant: second ? 1 : 0 });
      if (d) collectUsed(d, m, used);
      return d;
    },
  });

  const priority: { order: number; sub: number; build: () => DraftSlide | null }[] = [];
  priority.push({ order: ORDER.title, sub: 0, build: () => buildTitleSlide(ctx, deckTitle) });
  if (m.docs.length) priority.push({ order: ORDER.references, sub: 0, build: () => buildReferencesSlide(ctx) });
  const defsFirst = defs.slice(0, Math.max(1, Math.round(N / 6)));
  // definitions are built before chapters so chapter bullets can skip their sentences
  defsFirst.forEach((d, i) => priority.push(defSlot(d, i)));
  parts.forEach((c, i) => priority.push(chapterSlot(c, i, false)));
  tables.slice(0, 2).forEach((a, i) => {
    priority.push({ order: ORDER.chart, sub: i * 2, build: () => buildChartSlide(ctx, a) });
    priority.push({ order: ORDER.chart, sub: i * 2 + 1, build: () => buildTableSlide(ctx, a) });
  });
  if (parts.length >= 2) priority.push({ order: ORDER.agenda, sub: 0, build: () => buildAgendaSlide(ctx, [...parts.map((c) => splitHeading(c.block.title ?? "").title), ...(tables.length ? [ctx.L.data] : [])]) });
  priority.push({ order: ORDER.conclusion, sub: 0, build: () => buildConclusionSlide(ctx, used) });
  priority.push({ order: ORDER.questions, sub: 0, build: () => buildQuestionsSlide(ctx, defs) });
  priority.push({ order: ORDER.goal, sub: 0, build: () => buildGoalSlide(ctx) });
  priority.push({ order: ORDER.example, sub: 0, build: () => buildExampleSlide(ctx) });
  defs.slice(defsFirst.length).forEach((d, i) => priority.push(defSlot(d, defsFirst.length + i)));
  parts.forEach((c, i) => priority.push(chapterSlot(c, i, true)));

  // The first N slots by priority are built in narrative order (so sentences used on concept slides are
  // not repeated in the analysis); slots whose material turns out too thin are replaced by the next ones.
  const pending = priority.map((p, prio) => ({ ...p, prio }));
  const take = pending.slice(0, N).sort((a, b) => a.order - b.order || a.sub - b.sub);
  const built: { order: number; sub: number; slide: DraftSlide }[] = [];
  for (const p of take) {
    const s = p.build();
    if (s) built.push({ order: p.order, sub: p.sub, slide: s });
  }
  for (let next = N; built.length < N && next < pending.length; next++) {
    const p = pending[next]!;
    const s = p.build();
    if (s) built.push({ order: p.order, sub: p.sub, slide: s });
  }
  built.sort((a, b) => a.order - b.order || a.sub - b.sub);
  // drop duplicates (e.g. a second chapter slide that ended up identical to the first)
  const seen = new Set<string>();
  const slides = built.map((b) => b.slide).filter((s) => {
    const sig = JSON.stringify(s.content);
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });
  const warnings: string[] = [];
  if (slides.length < N) warnings.push(`material_short:${slides.length}/${N}`);
  if (!m.sentences.length && !m.tables.length) warnings.push("no_source_text");
  // the main idea travels with the slide: shown in the outline, used when the slide is regenerated
  for (const s of slides) s.origin.idea ??= ideaOf(s);
  const outline: DeckOutlineItem[] = slides.map((s) => ({ layout: s.content.layout, title: s.content.title, idea: s.origin.idea ?? "" }));
  return { slides, outline, warnings };
}

function roundRobin<T>(list: T[], group: (x: T) => number): T[] {
  const groups = new Map<number, T[]>();
  for (const x of list) {
    const g = group(x);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(x);
  }
  const out: T[] = [];
  for (let i = 0; out.length < list.length; i++) for (const g of groups.values()) if (g[i]) out.push(g[i]!);
  return out;
}

function collectUsed(d: DraftSlide, m: Material, used: Set<number>) {
  const texts = new Set(d.refs.flatMap((r) => r.quote.split(/(?<=[.!?…])\s+/)).map((x) => norm(x)));
  for (const s of m.sentences) if (texts.has(norm(s.text))) used.add(s.id);
}

function ideaOf(s: DraftSlide): string {
  const c = s.content;
  const text =
    c.layout === "bullets" ? c.bullets[0]?.text
    : c.layout === "definition" ? c.definition
    : c.layout === "two_column" ? `${c.left.heading} / ${c.right.heading}`
    : c.layout === "chart" ? c.takeaway ?? c.caption
    : c.layout === "agenda" ? c.items.join("; ")
    : "";
  return (text ?? "").slice(0, 400);
}

/**
 * A bullets slide for a free-form title (a slide the student added to the
 * outline): the material's sentences that best match the title and idea.
 */
export function buildQuerySlide(m: Material, settings: DeckSettings, title: string, idea: string, o: { avoid?: Set<string>; variant?: number } = {}): DraftSlide | null {
  const ctx = makeCtx(m, settings);
  const q = [...new Set(contentStems(`${title} ${idea}`))];
  if (!q.length) return null;
  const pool = m.sentences
    .map((s) => ({ s, c: coverage(q, contentStems(s.text)) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c || (ctx.scores.get(b.s.id) ?? 0) - (ctx.scores.get(a.s.id) ?? 0))
    .slice(0, 15)
    .map((x) => x.s);
  const t = ctx.typo(title).slice(0, 200);
  const make = (bullets: Bullet[]): SlideContent => ({ layout: "bullets", title: t, bullets, sources: [{ label: "x" }, { label: "y" }], aiWritten: false });
  const chosen = pickBullets(ctx, pool, make, { max: 4, maxWords: 70, avoid: o.avoid, variant: o.variant, ordered: true });
  if (!chosen.length) return null;
  const { sources, refs, refOf } = sourcesFor(ctx, chosen);
  return { content: { layout: "bullets", title: t, bullets: bulletsWithRefs(ctx, chosen, refOf), sources, aiWritten: false }, notes: notesFor(ctx, chosen), origin: { kind: "manual", mode: "extractive", idea, variant: o.variant ?? 0 }, refs };
}

// ───────────────────────── single-slide regeneration ─────────────────────────

/** Visible texts of a slide (to prefer different sentences on regenerate). */
export function slideTexts(c: SlideContent): Set<string> {
  const out: string[] = [];
  if (c.layout === "bullets") out.push(...c.bullets.map((b) => b.text));
  if (c.layout === "two_column") out.push(...c.left.bullets.map((b) => b.text), ...c.right.bullets.map((b) => b.text));
  if (c.layout === "definition") out.push(c.definition);
  return new Set(out.flatMap((t) => t.split(/(?<=[.!?…])\s+/)).map((t) => norm(t)));
}

/**
 * Rebuilds one slide from the same material anchor. Prefers sentences not on
 * the slide yet; when the material has no alternative, the slide is rebuilt
 * from the source as it was generated (which also undoes broken edits).
 */
export function regenerateExtractive(m: Material, settings: DeckSettings, deckTitle: string, origin: SlideOrigin, current: SlideContent, otherSlides: SlideContent[]): DraftSlide | null {
  const ctx = makeCtx(m, settings);
  const variant = (origin.variant ?? 0) + 1;
  const avoid = slideTexts(current);
  const elsewhere = new Set<number>();
  const otherTexts = new Set(otherSlides.flatMap((c) => [...slideTexts(c)]));
  for (const s of m.sentences) if (otherTexts.has(norm(s.text))) elsewhere.add(s.id);
  switch (origin.kind) {
    case "title":
      return buildTitleSlide(ctx, current.title || deckTitle);
    case "goal":
      return buildGoalSlide(ctx, variant, avoid);
    case "agenda": {
      const parts = chapters(m).map((c) => splitHeading(c.block.title ?? "").title);
      return buildAgendaSlide(ctx, parts.length >= 2 ? parts : current.layout === "agenda" ? current.items : []);
    }
    case "definition": {
      const d = findDeckDefinitions(m).find((x) => anchorKey(x.term) === origin.anchor);
      return d ? buildDefinitionSlide(ctx, d) : null;
    }
    case "chapter": {
      const ch = chapters(m).find((c) => anchorKey(c.block.title ?? "") === origin.anchor);
      if (!ch) return null;
      const layout = (origin.layout === "two_column" ? "two_column" : "bullets") as "bullets" | "two_column";
      const d = buildChapterSlide(ctx, ch, layout, { exclude: elsewhere, variant, avoid }) ?? buildChapterSlide(ctx, ch, layout, { variant, avoid });
      return d ? { ...d, origin: { ...d.origin, variant } } : null;
    }
    case "chart":
    case "table": {
      const a = deckTables(m).find((x) => x.key === origin.anchor);
      if (!a) return null;
      return origin.kind === "chart" ? buildChartSlide(ctx, a) : buildTableSlide(ctx, a);
    }
    case "example":
      return buildExampleSlide(ctx, { variant, avoid });
    case "conclusion":
      return buildConclusionSlide(ctx, elsewhere, { variant, avoid });
    case "questions":
      return buildQuestionsSlide(ctx, findDeckDefinitions(m));
    case "references":
      return buildReferencesSlide(ctx);
    default: {
      // slides the student added (or AI slides regenerated without AI): best-matching sentences for the title
      const texts = current.layout === "bullets" ? current.bullets.map((b) => b.text).join(" ") : "";
      return buildQuerySlide(m, settings, current.title, origin.idea ?? texts, { avoid, variant });
    }
  }
}
