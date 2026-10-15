/**
 * Post-deploy smoke test against a running server + worker (e.g. the built dist/).
 * Signs Mini App initData with the bot token exactly like Telegram, then:
 * upload a PDF → wait until parsed → extractive quiz → 12-slide deck → PPTX + PDF export → download both.
 * Usage: SMOKE_URL=http://127.0.0.1:8097 TELEGRAM_BOT_TOKEN=... tsx scripts/smoke.ts <file.pdf>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { signInitData } from "../src/auth/init-data";

const base = process.env.SMOKE_URL ?? "http://127.0.0.1:8080";
const token = process.env.TELEGRAM_BOT_TOKEN!;
const file = process.argv[2]!;
const t0 = Date.now();
const step = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAHsmoke", user: JSON.stringify({ id: 777000111, first_name: "Smoke", language_code: "uz" }) }, token);
const auth = await (await fetch(`${base}/api/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) })).json() as { token: string };
const H = { authorization: `Bearer ${auth.token}` };
const api = async <T>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${base}${p}`, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j as T;
};
step("signed in with initData");

const form = new FormData();
form.append("file", new Blob([readFileSync(file)]), path.basename(file));
const up = await (await fetch(`${base}/api/documents/upload`, { method: "POST", headers: H, body: form })).json() as { documentId: string };
for (;;) {
  const d = await api<{ version: { status: string; pageCount: number } }>("GET", `/api/documents/${up.documentId}`);
  if (["ready", "partial"].includes(d.version.status)) { step(`document parsed: ${d.version.status}, ${d.version.pageCount} pages`); break; }
  if (d.version.status === "failed") throw new Error("document failed");
  await sleep(500);
}
const q = await api<{ quizId: string; jobId: string }>("POST", "/api/quizzes", { method: "from_source", documentIds: [up.documentId], settings: { count: 5 }, useAi: false, idempotencyKey: `smoke-q-${Date.now()}` });
for (;;) {
  const j = await api<{ status: string }>("GET", `/api/jobs/${q.jobId}`);
  if (j.status === "completed") break;
  if (j.status === "failed") throw new Error("quiz job failed");
  await sleep(500);
}
const ed = await api<{ questions: unknown[] }>("GET", `/api/quizzes/${q.quizId}/editor`);
step(`quiz generated: ${ed.questions.length} questions`);
const deck = await api<{ deckId: string; jobId: string }>("POST", "/api/decks", { settings: { topic: "Iqtisodiyot asoslari", slideCount: 12 }, documentIds: [up.documentId], useAi: false, idempotencyKey: `smoke-d-${Date.now()}` });
for (;;) {
  const j = await api<{ status: string }>("GET", `/api/jobs/${deck.jobId}`);
  if (j.status === "completed") break;
  if (j.status === "failed") throw new Error("deck job failed");
  await sleep(500);
}
const dd = await api<{ slides: unknown[] }>("GET", `/api/decks/${deck.deckId}`);
step(`deck generated: ${dd.slides.length} slides`);
for (const format of ["pptx", "pdf"] as const) {
  const ex = await api<{ exportId: string }>("POST", `/api/decks/${deck.deckId}/exports`, { format });
  for (;;) {
    const l = await api<{ items: { id: string; status: string; download: { url: string } | null; checks: { ok: boolean | null; slideCount: number | null } }[] }>("GET", `/api/decks/${deck.deckId}/exports`);
    const it = l.items.find((x) => x.id === ex.exportId)!;
    if (it.status === "ready") {
      const bin = Buffer.from(await (await fetch(`${base}${it.download!.url}`)).arrayBuffer());
      const magic = format === "pptx" ? bin.subarray(0, 2).toString() === "PK" : bin.subarray(0, 5).toString() === "%PDF-";
      if (!magic) throw new Error(`${format} download is not a valid file`);
      step(`${format.toUpperCase()} exported: ${bin.length} bytes, checks ok=${it.checks.ok}, slides=${it.checks.slideCount}`);
      break;
    }
    if (it.status === "failed") throw new Error(`${format} export failed`);
    await sleep(700);
  }
}
step("smoke test passed");
