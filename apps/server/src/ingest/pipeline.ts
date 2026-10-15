import { effectiveLimits } from "../billing/plans";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deps } from "../deps";
import { JobError, type JobContext, type JobResult } from "../jobs/queue";
import { enqueueMessage } from "../telegram/outbox";
import { translate } from "@talaba/shared";
import type { Lang } from "@talaba/shared";
import { chunkText } from "./chunker";
import { extractDocx } from "./docx";
import { extractHtml } from "./html";
import { detectInjection } from "./injection";
import { ocrImage } from "./ocr";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractCsv, extractXlsx } from "./tabular";
import { decodeText, extractPlainText } from "./text";
import { ExtractError, reflowLines, type ExtractedPage, type ExtractResult } from "./types";
import { safeFetch } from "./url-fetch";
import { miniAppUrl } from "../telegram/links";

type VersionRow = { id: string; document_id: string; storage_key: string | null; original_filename: string | null; mime: string | null; source_kind: string; source_url: string | null; title: string; owner_id: string; workspace_id: string; created_via: string };

async function insertPage(deps: Deps, versionId: string, p: ExtractedPage) {
  await deps.sql`
    insert into pages (document_version_id, page_index, page_label, kind, heading, text, method, ocr_confidence, status, error)
    values (${versionId}, ${p.pageIndex}, ${p.pageLabel ?? null}, ${p.kind}, ${p.heading ?? null}, ${p.text}, ${p.method},
            ${p.ocrConfidence ?? null}, ${p.status}, ${p.error ?? null})
    on conflict (document_version_id, page_index) do update set
      text = excluded.text, method = excluded.method, ocr_confidence = excluded.ocr_confidence, status = excluded.status,
      error = excluded.error, heading = excluded.heading, page_label = excluded.page_label`;
}

async function ocrBudgetLeft(deps: Deps, userId: string): Promise<number> {
  const limit = (await effectiveLimits(deps.sql, userId)).maxOcrPagesPerMonth;
  const [used] = await deps.sql<{ n: string }[]>`
    select coalesce(sum(quantity), 0)::text as n from usage_events where user_id = ${userId} and kind = 'ocr_page' and created_at >= date_trunc('month', now())`;
  return Math.max(0, limit - Number(used?.n ?? 0));
}

/**
 * Ingestion job: extracting (text/OCR per page, resumable) → indexing (chunks,
 * sections, optional embeddings) → final status with honest page counts.
 */
