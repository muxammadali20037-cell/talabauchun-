import { effectiveLimits } from "../billing/plans";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreateDeckRequest, DeckOutlineItem, DeckSettings, ExportFormat, SlideContent, SlideEdit, ThemeId } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import type { Tx } from "../db/index";
import { requireObjectRole, requireWorkspaceRole } from "../access/policy";
import { estimateCredits, getBalance, loadPricing } from "../billing/credits";
import { enqueueJob, jobView, type JobRow } from "../jobs/queue";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { createQuiz } from "../quiz/service";
import type { ExportInput, GenerateInput, RegenerateInput } from "./generate";
import { layoutDeck } from "./layout";
import { bumpDeck, getDeckRow, getSlideRow, liveSlides, parseSettings, sanitizeContent, slideEvidence, writeVersion, type DeckRow, type SlideRow } from "./store";
import { getTheme } from "./themes";
import { SLIDE_H, SLIDE_W } from "@talaba/shared";

/**
 * Presentation Studio service. Every function checks the caller's role on the
 * deck's workspace (viewer: read/export, editor: change); decks of other
 * workspaces are reported as 404. Edits use optimistic concurrency on the
 * slide revision, so one student's change never silently overwrites another's.
 */

const LOCK_SEC = 120;
const MAX_SLIDES = 60;
const AI_LAYOUTS = new Set(["bullets", "two_column", "definition"]);
const uuid = z.string().uuid();

function pageArgs(o: { limit?: number; cursor?: string | null }) {
  return { limit: Math.min(Math.max(o.limit ?? 20, 1), 100), cursor: o.cursor ?? null };
}

// ───────────────────────── create / list / read ─────────────────────────

export async function estimateDeck(deps: Deps, user: UserRow, body: { slideCount?: number; useAi?: boolean; planOnly?: boolean }) {
  const pricing = await loadPricing(deps.sql);
  const ai = body.useAi !== false && !!deps.ai;
  const slides = DeckSettings.shape.slideCount.parse(body.slideCount ?? 12);
  const credits = body.planOnly ? (ai ? 1 : 0) : estimateCredits(pricing, { kind: "deck", slides, ai });
  return {
    credits, ai, aiAvailable: !!deps.ai, balance: await getBalance(deps.sql, user.id),
    regenerateCredits: estimateCredits(pricing, { kind: "slide_regen", ai }), exportCredits: estimateCredits(pricing, { kind: "export" }),
  };
}

export async function createDeck(deps: Deps, user: UserRow, raw: unknown, opts: { notifyChatId?: string | number | null } = {}) {
  const rawSettings = (raw && typeof raw === "object" && "settings" in raw ? (raw as { settings?: Record<string, unknown> }).settings : undefined) ?? {};
  const req = CreateDeckRequest.parse({ ...(raw as object), settings: { language: user.language, ...rawSettings } });
  const workspaceId = req.workspaceId ?? user.personal_workspace_id;
  await requireWorkspaceRole(deps.sql, user, workspaceId, "editor");
  const docIds = [...new Set(req.documentIds)];
  for (const id of docIds) await requireObjectRole(deps.sql, user, "document", id, "viewer");
  for (const r of req.pageRanges ?? []) if (!docIds.includes(r.documentId) || r.to < r.from) throw badRequest("invalid_page_range");
  const useAi = req.useAi !== false && !!deps.ai;
  if (!useAi && !docIds.length) throw badRequest("deck_needs_source");
  const settings = req.settings;
  const maxSlides = await planSlideLimit(deps, user.id);
  if (settings.slideCount > maxSlides) throw badRequest("deck_too_many_slides", { max: maxSlides });
  const pricing = await loadPricing(deps.sql);
  const credits = req.planOnly ? (useAi ? 1 : 0) : estimateCredits(pricing, { kind: "deck", slides: settings.slideCount, ai: useAi });
  const title = (req.title?.trim() || settings.topic.trim()).slice(0, 200);
  const key = `deck:${user.id}:${req.idempotencyKey}`;
  return deps.sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; target_id: string }[]>`select id, target_id from generation_jobs where idempotency_key = ${key}`;
    if (existing) return { deckId: existing.target_id, jobId: existing.id, credits, duplicate: true };
    const [deck] = await tx<{ id: string }[]>`
      insert into decks (workspace_id, owner_id, title, settings, theme, status, source_document_ids, generation)
      values (${workspaceId}, ${user.id}, ${title}, ${tx.json(settings as never)}, ${settings.theme}, ${req.planOnly ? "planning" : "generating"}, ${docIds},
        ${tx.json({ scope: { pageRanges: req.pageRanges, sectionIds: req.sectionIds }, mode: useAi ? "ai" : "extractive" } as never)})
      returning id`;
    const input: GenerateInput = { deckId: deck!.id, request: req, useAi, planOnly: req.planOnly };
    const { job } = await enqueueJob(tx, {
      kind: "generate_deck", userId: user.id, workspaceId, targetId: deck!.id, idempotencyKey: key,
      stages: req.planOnly ? ["generating"] : ["generating", "validating"], input: input as never, credits, notifyChatId: opts.notifyChatId ?? null,
    });
    return { deckId: deck!.id, jobId: job.id, credits, duplicate: false };
  });
}

