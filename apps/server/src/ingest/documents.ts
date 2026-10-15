import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { requireObjectRole, requireWorkspaceRole } from "../access/policy";
import { enqueueJob } from "../jobs/queue";
import { AppError, badRequest } from "../lib/errors";
import { sha256Hex } from "../lib/crypto";
import { detectKind, type SourceKind } from "./detect";

export type DocumentSummary = {
  id: string;
  title: string;
  author: string | null;
  sourceKind: string;
  workspaceId: string;
  createdAt: Date;
  version: null | {
    id: string;
    versionNo: number;
    status: string;
    pageCount: number | null;
    pagesOk: number;
    pagesFailed: number;
    pagesLowConf: number;
    errorCode: string | null;
    byteSize: number | null;
    filename: string | null;
  };
  jobId: string | null;
};

function titleFromFilename(name: string) {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").trim().slice(0, 200) || "Hujjat";
}

async function insertDocument(
  deps: Deps,
  p: { user: UserRow; workspaceId: string; title: string; kind: SourceKind | "text" | "url"; sourceUrl?: string | null; via: "miniapp" | "bot" | "api" },
  v: { storageKey: string | null; filename: string | null; mime: string | null; size: number | null; sha: string | null },
  notifyChatId?: string | number | null,
) {
  return deps.sql.begin(async (tx) => {
    const [doc] = await tx<{ id: string }[]>`
      insert into documents (workspace_id, owner_id, title, source_kind, source_url, created_via)
      values (${p.workspaceId}, ${p.user.id}, ${p.title}, ${p.kind}, ${p.sourceUrl ?? null}, ${p.via}) returning id`;
    const [ver] = await tx<{ id: string }[]>`
      insert into document_versions (document_id, version_no, storage_key, original_filename, mime, byte_size, sha256, status)
      values (${doc!.id}, 1, ${v.storageKey}, ${v.filename}, ${v.mime}, ${v.size}, ${v.sha}, 'queued') returning id`;
    const { job } = await enqueueJob(tx, {
      kind: "ingest_document",
      userId: p.user.id,
      workspaceId: p.workspaceId,
      targetId: ver!.id,
      idempotencyKey: `ingest:${ver!.id}`,
      stages: ["extracting", "indexing"],
      input: { documentId: doc!.id, versionId: ver!.id },
      notifyChatId: notifyChatId ?? null,
    });
    return { documentId: doc!.id, versionId: ver!.id, jobId: job.id };
  });
}

export async function createDocumentFromFile(
  deps: Deps,
  p: { user: UserRow; workspaceId?: string; filename: string; data: Buffer; via: "miniapp" | "bot" | "api"; title?: string; notifyChatId?: string | number | null },
) {
  const workspaceId = p.workspaceId ?? p.user.personal_workspace_id;
  await requireWorkspaceRole(deps.sql, p.user, workspaceId, "editor");
  const maxBytes = deps.cfg.MAX_UPLOAD_MB * 1024 * 1024;
  if (p.data.length > maxBytes) throw new AppError("file_too_large", 413, "file too large", { sizeMb: Math.ceil(p.data.length / 1048576), maxMb: deps.cfg.MAX_UPLOAD_MB });
  if (p.data.length === 0) throw badRequest("file_empty");
  const detected = await detectKind(p.data, p.filename);
  if ("error" in detected) throw badRequest(detected.error === "macro_file" ? "file_macro_not_allowed" : "file_unsupported");
  const ext = p.filename.split(".").pop() ?? "";
  const key = deps.storage.newKey(workspaceId, ext);
  await deps.storage.put(key, p.data);
  return insertDocument(
    deps,
    { user: p.user, workspaceId, title: (p.title ?? titleFromFilename(p.filename)).slice(0, 200), kind: detected.kind, via: p.via },
    { storageKey: key, filename: p.filename.slice(0, 255), mime: detected.mime, size: p.data.length, sha: sha256Hex(p.data) },
    p.notifyChatId,
  );
}

