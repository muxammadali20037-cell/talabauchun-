import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type OcrResult = { text: string; confidence: number; words: number };

/**
 * Runs Tesseract on an image and returns text with the mean word confidence
 * (0-100). Low confidence is reported to the user instead of being hidden.
 */
export async function ocrImage(imagePath: string, opts: { bin: string; langs: string; timeoutMs?: number }): Promise<OcrResult> {
  const { stdout } = await run(opts.bin, [imagePath, "stdout", "-l", opts.langs, "--psm", "3", "tsv"], {
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, OMP_THREAD_LIMIT: "1" },
  });
  const lines = stdout.split("\n").slice(1);
  let confSum = 0;
  let words = 0;
  const out: string[] = [];
  let lastKey = "";
  let current: string[] = [];
  let lastPar = "";
  for (const line of lines) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const [level, , block, par, ln, , , , , , confStr, ...rest] = cols;
    const text = rest.join("\t").trim();
    if (level !== "5" || !text) continue;
    const conf = Number(confStr);
    if (conf >= 0) {
      confSum += conf;
      words++;
    }
    const key = `${block}.${par}.${ln}`;
    if (key !== lastKey && current.length) {
      out.push(current.join(" "));
      current = [];
      const parKey = `${block}.${par}`;
      if (parKey !== lastPar) out.push("");
    }
    lastPar = `${block}.${par}`;
    lastKey = key;
    current.push(text);
  }
  if (current.length) out.push(current.join(" "));
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), confidence: words ? confSum / words : 0, words };
}

/** Renders one PDF page (1-based) to PNG with poppler's pdftoppm and OCRs it. */
export async function ocrPdfPage(pdfPath: string, pageIndex: number, opts: { pdftoppm: string; tesseract: string; langs: string; dpi?: number }): Promise<OcrResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "talaba-ocr-"));
  try {
    await run(opts.pdftoppm, ["-f", String(pageIndex), "-l", String(pageIndex), "-r", String(opts.dpi ?? 200), "-gray", "-png", pdfPath, path.join(dir, "p")], {
      timeout: 120_000,
    });
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png"));
    if (!files.length) return { text: "", confidence: 0, words: 0 };
    return await ocrImage(path.join(dir, files[0]!), { bin: opts.tesseract, langs: opts.langs });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
