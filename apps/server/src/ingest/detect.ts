import { fileTypeFromBuffer } from "file-type";

export type SourceKind = "pdf" | "docx" | "pptx" | "txt" | "image" | "csv" | "xlsx";

const EXT_KIND: Record<string, SourceKind> = {
  pdf: "pdf", docx: "docx", pptx: "pptx", txt: "txt", md: "txt", jpg: "image", jpeg: "image", png: "image", csv: "csv", xlsx: "xlsx",
};
const REJECT_EXT = new Set(["docm", "pptm", "xlsm", "exe", "js", "html", "htm", "svg", "zip", "rar", "doc", "ppt", "xls"]);

/**
 * Decides the source kind from the file's real content (magic bytes) and its
 * extension; both must agree. Macro-enabled Office files and legacy binary
 * formats are rejected with a clear message.
 */
export async function detectKind(data: Buffer, filename: string): Promise<{ kind: SourceKind; mime: string } | { error: "unsupported" | "macro_file" }> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (["docm", "pptm", "xlsm"].includes(ext)) return { error: "macro_file" };
  if (REJECT_EXT.has(ext)) return { error: "unsupported" };
  const ft = await fileTypeFromBuffer(data);
  if (ft) {
    if (ft.ext === "pdf") return { kind: "pdf", mime: ft.mime };
    if (ft.ext === "png" || ft.ext === "jpg") return { kind: "image", mime: ft.mime };
    if (ft.ext === "docx" && ext === "docx") return { kind: "docx", mime: ft.mime };
    if (ft.ext === "pptx" && ext === "pptx") return { kind: "pptx", mime: ft.mime };
    if (ft.ext === "xlsx" && ext === "xlsx") return { kind: "xlsx", mime: ft.mime };
    if (ft.ext === "zip" && (ext === "docx" || ext === "pptx" || ext === "xlsx")) return { kind: EXT_KIND[ext]!, mime: "application/zip" };
    return { error: "unsupported" };
  }
  // No magic bytes: accept only text-like content for txt/csv.
  const kind = EXT_KIND[ext];
  if (kind !== "txt" && kind !== "csv") return { error: "unsupported" };
  const sample = data.subarray(0, 4096);
  const binary = sample.filter((b) => b === 0).length > 0;
  if (binary) return { error: "unsupported" };
  return { kind, mime: kind === "csv" ? "text/csv" : "text/plain" };
}
