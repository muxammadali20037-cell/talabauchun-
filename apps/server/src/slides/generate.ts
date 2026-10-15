import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CreateDeckRequest, DeckOutlineItem, translate, type DeckSettings, type Lang } from "@talaba/shared";
import type { Deps } from "../deps";
import { AiError } from "../ai/client";
import { estimateCredits, loadPricing } from "../billing/credits";
import { JobCancelled, JobError, type JobContext, type JobResult } from "../jobs/queue";
import { escapeHtml } from "../ingest/pipeline";
import { retrieve } from "../search/retrieve";
import { enqueueMessage } from "../telegram/outbox";
import { miniAppUrl } from "../telegram/links";
import { aiPlan, aiRegenerate, aiWrite, sampleChunks, sourcePack, trimToFit, type PlanItem } from "./ai-gen";
import {
  buildAgendaSlide, buildExtractiveDeck, buildQuerySlide, buildQuestionsSlide, buildReferencesSlide, buildTitleSlide,
  findDeckDefinitions, makeCtx, regenerateExtractive, type DraftSlide, type SlideOrigin,
} from "./extractive";
import { labels } from "./labels";
import { layoutDeck } from "./layout";
import { loadMaterial, type Material } from "./material";
import { renderPptx } from "./render-pptx";
import { convertPptxToPdf, RenderError, renderPngs, withWorkDir } from "./render-pdf";
import { attachRefIds, bumpDeck, getDeckRow, getSlideRow, insertDraftSlide, insertSourceRefs, liveSlides, parseSettings, writeVersion, type DeckRow } from "./store";
import { getTheme } from "./themes";
import { failedChecks, verifyPdf, verifyPptx, type CheckReport } from "./verify";

/**
 * Background work of Presentation Studio:
 *  - generate_deck: plan (+ write) slides from the material, fit them, store them;
 *  - regenerate_slide: rebuild exactly one slide (other slides untouched);
 *  - export_deck: render PPTX (and PDF via LibreOffice) from the laid-out model,
 *    verify the files and only then mark the export ready.
 */

export type GenerateInput = { deckId: string; request: CreateDeckRequest; useAi: boolean; planOnly: boolean; fromOutline?: DeckOutlineItem[] | null };
export type RegenerateInput = { deckId: string; slideId: string; baseRevision: number; instruction: string | null; useAi: boolean };
export type ExportInput = { deckId: string; exportId: string; format: "pptx" | "pdf" };

type Meta = { userId: string; workspaceId: string; jobId: string };

function mapError(e: unknown): unknown {
  if (e instanceof AiError) return new JobError(`ai_${e.code}`, e.retryable, e.message);
  if (e instanceof RenderError) return new JobError(e.code, e.retryable, e.message);
  return e;
}

/** True when this failure ends the job (no retry follows), so the deck/export row must show it. */
function isFinal(e: unknown, ctx: JobContext): boolean {
  if (e instanceof JobCancelled) return true;
  const retryable = e instanceof JobError ? e.retryable : true;
  return !retryable || ctx.job.attempts >= ctx.job.max_attempts;
}

const DETERMINISTIC = new Set(["title", "agenda", "questions", "references"]);

// ───────────────────────── generate_deck ─────────────────────────