/** Slide limit in force for the user (their entitlement's snapshot, else the free plan). */
async function planSlideLimit(deps: Deps, userId: string): Promise<number> {
  return (await effectiveLimits(deps.sql, userId)).maxSlides;
}

/** Generates the slides from a reviewed (possibly edited) outline of a plan_ready deck. */
export async function generateFromOutline(deps: Deps, user: UserRow, deckId: string, raw: unknown, opts: { notifyChatId?: string | number | null } = {}) {
  const body = z.object({ outline: z.array(DeckOutlineItem).min(1).max(40).optional(), idempotencyKey: z.string().min(8).max(100) }).parse(raw);
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  const pricing = await loadPricing(deps.sql);
  return deps.sql.begin(async (tx) => {
    const deck = await getDeckRow(tx, deckId, true);
    const key = `deckgen:${deckId}:${body.idempotencyKey}`;
    const [existing] = await tx<{ id: string }[]>`select id from generation_jobs where idempotency_key = ${key}`;
    if (existing) return { deckId, jobId: existing.id, duplicate: true };
    if (deck.status !== "plan_ready") throw conflict("deck_not_plan_ready", { status: deck.status });
    const outline = body.outline ?? DeckOutlineItem.array().parse(deck.outline ?? []);
    const maxSlides = await planSlideLimit(deps, user.id);
    if (outline.length > maxSlides) throw badRequest("deck_too_many_slides", { max: maxSlides });
    const settings = parseSettings(deck.settings);
    const useAi = deck.generation?.mode === "ai" && !!deps.ai;
    const credits = estimateCredits(pricing, { kind: "deck", slides: outline.length, ai: useAi });
    const scope = (deck.generation?.scope ?? {}) as { pageRanges?: CreateDeckRequest["pageRanges"]; sectionIds?: string[] };
    const request = CreateDeckRequest.parse({ settings, documentIds: deck.source_document_ids, ...scope, idempotencyKey: body.idempotencyKey, title: deck.title });
    await tx`update decks set status = 'generating', outline = ${tx.json(outline as never)}, updated_at = now() where id = ${deckId}`;
    const input: GenerateInput = { deckId, request, useAi, planOnly: false, fromOutline: outline };
    const { job } = await enqueueJob(tx, { kind: "generate_deck", userId: user.id, workspaceId: deck.workspace_id, targetId: deckId, idempotencyKey: key, stages: ["generating", "validating"], input: input as never, credits, notifyChatId: opts.notifyChatId ?? null });
    return { deckId, jobId: job.id, credits, duplicate: false };
  });
}

