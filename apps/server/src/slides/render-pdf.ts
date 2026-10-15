import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * PPTX → PDF with LibreOffice headless. The PDF is rendered from the very
 * PPTX the student downloads, so both formats show the same text. Each
 * conversion gets its own throw-away LibreOffice profile: a shared profile is
 * locked by the first process and parallel conversions would fail.
 */

export class RenderError extends Error {
  constructor(public readonly code: string, public readonly retryable: boolean, message?: string) {
    super(message ?? code);
  }
}

type ExecResult = { stdout: string; stderr: string };

export function run(bin: string, args: string[], opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs ?? 60_000, cwd: opts.cwd, env: opts.env ?? process.env, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, killSignal: "SIGKILL", encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (e.code === "ENOENT") return reject(new RenderError("renderer_missing", false, `${bin} not found`));
          if (e.killed || e.signal === "SIGKILL") return reject(new RenderError("render_timeout", true, `${path.basename(bin)} timed out`));
          return reject(new RenderError("render_failed", true, `${path.basename(bin)}: ${String(stderr || e.message).slice(0, 300)}`));
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

// At most two LibreOffice processes per worker: each needs ~200 MB and a CPU.
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** Creates a private work directory and always removes it afterwards. */
export async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "talaba-render-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Converts PPTX bytes to PDF bytes. `dir` must be a private work directory. */
export async function convertPptxToPdf(pptx: Buffer, dir: string, o: { bin: string; timeoutMs?: number }): Promise<{ pdf: Buffer; pdfPath: string }> {
  const input = path.join(dir, "deck.pptx");
  await writeFile(input, pptx);
  const profile = path.join(dir, "lo-profile");
  await withSlot(() =>
    run(
      o.bin,
      [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--invisible", "--norestore", "--nologo", "--nolockcheck", "--nodefault", "--convert-to", "pdf", "--outdir", dir, input],
      // HOME points into the work dir so nothing is written to the service user's home
      { timeoutMs: o.timeoutMs ?? 120_000, cwd: dir, env: { ...process.env, HOME: dir, SAL_USE_VCLPLUGIN: "svp" } },
    ),
  );
  const pdfPath = path.join(dir, "deck.pdf");
  const pdf = await readFile(pdfPath).catch(() => null);
  if (!pdf || pdf.length < 100 || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new RenderError("pdf_not_produced", true);
  return { pdf, pdfPath };
}

/** PNG renders of every page (thumbnails / visual QA). Returns files in page order. */
export async function renderPngs(pdfPath: string, dir: string, o: { bin: string; dpi?: number; prefix?: string }): Promise<string[]> {
  const prefix = path.join(dir, o.prefix ?? "page");
  await run(o.bin, ["-r", String(o.dpi ?? 50), "-png", pdfPath, prefix], { timeoutMs: 60_000 });
  const base = path.basename(prefix);
  const files = (await readdir(dir)).filter((f) => f.startsWith(base + "-") && f.endsWith(".png"));
  return files.sort((a, b) => Number(/-(\d+)\.png$/.exec(a)![1]) - Number(/-(\d+)\.png$/.exec(b)![1])).map((f) => path.join(dir, f));
}
