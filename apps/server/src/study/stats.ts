import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole, requireWorkspaceRole } from "../access/policy";
import { AppError, notFound } from "../lib/errors";
import { shuffle } from "../lib/crypto";
import { insertCandidate } from "../quiz/store";
import { deterministicChecks, statusFromChecks, type Candidate } from "../quiz/validate";

type Table = { sheet: string; columns: string[]; rows: (string | number | null)[][]; truncated: boolean };
const EXAMPLE_RE = /(namuna|o[ʻ'‘]?quv misoli|haqiqiy statistika emas|example|sample|пример|не реальн)/iu;

export async function documentTables(deps: Deps, user: UserRow, documentId: string): Promise<Table[]> {
  await requireObjectRole(deps.sql, user, "document", documentId, "viewer");
  const [v] = await deps.sql<{ metadata: { tables?: Table[] } }[]>`select v.metadata from documents d join document_versions v on v.id = d.current_version_id where d.id = ${documentId}`;
  return v?.metadata.tables ?? [];
}

export const FactsInput = z.object({
  documentId: z.string().uuid(),
  sheet: z.string(),
  labelColumn: z.number().int().min(0),
  valueColumn: z.number().int().min(0),
  indicator: z.string().min(1).max(300),
  unit: z.string().min(1).max(60),
  geography: z.string().max(120).optional(),
  definition: z.string().max(1000).optional(),
  publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sourceUrl: z.string().url().optional(),
  sampleInfo: z.string().max(500).optional(),
  isExample: z.boolean().optional(),
});

/**
 * Turns a user-provided table column into statistical facts. Each value is
 * copied exactly from a cell (row and column recorded) — nothing is estimated
 * or recalled from memory. Rows marked as sample/example data are flagged.
 */
export async function createFactsFromTable(deps: Deps, user: UserRow, raw: unknown) {
  const p = FactsInput.parse(raw);
  const { workspaceId } = await requireObjectRole(deps.sql, user, "document", p.documentId, "editor");
  const tables = await documentTables(deps, user, p.documentId);
  const t = tables.find((x) => x.sheet === p.sheet);
  if (!t) throw notFound("table");
  if (p.valueColumn >= t.columns.length || p.labelColumn >= t.columns.length) throw new AppError("bad_column", 400);
  const [doc] = await deps.sql<{ title: string; version: string }[]>`select title, current_version_id as version from documents where id = ${p.documentId}`;
  const created: { id: string; period: string; value: number; isExample: boolean }[] = [];
  await deps.sql.begin(async (tx) => {
    await tx`delete from stat_facts where document_version_id = ${doc!.version} and indicator = ${p.indicator}`;
    for (let i = 0; i < t.rows.length; i++) {
      const row = t.rows[i]!;
      const value = row[p.valueColumn];
      const label = row[p.labelColumn];
      if (typeof value !== "number" || label == null) continue;
      const isExample = p.isExample ?? row.some((c) => typeof c === "string" && EXAMPLE_RE.test(c));
      const quote = `${t.columns[p.labelColumn]}: ${label}; ${t.columns[p.valueColumn]}: ${value}`;
      const locator = { sheet: t.sheet, row: i + 2 };
      const [ref] = await tx<{ id: string }[]>`
        insert into source_references (workspace_id, document_id, document_version_id, document_title, locator, quote, verified, verification)
        values (${workspaceId}, ${p.documentId}, ${doc!.version}, ${doc!.title}, ${tx.json(locator as never)}, ${quote}, true, 'table_value') returning id`;
      const [f] = await tx<{ id: string }[]>`
        insert into stat_facts (workspace_id, document_version_id, source_ref_id, indicator, definition, value, unit, geography, period, published_on, source_url, locator, sample_info, verified_at, is_example)
        values (${workspaceId}, ${doc!.version}, ${ref!.id}, ${p.indicator}, ${p.definition ?? null}, ${value}, ${p.unit}, ${p.geography ?? null}, ${String(label)},
                ${p.publishedOn ?? null}, ${p.sourceUrl ?? null}, ${tx.json(locator as never)}, ${p.sampleInfo ?? null}, now(), ${isExample}) returning id`;
      created.push({ id: f!.id, period: String(label), value, isExample });
    }
  });
  return { created };
}

export async function listFacts(deps: Deps, user: UserRow, documentId: string) {
  await requireObjectRole(deps.sql, user, "document", documentId, "viewer");
  return deps.sql`select f.id, f.indicator, f.definition, f.value::float as value, f.unit, f.geography, f.period, f.published_on::text, f.source_url, f.locator,
      f.sample_info, f.verified_at, f.is_example, sr.quote, sr.document_title
    from stat_facts f join documents d on d.current_version_id = f.document_version_id left join source_references sr on sr.id = f.source_ref_id
    where d.id = ${documentId} order by f.indicator, f.created_at`;
}

/** Derived numbers are computed in code and returned with the formula and inputs. */
export function compute(op: "pct_change" | "diff" | "ratio", a: { value: number; period: string; unit: string }, b: { value: number; period: string; unit: string }) {
  if (a.unit !== b.unit) throw new AppError("unit_mismatch", 400, "different units", { a: a.unit, b: b.unit });
  if (op === "pct_change") {
    if (a.value === 0) throw new AppError("division_by_zero", 400);
    const r = ((b.value - a.value) / a.value) * 100;
    return { value: Math.round(r * 100) / 100, unit: "%", formula: `(${b.value} − ${a.value}) / ${a.value} × 100`, denominator: `${a.period}: ${a.value} ${a.unit}` };
  }
  if (op === "diff") return { value: Math.round((b.value - a.value) * 1e6) / 1e6, unit: a.unit, formula: `${b.value} − ${a.value}`, denominator: null };
  if (b.value === 0) throw new AppError("division_by_zero", 400);
  return { value: Math.round((a.value / b.value) * 1e4) / 1e4, unit: "×", formula: `${a.value} / ${b.value}`, denominator: `${b.period}: ${b.value} ${b.unit}` };
}

export async function computeFacts(deps: Deps, user: UserRow, p: { aId: string; bId: string; op: "pct_change" | "diff" | "ratio" }) {
  const rows = await deps.sql<{ id: string; value: number; period: string; unit: string; workspace_id: string; is_example: boolean }[]>`
    select id, value::float as value, period, unit, workspace_id, is_example from stat_facts where id in ${deps.sql([p.aId, p.bId])}`;
  const a = rows.find((r) => r.id === p.aId);
  const b = rows.find((r) => r.id === p.bId);
  if (!a || !b) throw notFound("fact");
  await requireWorkspaceRole(deps.sql, user, a.workspace_id, "viewer");
  await requireWorkspaceRole(deps.sql, user, b.workspace_id, "viewer");
  return { ...compute(p.op, a, b), isExample: a.is_example || b.is_example };
}

/** Statistical quiz: the key is the exact table value; distractors are other values of the same series. */
export async function quizFromFacts(deps: Deps, user: UserRow, documentId: string, indicator: string, language = "uz") {
  const facts = (await listFacts(deps, user, documentId)) as unknown as { id: string; indicator: string; value: number; unit: string; period: string; is_example: boolean; quote: string; document_title: string; locator: Record<string, unknown> }[];
  const series = facts.filter((f) => f.indicator === indicator);
  if (series.length < 4) throw new AppError("not_enough_values", 409, "need at least 4 values", { have: series.length });
  const [ver] = await deps.sql<{ v: string }[]>`select current_version_id as v from documents where id = ${documentId}`;
  const example = series.some((f) => f.is_example);
  const fmt = (v: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v).replace(/ /g, " ");
  const T = {
    uz: (ind: string, per: string, unit: string) => `${per} uchun «${ind}» koʻrsatkichi qancha (${unit})?`,
    ru: (ind: string, per: string, unit: string) => `Каково значение показателя «${ind}» за ${per} (${unit})?`,
    en: (ind: string, per: string, unit: string) => `What is “${ind}” for ${per} (${unit})?`,
  };
  const tmpl = language === "ru" ? T.ru : language === "en" ? T.en : T.uz;
  const cands: Candidate[] = series.map((f) => {
    const others = shuffle(series.filter((o) => o.value !== f.value)).slice(0, 3);
    return {
      text: tmpl(f.indicator, f.period, f.unit),
      type: "single",
      options: shuffle([{ text: fmt(f.value), correct: true }, ...others.map((o) => ({ text: fmt(o.value), correct: false, whyWrong: `${o.period}: ${fmt(o.value)} ${o.unit}` }))]),
      explanation: `${f.document_title}: ${f.quote}`,
      difficulty: "easy", cognitiveLevel: "recall", topic: f.indicator, language,
      evidence: { chunkId: null, documentId, documentVersionId: ver!.v, documentTitle: f.document_title, locator: f.locator, quote: f.quote, method: "table_value" },
      evidenceStatus: "verified", generator: "extractive",
      notes: example ? { exampleData: true } : undefined,
    };
  });
  return deps.sql.begin(async (tx) => {
    const title = `${example ? "Namuna maʼlumot — " : ""}${indicator}`.slice(0, 200);
    const [quiz] = await tx<{ id: string }[]>`insert into quizzes (workspace_id, owner_id, title, language, topic, settings, source_document_ids)
      values (${user.personal_workspace_id}, ${user.id}, ${title}, ${language}, ${indicator}, ${tx.json({ sourceMode: "sources_only" } as never)}, ${[documentId]}) returning id`;
    const [v] = await tx<{ id: string }[]>`insert into quiz_versions (quiz_id, version_no, created_by, generation_note) values (${quiz!.id}, 1, ${user.id}, ${tx.json({ requested: cands.length, produced: cands.length, mode: "table", exampleData: example } as never)}) returning id`;
    await tx`update quizzes set draft_version_id = ${v!.id} where id = ${quiz!.id}`;
    let pos = 0;
    for (const c of cands) {
      const checks = deterministicChecks(c, cands, { sourcesOnly: true, aiAvailable: false });
      await insertCandidate(tx, { versionId: v!.id, workspaceId: user.personal_workspace_id, position: pos++, c, checks, status: statusFromChecks(checks) });
    }
    return { quizId: quiz!.id, questions: cands.length, exampleData: example };
  });
}