async function buildAiDeck(deps: Deps, m: Material, st: DeckSettings, deck: DeckRow, input: GenerateInput, meta: Meta) {
  const ai = deps.ai!;
  const pack = sourcePack(m, sampleChunks(m.chunks, 60));
  const contentN = Math.max(1, st.slideCount - (m.docs.length ? 4 : 3));
  const stored = (deck.generation?.plan as PlanItem[] | undefined) ?? [];
  let items: PlanItem[];
  let note: string | null = null;
  if (input.fromOutline) {
    items = input.fromOutline
      .filter((o) => !(o.key && DETERMINISTIC.has(o.key)))
      .map((o) => {
        const planned = o.key?.startsWith("p") ? stored[Number(o.key.slice(1))] : undefined;
        const layout = (["bullets", "two_column", "definition", "chart", "table"] as const).find((l) => l === o.layout) ?? "bullets";
        return { layout, title: o.title, idea: o.idea || planned?.idea || "", sourceIds: planned?.sourceIds ?? [] };
      });
  } else {
    const plan = await aiPlan(ai, pack, st, deck.title, contentN, meta);
    items = plan.items;
    note = plan.note;
  }
  const ctx = makeCtx(m, st);
  const L = labels(st.language);
  const titleSlide = buildTitleSlide(ctx, deck.title);
  const refsSlide = buildReferencesSlide(ctx);
  const outline: DeckOutlineItem[] = [
    { layout: "title", title: titleSlide.content.title, idea: "", key: "title" },
    ...(items.length >= 3 ? [{ layout: "agenda" as const, title: L.agenda, idea: "", key: "agenda" }] : []),
    ...items.map((it, i) => ({ layout: it.layout, title: it.title, idea: it.idea, key: `p${i}` })),
    { layout: "questions", title: L.questions, idea: "", key: "questions" },
    ...(refsSlide ? [{ layout: "references" as const, title: L.references, idea: "", key: "references" }] : []),
  ];
  if (input.planOnly) return { outline, plan: items, note, drafts: null, warnings: [] as string[] };
  const { drafts, dropped, qa } = await aiWrite(ai, items, pack, st, meta);
  const written = drafts.filter((d): d is DraftSlide => !!d);
  const questions = buildQuestionsSlide(ctx, findDeckDefinitions(m));
  if (qa.length) questions.notes = `${L.defenseQa} (AI):\n\n${qa.map((x) => `${L.question}: ${x.question}\n${L.answer}: ${x.answer}`).join("\n\n")}`.slice(0, 8000);
  const agenda = written.length >= 3 ? buildAgendaSlide(ctx, written.map((d) => d.content.title)) : null;
  const slides = [titleSlide, ...(agenda ? [agenda] : []), ...written, questions, ...(refsSlide ? [refsSlide] : [])];
  const warnings: string[] = [];
  if (dropped) warnings.push(`citations_dropped:${dropped}`);
  if (written.length < items.length) warnings.push(`slides_not_written:${items.length - written.length}`);
  return { outline, plan: items, note, drafts: slides, warnings };
}

/** Applies an edited outline to extractive drafts: kept items reuse their draft, new items are matched to the material. */
function applyOutline(drafts: DraftSlide[], outline: DeckOutlineItem[], m: Material, st: DeckSettings): DraftSlide[] {
  const out: DraftSlide[] = [];
  for (const o of outline) {
    const idx = o.key?.startsWith("d") ? Number(o.key.slice(1)) : NaN;
    const d = Number.isInteger(idx) ? drafts[idx] : undefined;
    if (d) out.push(o.title && o.title !== d.content.title ? { ...d, content: { ...d.content, title: o.title.slice(0, 200) } } : d);
    else {
      const q = buildQuerySlide(m, st, o.title, o.idea);
      if (q) out.push(q);
    }
  }
  return out;
}

export function generateDeckHandler(deps: Deps) {
  return async (ctx: JobContext): Promise<JobResult> => {
    const input = ctx.job.input as unknown as GenerateInput;
    try {
      return await generateDeck(deps, ctx, input);
    } catch (e) {
      const err = mapError(e);
      if (isFinal(err, ctx)) {
        const code = err instanceof JobError ? err.code : err instanceof JobCancelled ? "cancelled" : "internal_error";
        await deps.sql`update decks set status = 'failed', generation = generation || ${deps.sql.json({ errorCode: code } as never)}, updated_at = now()
          where id = ${input.deckId} and status in ('planning','generating')`.catch(() => {});
      }
      throw err;
    }
  };
}