export async function listDecks(deps: Deps, user: UserRow, o: { limit?: number; cursor?: string | null; workspaceId?: string } = {}) {
  const { limit, cursor } = pageArgs(o);
  const rows = await deps.sql<{ id: string; title: string; theme: string; status: string; updated_at: Date; created_at: Date; workspace_id: string; slides: number; revision: number }[]>`
    select d.id, d.title, d.theme, d.status, d.updated_at, d.created_at, d.workspace_id, d.revision,
      (select count(*)::int from slides s where s.deck_id = d.id and s.deleted_at is null) as slides
    from decks d
    where d.deleted_at is null and d.workspace_id in (select workspace_id from memberships where user_id = ${user.id})
      and (${o.workspaceId ?? null}::uuid is null or d.workspace_id = ${o.workspaceId ?? null}::uuid)
      and (${cursor}::timestamptz is null or d.updated_at < ${cursor}::timestamptz)
    order by d.updated_at desc limit ${limit + 1}`;
  const items = rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, theme: r.theme, status: r.status, slides: r.slides, revision: r.revision, workspaceId: r.workspace_id, createdAt: r.created_at, updatedAt: r.updated_at }));
  return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.updated_at.toISOString() : null };
}

type Lock = { lockedBy: string; lockedByName: string | null; byMe: boolean; expiresAt: Date } | null;

function lockOf(s: SlideRow, userId: string, names: Map<string, string>): Lock {
  if (!s.locked_by || !s.lock_expires_at || s.lock_expires_at.getTime() <= Date.now()) return null;
  return { lockedBy: s.locked_by, lockedByName: names.get(s.locked_by) ?? null, byMe: s.locked_by === userId, expiresAt: s.lock_expires_at };
}

function slideView(s: SlideRow, userId: string, names: Map<string, string>) {
  return {
    id: s.id, position: s.position, revision: s.revision, content: s.content, notes: s.notes, updatedAt: s.updated_at, updatedBy: s.updated_by,
    lock: lockOf(s, userId, names), evidence: slideEvidence(s.content), aiWritten: !!s.content.aiWritten,
    origin: s.origin && "kind" in s.origin ? { kind: s.origin.kind, mode: s.origin.mode } : null,
  };
}

/** Lays the deck out exactly as it will be exported (continuation slides included). */
export function previewOf(deck: Pick<DeckRow, "theme" | "settings">, slides: Pick<SlideRow, "id" | "content" | "notes">[]) {
  const st = parseSettings(deck.settings);
  return layoutDeck(slides.map((s) => ({ id: s.id, content: s.content, notes: s.notes })), getTheme(deck.theme), { language: st.language });
}

export async function getDeck(deps: Deps, user: UserRow, deckId: string) {
  const { role } = await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  const deck = await getDeckRow(deps.sql, deckId);
  const slides = await liveSlides(deps.sql, deckId);
  const lockers = [...new Set(slides.map((s) => s.locked_by).filter((x): x is string => !!x))];
  const names = new Map(lockers.length ? (await deps.sql<{ id: string; first_name: string }[]>`select id, first_name from users where id in ${deps.sql(lockers)}`).map((u) => [u.id, u.first_name]) : []);
  const [gen] = await deps.sql<JobRow[]>`select * from generation_jobs where target_id = ${deckId} and kind = 'generate_deck' order by created_at desc limit 1`;
  const regen = await deps.sql<{ id: string; status: string; input: { slideId?: string }; error_code: string | null }[]>`
    select id, status, input, error_code from generation_jobs where target_id = ${deckId} and kind = 'regenerate_slide'
      and (status not in ('completed','failed','cancelled') or finished_at > now() - interval '10 minutes') order by created_at desc limit 50`;
  const preview = previewOf(deck, slides);
  const renderIndexes = new Map<string, number[]>();
  for (const p of preview) renderIndexes.set(p.slideId, [...(renderIndexes.get(p.slideId) ?? []), p.renderIndex]);
  const settings = parseSettings(deck.settings);
  const generation = deck.generation ?? {};
  return {
    deck: {
      id: deck.id, title: deck.title, theme: deck.theme, status: deck.status, settings, revision: deck.revision, role, workspaceId: deck.workspace_id,
      sourceDocumentIds: deck.source_document_ids, outline: deck.outline ?? null, createdAt: deck.created_at, updatedAt: deck.updated_at,
      generation: {
        mode: (generation.mode as "ai" | "extractive" | undefined) ?? null,
        warnings: (generation.warnings as string[] | undefined) ?? [],
        note: (generation.note as string | null | undefined) ?? null,
        requested: (generation.requested as number | undefined) ?? null,
        produced: (generation.produced as number | undefined) ?? null,
        errorCode: (generation.errorCode as string | undefined) ?? null,
      },
    },
    job: gen ? jobView(gen) : null,
    regenerations: regen.map((j) => ({ jobId: j.id, slideId: j.input.slideId ?? null, status: j.status, errorCode: j.error_code })),
    slides: slides.map((s) => ({ ...slideView(s, user.id, names), renderIndexes: renderIndexes.get(s.id) ?? [] })),
    preview: { width: SLIDE_W, height: SLIDE_H, slides: preview },
    warnings: [...new Set([...(generation.warnings as string[] | undefined ?? []), ...preview.flatMap((p) => p.warnings.map((w) => `${w}@${p.renderIndex + 1}`))])],
  };
}