export async function createDocumentFromText(deps: Deps, p: { user: UserRow; workspaceId?: string; title: string; text: string; via: "miniapp" | "bot" | "api"; notifyChatId?: string | number | null }) {
  const workspaceId = p.workspaceId ?? p.user.personal_workspace_id;
  await requireWorkspaceRole(deps.sql, p.user, workspaceId, "editor");
  const text = p.text.trim();
  if (text.length < 20) throw badRequest("text_too_short");
  if (text.length > 2_000_000) throw new AppError("file_too_large", 413);
  const data = Buffer.from(text, "utf8");
  const key = deps.storage.newKey(workspaceId, "txt");
  await deps.storage.put(key, data);
  return insertDocument(
    deps,
    { user: p.user, workspaceId, title: p.title.trim().slice(0, 200) || "Matn", kind: "text", via: p.via },
    { storageKey: key, filename: null, mime: "text/plain", size: data.length, sha: sha256Hex(data) },
    p.notifyChatId,
  );
}

export async function createDocumentFromUrl(deps: Deps, p: { user: UserRow; workspaceId?: string; url: string; via: "miniapp" | "bot" | "api"; notifyChatId?: string | number | null }) {
  const workspaceId = p.workspaceId ?? p.user.personal_workspace_id;
  await requireWorkspaceRole(deps.sql, p.user, workspaceId, "editor");
  let u: URL;
  try {
    u = new URL(p.url.trim());
  } catch {
    throw badRequest("url_invalid");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest("url_invalid");
  return insertDocument(
    deps,
    { user: p.user, workspaceId, title: u.hostname + u.pathname.slice(0, 80), kind: "url", sourceUrl: u.toString(), via: p.via },
    { storageKey: null, filename: null, mime: null, size: null, sha: null },
    p.notifyChatId,
  );
}

const SUMMARY_SQL = `
  select d.id, d.title, d.author, d.source_kind, d.workspace_id, d.created_at,
    v.id as v_id, v.version_no, v.status, v.page_count, v.pages_ok, v.pages_failed, v.pages_low_conf, v.error_code, v.byte_size, v.original_filename,
    (select j.id from generation_jobs j where j.target_id = v.id order by j.created_at desc limit 1) as job_id
  from documents d
  left join lateral (select * from document_versions dv where dv.document_id = d.id order by dv.version_no desc limit 1) v on true`;

type SummaryRow = {
  id: string; title: string; author: string | null; source_kind: string; workspace_id: string; created_at: Date;
  v_id: string | null; version_no: number; status: string; page_count: number | null; pages_ok: number; pages_failed: number;
  pages_low_conf: number; error_code: string | null; byte_size: string | null; original_filename: string | null; job_id: string | null;
};

function toSummary(r: SummaryRow): DocumentSummary {
  return {
    id: r.id,
    title: r.title,
    author: r.author,
    sourceKind: r.source_kind,
    workspaceId: r.workspace_id,
    createdAt: r.created_at,
    jobId: r.job_id,
    version: r.v_id
      ? {
          id: r.v_id, versionNo: r.version_no, status: r.status, pageCount: r.page_count, pagesOk: r.pages_ok, pagesFailed: r.pages_failed,
          pagesLowConf: r.pages_low_conf, errorCode: r.error_code, byteSize: r.byte_size == null ? null : Number(r.byte_size), filename: r.original_filename,
        }
      : null,
  };
}

export async function listDocuments(deps: Deps, user: UserRow, opts: { workspaceId?: string; limit?: number; cursor?: string | null }) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const params: unknown[] = [user.id];
  let where = `d.deleted_at is null and d.workspace_id in (select m.workspace_id from memberships m where m.user_id = $1)`;
  if (opts.workspaceId) {
    params.push(opts.workspaceId);
    where += ` and d.workspace_id = $${params.length}`;
  }
  if (opts.cursor) {
    params.push(new Date(opts.cursor));
    where += ` and d.created_at < $${params.length}`;
  }
  params.push(limit + 1);
  const rows = await deps.sql.unsafe<SummaryRow[]>(`${SUMMARY_SQL} where ${where} order by d.created_at desc limit $${params.length}`, params as never[]);
  const items = rows.slice(0, limit).map(toSummary);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.createdAt.toISOString() : null };
}