async function generateDeck(deps: Deps, ctx: JobContext, input: GenerateInput): Promise<JobResult> {
  const deck = await getDeckRow(deps.sql, input.deckId);
  const st = parseSettings(deck.settings);
  const req = CreateDeckRequest.parse(input.request);
  const useAi = input.useAi && !!deps.ai;
  const meta: Meta = { userId: ctx.job.user_id, workspaceId: ctx.job.workspace_id, jobId: ctx.job.id };
  const pricing = await loadPricing(deps.sql);
  let drafts = (ctx.checkpoint.drafts as DraftSlide[] | undefined) ?? null;
  let outline = (ctx.checkpoint.outline as DeckOutlineItem[] | undefined) ?? [];
  let warnings = (ctx.checkpoint.warnings as string[] | undefined) ?? [];
  let note = (ctx.checkpoint.note as string | null | undefined) ?? null;

  // ── generating ── (checkpointed: a restart does not pay for the model calls twice)
  if (!drafts) {
    await ctx.stage("generating");
    await deps.sql`update decks set status = ${input.planOnly ? "planning" : "generating"}, updated_at = now() where id = ${deck.id}`;
    if (!useAi && !deck.source_document_ids.length) throw new JobError("deck_needs_source");
    const m = await loadMaterial(deps, { userId: ctx.job.user_id, documentIds: deck.source_document_ids, pageRanges: req.pageRanges, sectionIds: req.sectionIds });
    if (deck.source_document_ids.length && !m.sentences.length && !m.tables.length) throw new JobError("no_source_text");
    let plan: PlanItem[] | null = null;
    if (useAi) {
      const r = await buildAiDeck(deps, m, st, deck, input, meta);
      outline = r.outline;
      plan = r.plan;
      note = r.note;
      drafts = r.drafts;
      warnings = r.warnings;
    } else {
      const stashed = input.fromOutline ? ((deck.generation?.drafts as DraftSlide[] | undefined) ?? null) : null;
      const r = stashed ? { slides: stashed, outline: [], warnings: [] } : buildExtractiveDeck(m, st, deck.title);
      drafts = input.fromOutline ? applyOutline(r.slides, input.fromOutline, m, st) : r.slides;
      outline = (input.planOnly ? r.slides : drafts).map((d, i) => ({ layout: d.content.layout, title: d.content.title, idea: d.origin.idea ?? "", key: `d${i}` }));
      warnings = r.warnings;
    }
    if (input.planOnly) {
      await deps.sql`update decks set status = 'plan_ready', outline = ${deps.sql.json(outline as never)},
        generation = generation || ${deps.sql.json({ mode: useAi ? "ai" : "extractive", note, warnings, plan: plan ?? undefined, drafts: useAi ? undefined : drafts } as never)},
        updated_at = now() where id = ${deck.id}`;
      await notify(deps, ctx, deck, "plan");
      return { result: { deckId: deck.id, status: "plan_ready", planned: outline.length, mode: useAi ? "ai" : "extractive" }, creditsUsed: useAi ? 1 : 0 };
    }
    if (!drafts?.length) throw new JobError("no_slides_generated");
    await ctx.saveCheckpoint({ drafts, outline, warnings, note });
  }
  await ctx.throwIfCancelled();

  // ── validating ── one page per slide in every theme, then store everything atomically
  await ctx.stage("validating");
  const lang = st.language;
  const final = drafts.map((d) => ({ ...d, content: trimToFit(d.content, lang) }));
  await deps.sql.begin(async (tx) => {
    const d = await getDeckRow(tx, deck.id, true);
    // idempotent on retry: replace whatever an earlier attempt wrote
    await tx`delete from slides where deck_id = ${deck.id}`;
    for (let i = 0; i < final.length; i++) await insertDraftSlide(tx, d, i, final[i]!, ctx.job.user_id);
    const generation = { mode: useAi ? "ai" : "extractive", warnings, note, requested: st.slideCount, produced: final.length, generatedAt: new Date().toISOString(), drafts: null };
    await tx`update decks set status = 'ready', outline = ${tx.json(outline as never)}, generation = generation || ${tx.json(generation as never)},
      revision = revision + 1, updated_at = now() where id = ${deck.id}`;
  });
  await notify(deps, ctx, deck, "ready", final.length);
  return {
    result: { deckId: deck.id, produced: final.length, requested: st.slideCount, warnings, mode: useAi ? "ai" : "extractive" },
    creditsUsed: estimateCredits(pricing, { kind: "deck", slides: final.length, ai: useAi }),
  };
}