export async function updateDeck(deps: Deps, user: UserRow, deckId: string, raw: unknown) {
  const body = z
    .object({
      title: z.string().min(1).max(200).optional(),
      theme: ThemeId.optional(),
      settings: DeckSettings.partial().omit({ theme: true }).optional(),
      revision: z.number().int().optional(),
    })
    .parse(raw);
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    const deck = await getDeckRow(tx, deckId, true);
    if (body.revision != null && body.revision !== deck.revision) throw conflict("deck_conflict", { revision: deck.revision });
    const settings = DeckSettings.parse({ ...parseSettings(deck.settings), ...(body.settings ?? {}), ...(body.theme ? { theme: body.theme } : {}) });
    // switching the theme only changes how the same content is laid out: no AI, no new content
    await tx`update decks set title = ${body.title?.trim() ?? deck.title}, theme = ${settings.theme}, settings = ${tx.json(settings as never)}, updated_at = now() where id = ${deckId}`;
    const revision = await bumpDeck(tx, deckId);
    return { id: deckId, title: body.title?.trim() ?? deck.title, theme: settings.theme, settings, revision };
  });
}

/** Only the deck's author or the workspace owner may delete a whole deck (editors edit slides). */
export async function deleteDeck(deps: Deps, user: UserRow, deckId: string) {
  const { role, ownerId } = await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  if (role !== "owner" && ownerId !== user.id) throw new AppError("forbidden", 403, "only the author can delete the deck");
  await deps.sql`update decks set deleted_at = now(), updated_at = now() where id = ${deckId}`;
}

// ───────────────────────── slide editing ─────────────────────────

async function editableSlide(tx: Tx, deckId: string, slideId: string, userId: string): Promise<SlideRow> {
  const s = await getSlideRow(tx, deckId, slideId, true);
  if (s.deleted_at) throw notFound("slide");
  if (s.locked_by && s.locked_by !== userId && s.lock_expires_at && s.lock_expires_at.getTime() > Date.now()) {
    throw new AppError("slide_locked", 409, "slide is being edited", { lockedBy: s.locked_by, expiresAt: s.lock_expires_at.toISOString() });
  }
  return s;
}

async function slideResult(tx: Tx, deckId: string, slideId: string, userId: string) {
  const deck = await getDeckRow(tx, deckId);
  const slides = await liveSlides(tx, deckId);
  const s = slides.find((x) => x.id === slideId) ?? (await getSlideRow(tx, deckId, slideId));
  const preview = previewOf(deck, slides).filter((p) => p.slideId === slideId);
  return { slide: slideView(s, userId, new Map()), preview, deckRevision: deck.revision };
}

export async function updateSlide(deps: Deps, user: UserRow, deckId: string, slideId: string, raw: unknown) {
  const edit = SlideEdit.parse(raw);
  const { workspaceId } = await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    const s = await editableSlide(tx, deckId, slideId, user.id);
    if (s.revision !== edit.revision) {
      throw new AppError("slide_conflict", 409, "slide changed since it was loaded", { currentRevision: s.revision, current: { content: s.content, notes: s.notes, updatedBy: s.updated_by, updatedAt: s.updated_at } });
    }
    const content = await sanitizeContent(tx, workspaceId, edit.content, s.content);
    const notes = edit.notes ?? s.notes;
    const next = s.revision + 1;
    await tx`update slides set content = ${tx.json(content as never)}, notes = ${notes}, revision = ${next}, updated_by = ${user.id}, updated_at = now() where id = ${slideId}`;
    await writeVersion(tx, { slideId, revision: next, position: s.position, content, notes, kind: "edit", userId: user.id });
    await bumpDeck(tx, deckId);
    return slideResult(tx, deckId, slideId, user.id);
  });
}