export async function getDocument(deps: Deps, user: UserRow, id: string) {
  const { role } = await requireObjectRole(deps.sql, user, "document", id, "viewer");
  const [row] = await deps.sql.unsafe<SummaryRow[]>(`${SUMMARY_SQL} where d.id = $1`, [id]);
  const summary = toSummary(row!);
  const versionId = summary.version?.id;
  const pages = versionId
    ? await deps.sql<{ page_index: number; page_label: string | null; kind: string; heading: string | null; method: string; ocr_confidence: number | null; status: string; chars: number }[]>`
        select page_index, page_label, kind, heading, method, ocr_confidence, status, length(text) as chars
        from pages where document_version_id = ${versionId} order by page_index limit 2000`
    : [];
  const sections = versionId
    ? await deps.sql<{ id: string; title: string; level: number; start_page: number; end_page: number }[]>`
        select id, title, level, start_page, end_page from sections where document_version_id = ${versionId} order by ord`
    : [];
  const versions = await deps.sql<{ id: string; version_no: number; status: string; created_at: Date }[]>`
    select id, version_no, status, created_at from document_versions where document_id = ${id} order by version_no desc`;
  const [tables] = versionId
    ? await deps.sql<{ n: number }[]>`select (case when jsonb_typeof(metadata->'tables') = 'array' then jsonb_array_length(metadata->'tables') else 0 end)::int as n from document_versions where id = ${versionId}`
    : [];
  return { ...summary, role, pages, sections, versions, hasTables: (tables?.n ?? 0) > 0 };
}

export async function getPageText(deps: Deps, user: UserRow, documentId: string, pageIndex: number) {
  await requireObjectRole(deps.sql, user, "document", documentId, "viewer");
  const [p] = await deps.sql<{ text: string; page_label: string | null; kind: string; heading: string | null; status: string; method: string; ocr_confidence: number | null }[]>`
    select p.text, p.page_label, p.kind, p.heading, p.status, p.method, p.ocr_confidence from pages p
    join document_versions v on v.id = p.document_version_id
    where v.id = (select id from document_versions where document_id = ${documentId} order by version_no desc limit 1) and p.page_index = ${pageIndex}`;
  if (!p) throw new AppError("not_found", 404);
  return p;
}

/**
 * Deletes a source: removes the file, pages, chunks and embeddings (cascade).
 * Existing quizzes keep their own evidence snapshot (source_references.quote).
 */
export async function deleteDocument(deps: Deps, user: UserRow, id: string) {
  await requireObjectRole(deps.sql, user, "document", id, "editor");
  const keys = await deps.sql<{ storage_key: string | null }[]>`select storage_key from document_versions where document_id = ${id}`;
  await deps.sql.begin(async (tx) => {
    await tx`update documents set deleted_at = now(), current_version_id = null where id = ${id}`;
    await tx`delete from chunks where document_version_id in (select id from document_versions where document_id = ${id})`;
    await tx`delete from pages where document_version_id in (select id from document_versions where document_id = ${id})`;
    await tx`update document_versions set status = 'deleted', storage_key = null where document_id = ${id}`;
    await tx`insert into audit_events (actor_id, action, target_type, target_id) values (${user.id}, 'document.delete', 'document', ${id})`;
  });
  for (const k of keys) if (k.storage_key) await deps.storage.delete(k.storage_key);
}

export async function addDocumentVersion(deps: Deps, user: UserRow, documentId: string, filename: string, data: Buffer) {
  const { workspaceId } = await requireObjectRole(deps.sql, user, "document", documentId, "editor");
  const detected = await detectKind(data, filename);
  if ("error" in detected) throw badRequest("file_unsupported");
  const key = deps.storage.newKey(workspaceId, filename.split(".").pop() ?? "");
  await deps.storage.put(key, data);
  return deps.sql.begin(async (tx) => {
    const [row] = await tx<{ next: number }[]>`select coalesce(max(version_no), 0) + 1 as next from document_versions where document_id = ${documentId}`;
    const next = row!.next;
    const [ver] = await tx<{ id: string }[]>`
      insert into document_versions (document_id, version_no, storage_key, original_filename, mime, byte_size, sha256, status)
      values (${documentId}, ${next}, ${key}, ${filename}, ${detected.mime}, ${data.length}, ${sha256Hex(data)}, 'queued') returning id`;
    await tx`update documents set source_kind = ${detected.kind}, updated_at = now() where id = ${documentId}`;
    const { job } = await enqueueJob(tx, {
      kind: "ingest_document", userId: user.id, workspaceId, targetId: ver!.id, idempotencyKey: `ingest:${ver!.id}`,
      stages: ["extracting", "indexing"], input: { documentId, versionId: ver!.id },
    });
    return { documentId, versionId: ver!.id, jobId: job.id, versionNo: next };
  });
}