export function ingestHandler(deps: Deps) {
  return async (ctx: JobContext): Promise<JobResult> => {
    const versionId = String(ctx.job.input.versionId);
    const [v] = await deps.sql<VersionRow[]>`
      select v.id, v.document_id, v.storage_key, v.original_filename, v.mime, d.source_kind, d.source_url, d.title, d.owner_id, d.workspace_id, d.created_via
      from document_versions v join documents d on d.id = v.document_id where v.id = ${versionId}`;
    if (!v) throw new JobError("version_missing");

    await ctx.stage("extracting");
    await deps.sql`update document_versions set status = 'extracting' where id = ${versionId}`;
    const done = new Set((await deps.sql<{ page_index: number }[]>`select page_index from pages where document_version_id = ${versionId}`).map((r) => r.page_index));

    let extracted: ExtractResult;
    let ocrPages = 0;
    const workDir = await mkdtemp(path.join(tmpdir(), "talaba-ingest-"));
    try {
      let data: Buffer | null = v.storage_key ? await deps.storage.get(v.storage_key) : null;
      let kind = v.source_kind;
      if (kind === "url") {
        const fetched = await safeFetch(v.source_url!).catch((e) => {
          if (e instanceof ExtractError) throw e;
          throw new ExtractError("fetch_failed");
        });
        data = fetched.body;
        const ct = fetched.contentType.toLowerCase();
        const key = deps.storage.newKey(v.workspace_id, ct.includes("pdf") ? "pdf" : "html");
        await deps.storage.put(key, data);
        await deps.sql`update document_versions set storage_key = ${key}, mime = ${ct.split(";")[0] ?? null}, byte_size = ${data.length} where id = ${versionId}`;
        kind = ct.includes("application/pdf") ? "url_pdf" : ct.includes("text/plain") ? "url_text" : "url_html";
      }
      if (!data) throw new JobError("blob_missing");
      const ocrLeft = await ocrBudgetLeft(deps, v.owner_id);
      let ocrUsed = 0;
      const ocrCfg = { pdftoppm: deps.cfg.PDFTOPPM_BIN, tesseract: deps.cfg.TESSERACT_BIN, langs: deps.cfg.OCR_LANGS };
      switch (kind) {
        case "pdf":
        case "url_pdf": {
          const pdfPath = path.join(workDir, "doc.pdf");
          await writeFile(pdfPath, data);
          extracted = await extractPdf(data, pdfPath, {
            maxPages: deps.cfg.MAX_PDF_PAGES,
            ocr: { enabled: ocrLeft > 0, ...ocrCfg },
            skipPages: done,
            shouldStop: () => ctx.throwIfCancelled(),
            onPage: async (p) => {
              if (p.method === "ocr") {
                ocrUsed++;
                ocrPages++;
              }
              await insertPage(deps, versionId, p);
            },
          });
          break;
        }
        case "image": {
          const imgPath = path.join(workDir, "img");
          await writeFile(imgPath, data);
          if (ocrLeft <= 0) {
            extracted = { pages: [{ pageIndex: 1, kind: "image", text: "", method: "none", status: "failed", error: "ocr_limit" }], sections: [], pageCount: 1, metadata: {} };
          } else {
            const r = await ocrImage(imgPath, { bin: deps.cfg.TESSERACT_BIN, langs: deps.cfg.OCR_LANGS });
            ocrUsed = 1;
            ocrPages = 1;
            const status = r.words === 0 ? "failed" : r.confidence >= 60 ? "ok" : r.confidence >= 35 ? "low_confidence" : "failed";
            extracted = { pages: [{ pageIndex: 1, kind: "image", text: reflowLines(r.text), method: "ocr", ocrConfidence: Math.round(r.confidence * 10) / 10, status }], sections: [], pageCount: 1, metadata: {} };
          }
          break;
        }
        case "docx":
          extracted = await extractDocx(data);
          break;
        case "pptx":
          extracted = await extractPptx(data);
          break;
        case "txt":
        case "text":
        case "url_text":
          extracted = extractPlainText(decodeText(data));
          break;
        case "url_html":
          extracted = extractHtml(decodeText(data), v.source_url ?? "");
          break;
        case "csv":
          extracted = extractCsv(data);
          break;
        case "xlsx":
          extracted = await extractXlsx(data);
          break;
        default:
          throw new JobError("unsupported_kind");
      }
      if (ocrUsed > 0) {
        await deps.sql`insert into usage_events (user_id, workspace_id, job_id, kind, quantity, task) values (${v.owner_id}, ${v.workspace_id}, ${ctx.job.id}, 'ocr_page', ${ocrUsed}, 'ingest')`;
      }
      if (kind !== "pdf" && kind !== "url_pdf") for (const p of extracted.pages) await insertPage(deps, versionId, p);
    } catch (e) {
      if (e instanceof ExtractError) {
        await deps.sql`update document_versions set status = 'failed', error_code = ${e.code}, processed_at = now() where id = ${versionId}`;
        await notifyDoc(deps, ctx, v, "failed", { reason: e.code });
        return { result: { status: "failed", errorCode: e.code } };
      }
      throw e;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    // ── indexing ──
    await ctx.throwIfCancelled();
    await ctx.stage("indexing");
    await deps.sql`update document_versions set status = 'indexing' where id = ${versionId}`;
    const pages = await deps.sql<{ id: string; page_index: number; page_label: string | null; kind: string; heading: string | null; text: string; status: string }[]>`
      select id, page_index, page_label, kind, heading, text, status from pages where document_version_id = ${versionId} order by page_index`;
    const pageCount = Math.max(extracted.pageCount, pages.length);
    await deps.sql.begin(async (tx) => {
      await tx`delete from chunks where document_version_id = ${versionId}`;
      await tx`delete from sections where document_version_id = ${versionId}`;
      const sectionIds: { id: string; start: number; end: number; level: number }[] = [];
      let ord = 0;
      for (const s of extracted.sections) {
        const [row] = await tx<{ id: string }[]>`
          insert into sections (document_version_id, title, level, start_page, end_page, ord)
          values (${versionId}, ${s.title}, ${s.level}, ${s.startPage}, ${s.endPage}, ${ord++}) returning id`;
        sectionIds.push({ id: row!.id, start: s.startPage, end: s.endPage, level: s.level });
      }
      let chunkOrd = 0;
      const rows: Record<string, unknown>[] = [];
      for (const p of pages) {
        if (p.status !== "ok" && p.status !== "low_confidence") continue;
        const sec = sectionIds.filter((s) => s.start <= p.page_index && s.end >= p.page_index).sort((a, b) => b.level - a.level)[0];
        const locator: Record<string, unknown> =
          p.kind === "pdf_page" ? { pageIndex: p.page_index, ...(p.page_label ? { pageLabel: p.page_label } : {}) }
          : p.kind === "slide" ? { slide: p.page_index }
          : p.kind === "sheet" ? { sheet: p.heading }
          : p.kind === "image" ? { pageIndex: 1 }
          : { section: p.page_index, ...(p.heading ? { heading: p.heading } : {}), ...(v.source_url ? { url: v.source_url } : {}) };
        for (const text of chunkText(p.text)) {
          rows.push({
            document_version_id: versionId, page_id: p.id, section_id: sec?.id ?? null, ord: chunkOrd++,
            page_start: p.page_index, page_end: p.page_index, locator: tx.json(locator as never), text,
          });
        }
      }
      for (let i = 0; i < rows.length; i += 500) await tx`insert into chunks ${tx(rows.slice(i, i + 500) as never)}`;
    });

    if (deps.embedder) {
      const chunks = await deps.sql<{ id: string; text: string }[]>`select id, text from chunks where document_version_id = ${versionId} and embedding is null order by ord`;
      for (let i = 0; i < chunks.length; i += 64) {
        const batch = chunks.slice(i, i + 64);
        const vectors = await deps.embedder.embed(batch.map((c) => c.text), "document");
        for (let j = 0; j < batch.length; j++) {
          await deps.sql`update chunks set embedding = ${JSON.stringify(vectors[j])}::vector, embedding_model = ${deps.embedder.model} where id = ${batch[j]!.id}`;
        }
      }
    }

    const injection = pages.flatMap((p) => detectInjection(p.text).map((hit) => ({ page: p.page_index, hit })));
    const ok = pages.filter((p) => p.status === "ok").length;
    const low = pages.filter((p) => p.status === "low_confidence").length;
    const failed = pages.filter((p) => p.status === "failed").length;
    const empty = pages.filter((p) => p.status === "empty").length;
    const usable = ok + low;
    const status = usable === 0 ? "failed" : failed > 0 || low > 0 || pages.length < pageCount ? "partial" : "ready";
    const metadata = { ...extracted.metadata, emptyPages: empty, injectionFlags: injection.slice(0, 20), ocrPages, tables: extracted.tables ?? undefined };
    await deps.sql.begin(async (tx) => {
      await tx`update document_versions set status = ${status}, page_count = ${pageCount}, pages_ok = ${ok}, pages_failed = ${failed},
        pages_low_conf = ${low}, error_code = ${usable === 0 ? "no_text" : null}, metadata = ${tx.json(metadata as never)}, processed_at = now()
        where id = ${versionId}`;
      if (status !== "failed") {
        // Embedded metadata titles replace auto-generated ones (bot uploads, URLs), never a title the user typed.
        const betterTitle = v.created_via !== "miniapp" && extracted.title && extracted.title.length > 3 ? extracted.title.slice(0, 200) : null;
        await tx`update documents set current_version_id = ${versionId}, updated_at = now(), title = coalesce(${betterTitle}, title),
          author = coalesce(author, ${extracted.author ?? null}), published_info = coalesce(published_info, ${extracted.publishedInfo ?? null})
          where id = ${v.document_id}`;
      }
    });
    const failedList = pages.filter((p) => p.status === "failed").map((p) => p.page_index);
    await notifyDoc(deps, ctx, v, status === "failed" ? "failed" : status === "partial" ? "partial" : "ready", {
      ok: usable, total: pageCount, failed: compressRanges(failedList), reason: "no_text",
    });
    return { result: { status, pageCount, pagesOk: ok, pagesLowConf: low, pagesFailed: failed, emptyPages: empty, ocrPages } };
  };
}

export function compressRanges(nums: number[]): string {
  if (!nums.length) return "—";
  const out: string[] = [];
  let start = nums[0]!;
  let prev = start;
  for (const n of nums.slice(1).concat([NaN])) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    out.push(start === prev ? String(start) : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  return out.join(", ");
}

async function notifyDoc(deps: Deps, ctx: JobContext, v: VersionRow, kind: "ready" | "partial" | "failed", vars: Record<string, string | number>) {
  if (!ctx.job.notify_chat_id) return;
  const [u] = await deps.sql<{ language: Lang }[]>`select language from users where id = ${v.owner_id}`;
  const lang = u?.language ?? "uz";
  const [d] = await deps.sql<{ title: string }[]>`select title from documents where id = ${v.document_id}`;
  const title = escapeHtml(d?.title ?? v.title);
  const reasonKey = { password_protected: "library.passwordProtected", corrupted: "library.corrupted", too_large: "library.tooLarge", unsupported: "library.unsupported" } as const;
  const reason = vars.reason && vars.reason in reasonKey ? translate(lang, reasonKey[vars.reason as keyof typeof reasonKey], { size: "?", max: deps.cfg.MAX_UPLOAD_MB }) : translate(lang, "library.statusFailed");
  const text =
    kind === "ready" ? translate(lang, "bot.docReady", { title, ok: vars.ok ?? 0, total: vars.total ?? 0 })
    : kind === "partial" ? translate(lang, "bot.docPartial", { title, ok: vars.ok ?? 0, total: vars.total ?? 0, failed: vars.failed ?? "—" })
    : translate(lang, "bot.docFailed", { title, reason });
  const url = miniAppUrl(deps.cfg, `/library/${v.document_id}`);
  await enqueueMessage(deps.sql, {
    chatId: ctx.job.notify_chat_id,
    userId: v.owner_id,
    method: "sendMessage",
    payload: {
      text,
      parse_mode: "HTML",
      ...(url && kind !== "failed" ? { reply_markup: { inline_keyboard: [[{ text: translate(lang, "common.open"), web_app: { url } }]] } } : {}),
    },
    dedupeKey: `doc:${v.id}:${kind}`,
  });
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