// ───────────────────────── regenerate_slide ─────────────────────────

export function regenerateSlideHandler(deps: Deps) {
  return async (ctx: JobContext): Promise<JobResult> => {
    try {
      return await regenerateSlide(deps, ctx, ctx.job.input as unknown as RegenerateInput);
    } catch (e) {
      throw mapError(e);
    }
  };
}

async function regenerateSlide(deps: Deps, ctx: JobContext, input: RegenerateInput): Promise<JobResult> {
  const deck = await getDeckRow(deps.sql, input.deckId);
  const slide = await getSlideRow(deps.sql, deck.id, input.slideId);
  if (slide.deleted_at) throw new JobError("slide_deleted");
  // the student edited the slide after asking for a new version: never overwrite that edit
  if (slide.revision !== input.baseRevision) throw new JobError("slide_changed");
  const st = parseSettings(deck.settings);
  const meta: Meta = { userId: ctx.job.user_id, workspaceId: ctx.job.workspace_id, jobId: ctx.job.id };
  let draft = (ctx.checkpoint.draft as DraftSlide | undefined) ?? null;
  let aiUsed = (ctx.checkpoint.aiUsed as boolean | undefined) ?? false;
  if (!draft) {
    await ctx.stage("generating");
    const scope = (deck.generation?.scope ?? {}) as { pageRanges?: CreateDeckRequest["pageRanges"]; sectionIds?: string[] };
    const m = await loadMaterial(deps, { userId: ctx.job.user_id, documentIds: deck.source_document_ids, ...scope });
    const others = (await liveSlides(deps.sql, deck.id)).filter((s) => s.id !== slide.id).map((s) => s.content);
    const origin = (slide.origin && "kind" in slide.origin ? slide.origin : { kind: "manual", mode: "user" }) as SlideOrigin;
    const aiLayouts = new Set(["bullets", "two_column", "definition"]);
    if (input.useAi && deps.ai && aiLayouts.has(slide.content.layout) && !["chart", "table"].includes(origin.kind)) {
      const query = [slide.content.title, origin.idea ?? ""].join(" ");
      let chunks = deck.source_document_ids.length ? await retrieve(deps, { query, userId: ctx.job.user_id, documentIds: deck.source_document_ids, limit: 8 }) : [];
      if (!chunks.length) chunks = sampleChunks(m.chunks, 12);
      const r = await aiRegenerate(deps.ai, slide.content, origin.idea ?? "", input.instruction, sourcePack({ ...m, tables: [] }, chunks), st, meta);
      draft = r.draft ? { ...r.draft, origin: { ...r.draft.origin, idea: origin.idea } } : null;
      aiUsed = true;
    } else {
      draft = regenerateExtractive(m, st, deck.title, origin, slide.content, others);
    }
    if (!draft) throw new JobError("nothing_to_regenerate");
    draft = { ...draft, content: trimToFit(draft.content, st.language) };
    await ctx.saveCheckpoint({ draft, aiUsed });
  }
  await ctx.stage("validating");
  const revision = await deps.sql.begin(async (tx) => {
    const cur = await getSlideRow(tx, deck.id, slide.id, true);
    if (cur.deleted_at) throw new JobError("slide_deleted");
    if (cur.revision !== input.baseRevision) throw new JobError("slide_changed");
    const ids = await insertSourceRefs(tx, deck.workspace_id, draft!.refs);
    const content = attachRefIds(draft!.content, ids);
    const next = cur.revision + 1;
    await tx`update slides set content = ${tx.json(content as never)}, notes = ${draft!.notes}, origin = ${tx.json(draft!.origin as never)},
      revision = ${next}, updated_by = ${ctx.job.user_id}, updated_at = now() where id = ${slide.id}`;
    await writeVersion(tx, { slideId: slide.id, revision: next, position: cur.position, content, notes: draft!.notes, kind: "regenerate", userId: ctx.job.user_id });
    await bumpDeck(tx, deck.id);
    return next;
  });
  const pricing = await loadPricing(deps.sql);
  return { result: { deckId: deck.id, slideId: slide.id, revision, mode: aiUsed ? "ai" : "extractive" }, creditsUsed: estimateCredits(pricing, { kind: "slide_regen", ai: aiUsed }) };
}