export async function lockSlide(deps: Deps, user: UserRow, deckId: string, slideId: string) {
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    await editableSlide(tx, deckId, slideId, user.id);
    const [r] = await tx<{ lock_expires_at: Date }[]>`
      update slides set locked_by = ${user.id}, lock_expires_at = now() + make_interval(secs => ${LOCK_SEC}) where id = ${slideId} returning lock_expires_at`;
    return { locked: true, expiresAt: r!.lock_expires_at };
  });
}

export async function unlockSlide(deps: Deps, user: UserRow, deckId: string, slideId: string) {
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  await getSlideRow(deps.sql, deckId, slideId);
  await deps.sql`update slides set locked_by = null, lock_expires_at = null where id = ${slideId} and deck_id = ${deckId} and locked_by = ${user.id}`;
  return { locked: false };
}

export async function regenerateSlide(deps: Deps, user: UserRow, deckId: string, slideId: string, raw: unknown, opts: { notifyChatId?: string | number | null } = {}) {
  const body = z.object({ instruction: z.string().max(500).optional(), revision: z.number().int().optional(), useAi: z.boolean().optional(), idempotencyKey: z.string().min(4).max(100).optional() }).parse(raw ?? {});
  const { workspaceId } = await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  const pricing = await loadPricing(deps.sql);
  return deps.sql.begin(async (tx) => {
    const s = await editableSlide(tx, deckId, slideId, user.id);
    if (body.revision != null && body.revision !== s.revision) throw conflict("slide_conflict", { currentRevision: s.revision });
    const useAi = body.useAi !== false && !!deps.ai && AI_LAYOUTS.has(s.content.layout);
    // one slide costs the single-slide price, never the full deck price
    const credits = estimateCredits(pricing, { kind: "slide_regen", ai: useAi });
    let key = `regen:${slideId}:${s.revision}:${body.idempotencyKey ?? "default"}`;
    const [prev] = await tx<{ id: string; status: string }[]>`select id, status from generation_jobs where idempotency_key = ${key}`;
    if (prev && !["failed", "cancelled"].includes(prev.status)) return { jobId: prev.id, credits, duplicate: true };
    if (prev) key = `${key}:${randomUUID().slice(0, 8)}`;
    const input: RegenerateInput = { deckId, slideId, baseRevision: s.revision, instruction: body.instruction?.trim() || null, useAi };
    const { job } = await enqueueJob(tx, { kind: "regenerate_slide", userId: user.id, workspaceId, targetId: deckId, idempotencyKey: key, stages: ["generating", "validating"], input: input as never, credits, notifyChatId: opts.notifyChatId ?? null });
    return { jobId: job.id, credits, duplicate: false };
  });
}

export async function reorderSlides(deps: Deps, user: UserRow, deckId: string, raw: unknown) {
  const body = z.object({ slideIds: z.array(uuid).min(1).max(MAX_SLIDES), revision: z.number().int().optional() }).parse(raw);
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    const deck = await getDeckRow(tx, deckId, true);
    if (body.revision != null && body.revision !== deck.revision) throw conflict("deck_conflict", { revision: deck.revision });
    const live = await liveSlides(tx, deckId);
    const ids = new Set(live.map((s) => s.id));
    if (body.slideIds.length !== live.length || new Set(body.slideIds).size !== live.length || !body.slideIds.every((id) => ids.has(id))) {
      throw badRequest("reorder_mismatch", { expected: live.length });
    }
    for (let i = 0; i < body.slideIds.length; i++) await tx`update slides set position = ${i} where id = ${body.slideIds[i]!}`;
    const revision = await bumpDeck(tx, deckId);
    return { ok: true, revision };
  });
}

