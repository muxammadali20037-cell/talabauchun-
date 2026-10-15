import { DeckSettings, SlideContent, type Bullet, type SlideEvidence, type SlideSourceRef } from "@talaba/shared";
import type { Sql, Tx } from "../db/index";
import { notFound } from "../lib/errors";
import { contentStems, coverage } from "../quiz/text";
import type { DraftRef, DraftSlide, SlideOrigin } from "./extractive";

/** Database access for decks/slides shared by the HTTP service and the background jobs. */

export type DeckRow = {
  id: string;
  workspace_id: string;
  owner_id: string;
  title: string;
  settings: DeckSettings;
  theme: "academic" | "data" | "creative";
  status: "draft" | "planning" | "plan_ready" | "generating" | "ready" | "failed";
  outline: unknown;
  source_document_ids: string[];
  revision: number;
  generation: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export type SlideRow = {
  id: string;
  deck_id: string;
  position: number;
  content: SlideContent;
  notes: string;
  revision: number;
  locked_by: string | null;
  lock_expires_at: Date | null;
  updated_by: string | null;
  updated_at: Date;
  deleted_at: Date | null;
  origin: SlideOrigin | Record<string, never>;
};

export async function getDeckRow(sql: Sql | Tx, deckId: string, forUpdate = false): Promise<DeckRow> {
  const [d] = forUpdate
    ? await sql<DeckRow[]>`select * from decks where id = ${deckId} and deleted_at is null for update`
    : await sql<DeckRow[]>`select * from decks where id = ${deckId} and deleted_at is null`;
  if (!d) throw notFound("deck");
  return d;
}

export async function liveSlides(sql: Sql | Tx, deckId: string): Promise<SlideRow[]> {
  return sql<SlideRow[]>`select * from slides where deck_id = ${deckId} and deleted_at is null order by position, id`;
}

export async function getSlideRow(sql: Sql | Tx, deckId: string, slideId: string, forUpdate = false): Promise<SlideRow> {
  if (!/^[0-9a-f-]{36}$/i.test(slideId)) throw notFound("slide");
  const [s] = forUpdate
    ? await sql<SlideRow[]>`select * from slides where id = ${slideId} and deck_id = ${deckId} for update`
    : await sql<SlideRow[]>`select * from slides where id = ${slideId} and deck_id = ${deckId}`;
  if (!s) throw notFound("slide");
  return s;
}

/** Stores evidence snapshots (quote + locator copied now) and returns their ids in order. */
export async function insertSourceRefs(tx: Tx, workspaceId: string, refs: DraftRef[]): Promise<string[]> {
  const ids: string[] = [];
  for (const r of refs) {
    const [row] = await tx<{ id: string }[]>`
      insert into source_references (workspace_id, document_id, document_version_id, document_title, locator, quote, verified, verification)
      values (${workspaceId}, ${r.docId}, ${r.versionId}, ${r.docTitle.slice(0, 300)}, ${tx.json(r.locator as never)}, ${r.quote.slice(0, 4000)}, true, ${r.verification})
      returning id`;
    ids.push(row!.id);
  }
  return ids;
}

/** Puts the stored evidence ids into the slide's sources (sources and refs are index-aligned). */
export function attachRefIds(content: SlideContent, ids: string[]): SlideContent {
  return { ...content, sources: (content.sources ?? []).map((s, i) => (ids[i] ? { ...s, sourceRefId: ids[i], verified: true } : { ...s, verified: false })) } as SlideContent;
}

export async function writeVersion(
  tx: Tx,
  v: { slideId: string; revision: number; position: number; content: SlideContent; notes: string; kind: "create" | "edit" | "regenerate" | "restore" | "reorder" | "delete"; userId: string | null; restoredFrom?: number | null },
) {
  await tx`
    insert into slide_versions (slide_id, revision, position, content, notes, change_kind, created_by, restored_from)
    values (${v.slideId}, ${v.revision}, ${v.position}, ${tx.json(v.content as never)}, ${v.notes}, ${v.kind}, ${v.userId}, ${v.restoredFrom ?? null})`;
}

/** Inserts one generated slide with its evidence and first version. */
export async function insertDraftSlide(tx: Tx, deck: Pick<DeckRow, "id" | "workspace_id">, position: number, d: DraftSlide, userId: string | null, kind: "create" = "create"): Promise<string> {
  const ids = await insertSourceRefs(tx, deck.workspace_id, d.refs);
  const content = SlideContent.parse(attachRefIds(d.content, ids));
  const [row] = await tx<{ id: string }[]>`
    insert into slides (deck_id, position, content, notes, revision, updated_by, origin)
    values (${deck.id}, ${position}, ${tx.json(content as never)}, ${d.notes}, 1, ${userId}, ${tx.json(d.origin as never)}) returning id`;
  await writeVersion(tx, { slideId: row!.id, revision: 1, position, content, notes: d.notes, kind, userId });
  return row!.id;
}

export async function bumpDeck(tx: Tx, deckId: string): Promise<number> {
  const [r] = await tx<{ revision: number }[]>`update decks set revision = revision + 1, updated_at = now() where id = ${deckId} returning revision`;
  return r!.revision;
}

const FACT_LAYOUTS = new Set(["bullets", "two_column", "definition", "table", "chart"]);

/**
 * Evidence state of a slide. A fact slide is "verified" only when every
 * statement points at a stored source whose quote was found in the material
 * (or whose values were copied from a source table); slides without sources
 * are never shown as verified.
 */
export function slideEvidence(c: SlideContent): SlideEvidence {
  if (!FACT_LAYOUTS.has(c.layout)) return "not_applicable";
  const sources = c.sources ?? [];
  const ok = (i: number) => !!sources[i]?.verified && !!sources[i]?.sourceRefId;
  if (!sources.length || !sources.some((_, i) => ok(i))) return "unverified";
  if (c.layout === "chart" && c.dataOrigin !== "source_table") return "unverified";
  const bullets = c.layout === "bullets" ? c.bullets : c.layout === "two_column" ? [...c.left.bullets, ...c.right.bullets] : null;
  if (bullets) {
    const each = bullets.map((b) => (b.ref ? ok(b.ref - 1) : sources.length === 1 && ok(0) && !c.aiWritten));
    return each.every(Boolean) ? "verified" : each.some(Boolean) ? "partial" : "unverified";
  }
  return sources.every((_, i) => ok(i)) ? "verified" : "partial";
}

function textsBySource(c: SlideContent): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const add = (i: number, t: string) => {
    if (!out.has(i)) out.set(i, []);
    out.get(i)!.push(t);
  };
  const single = (c.sources ?? []).length === 1;
  if (c.layout === "bullets" || c.layout === "two_column") {
    const bullets = c.layout === "bullets" ? c.bullets : [...c.left.bullets, ...c.right.bullets];
    for (const b of bullets) if (b.ref) add(b.ref - 1, b.text);
      else if (single) add(0, b.text);
  } else if (c.layout === "definition") {
    (c.sources ?? []).forEach((_, i) => add(i, c.definition));
  }
  return out;
}

