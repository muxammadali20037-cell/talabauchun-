/**
 * Quality benchmark (master prompt §23, "etalon toʻplam"): three kinds of permitted material —
 * a text textbook, a scanned copy (OCR) and a statistics table — plus the user-questions path.
 * Runs the real pipeline on a throw-away database and writes:
 *   docs/evidence/quality/etalon-<mode>.csv   one row per question, with empty reviewer columns
 *   docs/evidence/quality/summary-<mode>.json automatic metrics (evidence, checks, review state)
 * Reviewers fill wrong_key / ambiguous / unsupported_evidence (1/0) in the CSV; scripts/score-review.ts
 * turns that into rates. Mode is "ai" when AI_PROVIDER=anthropic + ANTHROPIC_API_KEY are set, else "extractive".
 * Usage: tsx scripts/eval-quality.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { loadConfig } from "../src/config";
import { consoleLogger, createDeps } from "../src/bootstrap";
import { migrate } from "../src/db/migrate";
import { upsertTelegramUser, type UserRow } from "../src/auth/users";
import { createDocumentFromFile } from "../src/ingest/documents";
import { createQuiz, getQuizForEditor } from "../src/quiz/service";
import { createFactsFromTable, documentTables, quizFromFacts } from "../src/study/stats";
import { jobHandlers } from "../src/jobs/handlers";
import { JobWorker } from "../src/jobs/queue";
import type { Deps } from "../src/deps";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "../test/fixtures");
const OUT = path.resolve(here, "../../../docs/evidence/quality");
const ADMIN = process.env.EVAL_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

const dbName = `talaba_eval_${Date.now()}`;
const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
await admin.unsafe(`create database ${dbName}`);
const cfg = loadConfig({ ...process.env, NODE_ENV: "development", DATABASE_URL: ADMIN.replace(/\/[^/]+$/, `/${dbName}`), STORAGE_DIR: path.join(tmpdir(), dbName), LOG_LEVEL: "silent" } as NodeJS.ProcessEnv);
const deps: Deps = createDeps(cfg, consoleLogger("silent"));
const mode = deps.ai ? "ai" : "extractive";

type Row = Record<string, string | number>;
const rows: Row[] = [];
const summary: Record<string, unknown> = { mode, models: deps.ai ? { strong: cfg.AI_MODEL_STRONG, fast: cfg.AI_MODEL_FAST } : null, date: new Date().toISOString(), materials: {} };

try {
  await migrate(deps.sql);
  const user = await upsertTelegramUser(deps.sql, cfg, { id: 900000001, first_name: "Eval", language_code: "uz" }, { privateChat: true });
  await deps.sql`insert into credit_ledger (user_id, entry_type, amount, reason, idempotency_key) values (${user.id}, 'adjust', 100000, 'eval', ${"eval:" + dbName})`;
  const worker = new JobWorker(deps.sql, jobHandlers(deps), { concurrency: 1, leaseSec: 120 });

  const upload = async (file: string) => {
    const d = await createDocumentFromFile(deps, { user, filename: path.basename(file), data: readFileSync(file), via: "api" });
    await worker.drain();
    const [v] = await deps.sql<{ status: string; pages_ok: number; pages_failed: number; pages_low_conf: number; page_count: number }[]>`
      select v.status, v.pages_ok, v.pages_failed, v.pages_low_conf, v.page_count from documents d join document_versions v on v.id = d.current_version_id where d.id = ${d.documentId}`;
    return { id: d.documentId, ingest: v };
  };
  const collect = async (material: string, method: string, quizId: string, requested: number, ingest: unknown) => {
    const ed = await getQuizForEditor(deps, user, quizId);
    const qs = ed.questions as unknown as { text: string; status: string; generator: string; evidenceStatus: string; options: { text: string; correct?: boolean }[]; evidence?: { quote: string; where: string }; checks?: { rule: string; result: string }[] }[];
    const failsByRule: Record<string, number> = {};
    const warnsByRule: Record<string, number> = {};
    for (const q of qs) {
      for (const c of q.checks ?? []) {
        if (c.result === "fail") failsByRule[c.rule] = (failsByRule[c.rule] ?? 0) + 1;
        if (c.result === "warn") warnsByRule[c.rule] = (warnsByRule[c.rule] ?? 0) + 1;
      }
      rows.push({
        material, method, status: q.status, generator: q.generator, evidence_status: q.evidenceStatus,
        question: q.text,
        options: q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o.text}`).join(" | "),
        key: q.options.map((o, i) => (o.correct ? String.fromCharCode(65 + i) : "")).filter(Boolean).join(","),
        evidence_where: q.evidence?.where ?? "", evidence_quote: q.evidence?.quote ?? "",
        auto_fails: (q.checks ?? []).filter((c) => c.result === "fail").map((c) => c.rule).join(","),
        auto_warns: (q.checks ?? []).filter((c) => c.result === "warn").map((c) => c.rule).join(","),
        wrong_key: "", ambiguous: "", unsupported_evidence: "", reviewer_notes: "",
      });
    }
    (summary.materials as Record<string, unknown>)[`${material}/${method}`] = {
      ingest, requested, produced: qs.length,
      evidenceVerified: qs.filter((q) => q.evidenceStatus === "verified").length,
      needsReview: qs.filter((q) => q.status === "needs_review").length,
      readyToApprove: qs.filter((q) => q.status === "draft").length,
      failsByRule, warnsByRule,
      // where the correct option sits (A, B, C, D …): a quality smell if it is always the same
      keyPositions: qs.reduce<Record<string, number>>((acc, q) => {
        const i = q.options.findIndex((o) => o.correct);
        if (i >= 0) acc[String.fromCharCode(65 + i)] = (acc[String.fromCharCode(65 + i)] ?? 0) + 1;
        return acc;
      }, {}),
      note: ed.version?.generation_note ?? null,
    };
  };

  const book = await upload(path.join(FIX, "generated/iqtisodiyot.pdf"));
  let q = await createQuiz(deps, user, { method: "from_source", documentIds: [book.id], settings: { count: 15 }, useAi: !!deps.ai, idempotencyKey: `eval-book-${dbName}` });
  await worker.drain();
  await collect("textbook", "from_source", q.quizId, 15, book.ingest);
  q = await createQuiz(deps, user, { method: "from_questions", documentIds: [book.id], questionsText: readFileSync(path.join(FIX, "source/savollar.txt"), "utf8"), settings: {}, useAi: !!deps.ai, idempotencyKey: `eval-qs-${dbName}` });
  await worker.drain();
  await collect("textbook", "from_questions", q.quizId, readFileSync(path.join(FIX, "source/savollar.txt"), "utf8").split("\n").filter((l) => l.trim()).length, book.ingest);

  const scan = await upload(path.join(FIX, "generated/iqtisodiyot-skan.pdf"));
  q = await createQuiz(deps, user, { method: "from_source", documentIds: [scan.id], settings: { count: 10 }, useAi: !!deps.ai, idempotencyKey: `eval-scan-${dbName}` });
  await worker.drain();
  await collect("scan", "from_source", q.quizId, 10, scan.ingest);

  const table = await upload(path.join(FIX, "source/namuna-statistika.csv"));
  const t = (await documentTables(deps, user as UserRow, table.id))[0]!;
  await createFactsFromTable(deps, user, { documentId: table.id, sheet: t.sheet, labelColumn: 0, valueColumn: 1, indicator: t.columns[1]!, unit: "indeks" });
  const sq = await quizFromFacts(deps, user, table.id, t.columns[1]!, "uz");
  await collect("statistics", "from_table", sq.quizId, sq.questions, table.ingest);

  mkdirSync(OUT, { recursive: true });
  const cols = Object.keys(rows[0]!);
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  writeFileSync(path.join(OUT, `etalon-${mode}.csv`), "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] ?? "")).join(","))].join("\n") + "\n");
  writeFileSync(path.join(OUT, `summary-${mode}.json`), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await deps.sql.end({ timeout: 2 });
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.end();
}