// ───────────────────────── export_deck ─────────────────────────

export type RenderedDeck = { file: Buffer; checks: CheckReport; slideCount: number; thumbnails: Buffer[]; pptx: Buffer; pdf: Buffer | null };

/** Renders and verifies a deck (used by the export job and by tests/evidence). */
export async function renderDeck(deps: Pick<Deps, "cfg">, deck: Pick<DeckRow, "title" | "theme" | "settings">, slides: { id: string; content: import("@talaba/shared").SlideContent; notes: string }[], format: "pptx" | "pdf", o: { thumbnails?: boolean; dpi?: number } = {}): Promise<RenderedDeck> {
  const st = parseSettings(deck.settings);
  const theme = getTheme(deck.theme);
  const laid = layoutDeck(slides, theme, { language: st.language });
  const pptx = await renderPptx(laid, theme, { title: deck.title, author: st.author ?? null, subject: st.subject ?? st.topic, language: st.language });
  const pptxChecks = await verifyPptx(pptx, laid);
  if (format === "pptx" && !o.thumbnails) return { file: pptx, checks: pptxChecks, slideCount: laid.length, thumbnails: [], pptx, pdf: null };
  return withWorkDir(async (dir) => {
    const { pdf, pdfPath } = await convertPptxToPdf(pptx, dir, { bin: deps.cfg.LIBREOFFICE_BIN, timeoutMs: 120_000 });
    const pdfChecks = await verifyPdf(pdfPath, laid, { pdftoppm: deps.cfg.PDFTOPPM_BIN });
    const thumbnails = o.thumbnails === false ? [] : await Promise.all((await renderPngs(pdfPath, dir, { bin: deps.cfg.PDFTOPPM_BIN, dpi: o.dpi ?? 50 })).map((p) => readFile(p)));
    const checks = { ok: pptxChecks.ok && pdfChecks.ok, checks: [...pptxChecks.checks, ...pdfChecks.checks] };
    return { file: format === "pdf" ? pdf : pptx, checks, slideCount: laid.length, thumbnails, pptx, pdf };
  });
}

export function exportDeckHandler(deps: Deps) {
  return async (ctx: JobContext): Promise<JobResult> => {
    const input = ctx.job.input as unknown as ExportInput;
    try {
      return await exportDeck(deps, ctx, input);
    } catch (e) {
      const err = mapError(e);
      if (isFinal(err, ctx)) {
        const code = err instanceof JobError ? err.code : err instanceof JobCancelled ? "cancelled" : "internal_error";
        await deps.sql`update exports set status = 'failed', error = ${code} where id = ${input.exportId} and status <> 'ready'`.catch(() => {});
      }
      throw err;
    }
  };
}

