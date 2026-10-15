import ExcelJS from "exceljs";
import Papa from "papaparse";
import { ExtractError, type ExtractedPage, type ExtractResult, type TableData } from "./types";
import { decodeText } from "./text";

const MAX_ROWS = 5000;
const MAX_COLS = 60;

function normalizeCell(v: unknown): string | number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.result !== undefined) return normalizeCell(o.result);
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    return null;
  }
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toPages(tables: TableData[]): ExtractedPage[] {
  return tables.map((t, i) => ({
    pageIndex: i + 1,
    kind: "sheet" as const,
    heading: t.sheet,
    text: [t.columns.join(" | "), ...t.rows.slice(0, 400).map((r) => r.map((c) => (c === null ? "" : String(c))).join(" | "))].join("\n"),
    method: "text" as const,
    status: "ok" as const,
  }));
}

export function extractCsv(data: Buffer): ExtractResult {
  const text = decodeText(data);
  const parsed = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true, dynamicTyping: false });
  const rows = parsed.data.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ""));
  if (rows.length < 1) throw new ExtractError("empty");
  const columns = rows[0]!.slice(0, MAX_COLS).map((c, i) => String(c).trim() || `col${i + 1}`);
  const body = rows.slice(1, MAX_ROWS + 1).map((r) => columns.map((_, i) => parseNumberLike(r[i])));
  const table: TableData = { sheet: "CSV", columns, rows: body, truncated: rows.length - 1 > MAX_ROWS };
  return { pages: toPages([table]), sections: [], pageCount: 1, metadata: { rows: body.length }, tables: [table] };
}

/** Accepts "1 234,5" / "1,234.5" / "12%" as numbers; leaves other text as-is. */
export function parseNumberLike(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const compact = s.replace(/[\s ]/g, "").replace(/%$/, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(compact)) return Number(compact.replace(/,/g, ""));
  if (/^-?\d+(\.\d+)?$/.test(compact)) return Number(compact);
  if (/^-?\d+,\d+$/.test(compact)) return Number(compact.replace(",", "."));
  return s;
}

export async function extractXlsx(data: Buffer): Promise<ExtractResult> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as never);
  } catch {
    throw new ExtractError("corrupted");
  }
  const tables: TableData[] = [];
  wb.eachSheet((ws) => {
    const rows: (string | number | null)[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length > MAX_ROWS) return;
      const values = (row.values as unknown[]).slice(1, MAX_COLS + 1).map(normalizeCell);
      if (values.some((v) => v !== null)) rows.push(values);
    });
    if (!rows.length) return;
    const width = Math.max(...rows.map((r) => r.length));
    const columns = Array.from({ length: width }, (_, i) => String(rows[0]![i] ?? `col${i + 1}`));
    const body = rows.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
    tables.push({ sheet: ws.name, columns, rows: body.slice(0, MAX_ROWS), truncated: body.length > MAX_ROWS });
  });
  if (!tables.length) throw new ExtractError("empty");
  return { pages: toPages(tables), sections: [], pageCount: tables.length, metadata: { sheets: tables.map((t) => t.sheet) }, tables };
}