/**
 * Server-side normalisation of edited content: unknown or foreign evidence ids
 * are dropped, `verified` is recomputed (an edit that no longer matches its
 * quote loses the verified mark), and chart numbers that differ from the
 * source table stop claiming to come from it.
 */
export async function sanitizeContent(sql: Sql | Tx, workspaceId: string, raw: SlideContent, previous: SlideContent | null): Promise<SlideContent> {
  const content = SlideContent.parse(raw);
  const ids = (content.sources ?? []).map((s) => s.sourceRefId).filter((x): x is string => !!x);
  const rows = ids.length
    ? await sql<{ id: string; quote: string; verified: boolean; verification: string }[]>`select id, quote, verified, verification from source_references where id in ${sql(ids)} and workspace_id = ${workspaceId}`
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const texts = textsBySource(content);
  let sources: SlideSourceRef[] = (content.sources ?? []).map((s, i): SlideSourceRef => {
    const ref = s.sourceRefId ? byId.get(s.sourceRefId) : undefined;
    if (!ref) return { label: s.label, verified: false };
    let verified = ref.verified;
    if (verified && ref.verification !== "table_value") {
      const quoteStems = contentStems(ref.quote);
      for (const t of texts.get(i) ?? []) if (coverage(contentStems(t), quoteStems) < 0.6) verified = false;
    }
    return { label: s.label, sourceRefId: ref.id, verified };
  });
  let out = { ...content, sources } as SlideContent;
  if (out.layout === "bullets") out = { ...out, bullets: out.bullets.map((b) => (b.ref && b.ref > sources.length ? { ...b, ref: undefined } : b)) };
  if (out.layout === "two_column") {
    const fix = (bs: Bullet[]) => bs.map((b) => (b.ref && b.ref > sources.length ? { ...b, ref: undefined } : b));
    out = { ...out, left: { ...out.left, bullets: fix(out.left.bullets) }, right: { ...out.right, bullets: fix(out.right.bullets) } };
  }
  if (out.layout === "chart" || out.layout === "table") {
    const prevSame = previous && previous.layout === out.layout ? previous : null;
    const dataSig = (c: SlideContent) => (c.layout === "chart" ? JSON.stringify([c.categories, c.series.map((s) => s.values)]) : c.layout === "table" ? JSON.stringify([c.columns, c.rows]) : "");
    const unchanged = !!prevSame && dataSig(prevSame) === dataSig(out);
    const tableBacked = sources.some((s) => s.verified && s.sourceRefId && byId.get(s.sourceRefId)?.verification === "table_value");
    if (!unchanged) {
      // numbers typed or changed by a person are not the source table's numbers any more
      sources = sources.map((s) => ({ ...s, verified: false }));
      out = { ...out, sources } as SlideContent;
      if (out.layout === "chart" && out.dataOrigin === "source_table") out = { ...out, dataOrigin: "user_input" };
    } else if (out.layout === "chart" && out.dataOrigin === "source_table" && !tableBacked) out = { ...out, dataOrigin: "user_input" };
    // an "example data" label from the source cannot be removed while the data is unchanged
    if (unchanged && prevSame && "isExample" in prevSame && prevSame.isExample) out = { ...out, isExample: true } as SlideContent;
  }
  return SlideContent.parse(out);
}

export function parseSettings(raw: unknown): DeckSettings {
  return DeckSettings.parse(raw ?? {});
}