export async function addSlide(deps: Deps, user: UserRow, deckId: string, raw: unknown) {
  const body = z.object({ content: SlideContent, notes: z.string().max(8000).optional(), afterSlideId: uuid.nullable().optional() }).parse(raw);
  const { workspaceId } = await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    await getDeckRow(tx, deckId, true);
    const live = await liveSlides(tx, deckId);
    if (live.length >= MAX_SLIDES) throw badRequest("deck_too_many_slides", { max: MAX_SLIDES });
    let position = live.length ? live[live.length - 1]!.position + 1 : 0;
    if (body.afterSlideId !== undefined) {
      const after = body.afterSlideId ? live.find((s) => s.id === body.afterSlideId) : null;
      if (body.afterSlideId && !after) throw notFound("slide");
      position = after ? after.position + 1 : 0;
      await tx`update slides set position = position + 1 where deck_id = ${deckId} and deleted_at is null and position >= ${position}`;
    }
    const content = await sanitizeContent(tx, workspaceId, body.content, null);
    const notes = body.notes ?? "";
    const [row] = await tx<{ id: string }[]>`
      insert into slides (deck_id, position, content, notes, revision, updated_by, origin)
      values (${deckId}, ${position}, ${tx.json(content as never)}, ${notes}, 1, ${user.id}, ${tx.json({ kind: "manual", mode: "user" } as never)}) returning id`;
    await writeVersion(tx, { slideId: row!.id, revision: 1, position, content, notes, kind: "create", userId: user.id });
    await bumpDeck(tx, deckId);
    return slideResult(tx, deckId, row!.id, user.id);
  });
}

export async function deleteSlide(deps: Deps, user: UserRow, deckId: string, slideId: string) {
  await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    const s = await editableSlide(tx, deckId, slideId, user.id);
    const next = s.revision + 1;
    await tx`update slides set deleted_at = now(), revision = ${next}, locked_by = null, lock_expires_at = null, updated_by = ${user.id}, updated_at = now() where id = ${slideId}`;
    await writeVersion(tx, { slideId, revision: next, position: s.position, content: s.content, notes: s.notes, kind: "delete", userId: user.id });
    const revision = await bumpDeck(tx, deckId);
    return { ok: true, revision };
  });
}

/**
 * Undo: restores the state before the slide's latest change as a new revision
 * (history is never rewritten). Repeated undo walks further back; undo on a
 * deleted slide brings it back.
 */
export async function undoSlide(deps: Deps, user: UserRow, deckId: string, slideId: string) {
  const { workspaceId } = await requireObjectRole(deps.sql, user, "deck", deckId, "editor");
  return deps.sql.begin(async (tx) => {
    const s = await getSlideRow(tx, deckId, slideId, true);
    if (s.locked_by && s.locked_by !== user.id && s.lock_expires_at && s.lock_expires_at.getTime() > Date.now()) throw new AppError("slide_locked", 409);
    const next = s.revision + 1;
    if (s.deleted_at) {
      await tx`update slides set deleted_at = null, revision = ${next}, updated_by = ${user.id}, updated_at = now() where id = ${slideId}`;
      await writeVersion(tx, { slideId, revision: next, position: s.position, content: s.content, notes: s.notes, kind: "restore", userId: user.id, restoredFrom: s.revision - 1 });
      await bumpDeck(tx, deckId);
      return slideResult(tx, deckId, slideId, user.id);
    }
    const [cur] = await tx<{ revision: number; change_kind: string; restored_from: number | null }[]>`
      select revision, change_kind, restored_from from slide_versions where slide_id = ${slideId} and revision = ${s.revision}`;
    const base = cur?.change_kind === "restore" && cur.restored_from != null ? cur.restored_from : s.revision;
    const target = base - 1;
    if (target < 1) throw conflict("nothing_to_undo");
    const [v] = await tx<{ content: SlideContent; notes: string }[]>`select content, notes from slide_versions where slide_id = ${slideId} and revision = ${target}`;
    if (!v) throw conflict("nothing_to_undo");
    const content = await sanitizeContent(tx, workspaceId, v.content, v.content);
    await tx`update slides set content = ${tx.json(content as never)}, notes = ${v.notes}, revision = ${next}, updated_by = ${user.id}, updated_at = now() where id = ${slideId}`;
    await writeVersion(tx, { slideId, revision: next, position: s.position, content, notes: v.notes, kind: "restore", userId: user.id, restoredFrom: target });
    await bumpDeck(tx, deckId);
    return slideResult(tx, deckId, slideId, user.id);
  });
}