async function exportDeck(deps: Deps, ctx: JobContext, input: ExportInput): Promise<JobResult> {
  const deck = await getDeckRow(deps.sql, input.deckId);
  const [exp] = await deps.sql<{ id: string; deck_revision: number; status: string }[]>`select id, deck_revision, status from exports where id = ${input.exportId}`;
  if (!exp) throw new JobError("export_missing");
  if (exp.status === "ready") return { result: { exportId: exp.id, status: "ready" } };
  await ctx.stage("rendering");
  await deps.sql`update exports set status = 'rendering' where id = ${exp.id}`;
  const slides = await liveSlides(deps.sql, deck.id);
  if (!slides.length) throw new JobError("deck_empty");
  // PDF thumbnails are produced for every export: they double as the visual check of the layout
  const r = await renderDeck(deps, deck, slides, input.format, { thumbnails: true });
  await ctx.stage("validating");
  const failed = failedChecks(r.checks);
  const thumbKeys: string[] = [];
  for (const png of r.thumbnails.slice(0, 60)) {
    const key = deps.storage.newKey(deck.workspace_id, "png");
    await deps.storage.put(key, png);
    thumbKeys.push(key);
  }
  const checks = { ok: r.checks.ok, slideCount: r.slideCount, checks: r.checks.checks, thumbnails: thumbKeys, checkedAt: new Date().toISOString() };
  if (failed.length) {
    // a file that failed a check is never offered for download
    await deps.sql`update exports set status = 'failed', error = ${`checks_failed:${failed.join(",")}`.slice(0, 500)}, checks = ${deps.sql.json(checks as never)} where id = ${exp.id}`;
    throw new JobError("export_checks_failed", false, failed.join(","));
  }
  const ext = input.format;
  const mime = ext === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const key = deps.storage.newKey(deck.workspace_id, ext);
  await deps.storage.put(key, r.file);
  const sha = createHash("sha256").update(r.file).digest("hex");
  await deps.sql.begin(async (tx) => {
    const kind = ext === "pdf" ? "deck_pdf" : "deck_pptx";
    let [art] = await tx<{ id: string }[]>`select id from artifacts where target_id = ${deck.id} and kind = ${kind} and deleted_at is null for update`;
    if (!art) [art] = await tx<{ id: string }[]>`insert into artifacts (workspace_id, owner_id, kind, title, target_id) values (${deck.workspace_id}, ${deck.owner_id}, ${kind}, ${deck.title.slice(0, 200)}, ${deck.id}) returning id`;
    const [{ next }] = (await tx<{ next: number }[]>`select coalesce(max(version_no), 0) + 1 as next from artifact_versions where artifact_id = ${art!.id}`) as unknown as [{ next: number }];
    const [ver] = await tx<{ id: string }[]>`
      insert into artifact_versions (artifact_id, version_no, storage_key, mime, byte_size, sha256, checks, source_revision)
      values (${art!.id}, ${next}, ${key}, ${mime}, ${r.file.length}, ${sha}, ${tx.json(checks as never)}, ${exp.deck_revision}) returning id`;
    await tx`update exports set status = 'ready', artifact_version_id = ${ver!.id}, checks = ${tx.json(checks as never)}, error = null where id = ${exp.id}`;
  });
  await notify(deps, ctx, deck, "export", r.slideCount, ext);
  return { result: { exportId: exp.id, format: ext, slides: r.slideCount, bytes: r.file.length } };
}

// ───────────────────────── notifications ─────────────────────────

/**
 * Bot message when a long job finishes. Texts other than the existing
 * dictionary keys are plain Uzbek for now (listed for localisation).
 */
async function notify(deps: Deps, ctx: JobContext, deck: DeckRow, kind: "ready" | "plan" | "export", n = 0, format?: string) {
  if (!ctx.job.notify_chat_id) return;
  const [u] = await deps.sql<{ language: Lang }[]>`select language from users where id = ${ctx.job.user_id}`;
  const lang = u?.language ?? "uz";
  const title = escapeHtml(deck.title);
  const text =
    kind === "ready" ? `✅ «${title}» prezentatsiyasi tayyor: ${n} ta slayd. Koʻrib chiqing, kerak boʻlsa tahrirlang va PPTX/PDF yuklab oling.`
    : kind === "plan" ? `📝 «${title}» rejasi tayyor. Rejani koʻrib chiqing va slaydlarni yarating.`
    : `${translate(lang, "deck.exportReady")}: «${title}» (${(format ?? "").toUpperCase()}, ${n} ta slayd).`;
  const url = miniAppUrl(deps.cfg, `/decks/${deck.id}`);
  await enqueueMessage(deps.sql, {
    chatId: ctx.job.notify_chat_id,
    userId: ctx.job.user_id,
    method: "sendMessage",
    payload: { text, parse_mode: "HTML", ...(url ? { reply_markup: { inline_keyboard: [[{ text: translate(lang, "common.open"), web_app: { url } }]] } } : {}) },
    dedupeKey: `deck-${kind}:${ctx.job.id}`,
  });
}