export async function slideHistory(deps: Deps, user: UserRow, deckId: string, slideId: string, o: { limit?: number; cursor?: string | null } = {}) {
  await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  await getSlideRow(deps.sql, deckId, slideId);
  const { limit, cursor } = pageArgs(o);
  const before = cursor && /^\d+$/.test(cursor) ? Number(cursor) : null;
  const rows = await deps.sql<{ revision: number; change_kind: string; restored_from: number | null; created_at: Date; created_by: string | null; author: string | null; content: SlideContent; notes: string }[]>`
    select v.revision, v.change_kind, v.restored_from, v.created_at, v.created_by, u.first_name as author, v.content, v.notes
    from slide_versions v left join users u on u.id = v.created_by
    where v.slide_id = ${slideId} and (${before}::int is null or v.revision < ${before}::int)
    order by v.revision desc limit ${limit + 1}`;
  const items = rows.slice(0, limit).map((r) => ({ revision: r.revision, changeKind: r.change_kind, restoredFrom: r.restored_from, createdAt: r.created_at, createdBy: r.created_by, author: r.author, content: r.content, notes: r.notes }));
  return { items, nextCursor: rows.length > limit ? String(items[items.length - 1]!.revision) : null };
}

// ───────────────────────── exports ─────────────────────────

export async function createExport(deps: Deps, user: UserRow, deckId: string, raw: unknown, opts: { notifyChatId?: string | number | null } = {}) {
  const body = z.object({ format: ExportFormat, idempotencyKey: z.string().min(4).max(100).optional() }).parse(raw);
  // viewers may export: exporting reads the deck, it does not change it
  await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  const pricing = await loadPricing(deps.sql);
  return deps.sql.begin(async (tx) => {
    const deck = await getDeckRow(tx, deckId);
    if (deck.status !== "ready") throw conflict("deck_not_ready", { status: deck.status });
    const [same] = await tx<{ id: string; status: string; job_id: string | null }[]>`
      select id, status, job_id from exports where deck_id = ${deckId} and format = ${body.format} and deck_revision = ${deck.revision}
        and status in ('queued','rendering','ready') order by created_at desc limit 1`;
    if (same) return { exportId: same.id, jobId: same.job_id, status: same.status, duplicate: true };
    const exportId = randomUUID();
    const input: ExportInput = { deckId, exportId, format: body.format };
    const { job } = await enqueueJob(tx, {
      kind: "export_deck", userId: user.id, workspaceId: deck.workspace_id, targetId: deckId, idempotencyKey: `export:${exportId}`,
      stages: ["rendering", "validating"], input: input as never, credits: estimateCredits(pricing, { kind: "export" }), notifyChatId: opts.notifyChatId ?? null, maxAttempts: 2,
    });
    await tx`insert into exports (id, deck_id, deck_revision, format, status, job_id) values (${exportId}, ${deckId}, ${deck.revision}, ${body.format}, 'queued', ${job.id})`;
    return { exportId, jobId: job.id, status: "queued", duplicate: false };
  });
}

export function downloadName(title: string, format: string) {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "taqdimot";
  return `${base}.${format}`;
}

export async function listExports(deps: Deps, user: UserRow, deckId: string, o: { limit?: number; cursor?: string | null } = {}) {
  await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  const deck = await getDeckRow(deps.sql, deckId);
  const { limit, cursor } = pageArgs(o);
  const rows = await deps.sql<{ id: string; format: string; status: string; deck_revision: number; checks: Record<string, unknown>; error: string | null; created_at: Date; storage_key: string | null; byte_size: string | null; job_status: string | null; job_error: string | null }[]>`
    select e.id, e.format, e.status, e.deck_revision, e.checks, e.error, e.created_at, av.storage_key, av.byte_size::text, j.status as job_status, j.error_code as job_error
    from exports e left join artifact_versions av on av.id = e.artifact_version_id left join generation_jobs j on j.id = e.job_id
    where e.deck_id = ${deckId} and (${cursor}::timestamptz is null or e.created_at < ${cursor}::timestamptz)
    order by e.created_at desc limit ${limit + 1}`;
  const items = rows.slice(0, limit).map((r) => {
    // a job that died without updating the row still shows as failed
    const status = r.status !== "ready" && (r.job_status === "failed" || r.job_status === "cancelled") ? "failed" : r.status;
    let download: { url: string; filename: string; expiresAt: string } | null = null;
    if (status === "ready" && r.storage_key) {
      const filename = downloadName(deck.title, r.format);
      const { exp, sig } = deps.storage.sign(r.storage_key, filename, 300);
      download = { url: `/files/${r.storage_key}?name=${encodeURIComponent(filename)}&exp=${exp}&sig=${sig}`, filename, expiresAt: new Date(exp * 1000).toISOString() };
    }
    const checks = r.checks ?? {};
    return {
      id: r.id, format: r.format, status, deckRevision: r.deck_revision, current: r.deck_revision === deck.revision, createdAt: r.created_at,
      error: r.error ?? (status === "failed" ? r.job_error : null), bytes: r.byte_size ? Number(r.byte_size) : null,
      checks: { ok: checks.ok ?? null, slideCount: checks.slideCount ?? null, items: checks.checks ?? [], thumbnails: Array.isArray(checks.thumbnails) ? (checks.thumbnails as string[]).length : 0 },
      download,
    };
  });
  return { items, nextCursor: rows.length > limit ? rows[limit - 1]!.created_at.toISOString() : null };
}

/** PNG render of one exported page (thumbnails), after the same authorization as the deck. */
export async function exportThumbnail(deps: Deps, user: UserRow, deckId: string, exportId: string, page: number): Promise<Buffer> {
  await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  const [e] = await deps.sql<{ checks: { thumbnails?: string[] } }[]>`select checks from exports where id = ${exportId} and deck_id = ${deckId}`;
  const key = e?.checks?.thumbnails?.[page - 1];
  if (!key || !(await deps.storage.exists(key))) throw notFound("thumbnail");
  return deps.storage.get(key);
}

// ───────────────────────── extras ─────────────────────────

/** "Shu materialdan quiz": a draft quiz from the deck's own source documents. */
export async function quizFromDeck(deps: Deps, user: UserRow, deckId: string, raw: unknown, opts: { notifyChatId?: string | number | null } = {}) {
  const body = z.object({ count: z.number().int().min(1).max(30).optional(), useAi: z.boolean().optional(), idempotencyKey: z.string().min(8).max(100) }).parse(raw);
  const { role, workspaceId } = await requireObjectRole(deps.sql, user, "deck", deckId, "viewer");
  const deck = await getDeckRow(deps.sql, deckId);
  if (!deck.source_document_ids.length) throw conflict("deck_has_no_sources");
  const st = parseSettings(deck.settings);
  const scope = (deck.generation?.scope ?? {}) as { pageRanges?: { documentId: string; from: number; to: number }[]; sectionIds?: string[] };
  return createQuiz(
    deps,
    user,
    {
      method: "from_source",
      title: `${deck.title} — quiz`.slice(0, 200),
      documentIds: deck.source_document_ids,
      ...(scope.pageRanges?.length ? { pageRanges: scope.pageRanges } : {}),
      ...(scope.sectionIds?.length ? { sectionIds: scope.sectionIds } : {}),
      settings: { count: body.count ?? 10, language: st.language, topic: st.topic, ...(st.subject ? { subject: st.subject } : {}) },
      ...(body.useAi === false ? { useAi: false } : {}),
      idempotencyKey: `deckquiz:${deckId.slice(0, 8)}:${body.idempotencyKey}`.slice(0, 100),
    },
    { notifyChatId: opts.notifyChatId, workspaceId: role === "viewer" ? user.personal_workspace_id : workspaceId },
  );
}
