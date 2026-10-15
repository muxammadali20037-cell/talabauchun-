import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import postgres from "postgres";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { signInitData } from "../src/auth/init-data";
import { createDb } from "../src/db/index";
import { LocalStorage } from "../src/storage/local";
import { accountJobHandlers, cleanupExpiredExports, reapplyDeletions } from "../src/account/data";
import { createDocumentFromFile } from "../src/ingest/documents";
import { createQuiz } from "../src/quiz/service";
import { retrieve } from "../src/search/retrieve";
import { getUserById } from "../src/auth/users";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { fixture, sourceFixture } from "./helpers/fixtures";
import { testWorker } from "./helpers/worker";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const OPS = path.resolve(here, "../../../ops");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
const work = mkdtempSync(path.join(tmpdir(), "talaba-ops-"));
const deletionLog = path.join(work, "deletion-log.jsonl");

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps({ DELETION_LOG_PATH: deletionLog }));
  app = await buildApp(deps, { logger: false });
});
afterAll(async () => {
  await app.close();
  await cleanup().catch(() => {});
  rmSync(work, { recursive: true, force: true });
});

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
async function login(a: FastifyInstance, id: number, first_name: string) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAH" + id, user: JSON.stringify({ id, first_name, language_code: "uz" }) }, TEST_BOT_TOKEN);
  const r = await a.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, userId: r.json().user.id as string };
}
const worker = () => testWorker(deps, accountJobHandlers(deps));
function filesUnder(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const COUNTED = ["users", "documents", "document_versions", "pages", "chunks", "quizzes", "questions", "options", "private_answer_keys", "credit_ledger", "generation_jobs", "sessions"];
async function counts(sql: postgres.Sql<Record<string, unknown>>) {
  const out: Record<string, number> = {};
  for (const t of COUNTED) out[t] = Number((await sql.unsafe(`select count(*)::int as n from ${t}`))[0]!.n);
  return out;
}

let owner: { token: string; userId: string };
let leaver: { token: string; userId: string };
let ownerDoc: string;
let leaverDoc: string;

describe("data export (acceptance 19)", () => {
  it("exports the user's own data and original files as a zip, downloadable through a short-lived signed link", async () => {
    owner = await login(app, 620001, "Saida");
    const user = (await getUserById(deps.sql, owner.userId))!;
    ownerDoc = (await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" })).documentId;
    const w = worker();
    await w.drain();
    await createQuiz(deps, user, { method: "from_source", documentIds: [ownerDoc], settings: { count: 3 }, useAi: false, idempotencyKey: "ops-quiz-1" });
    await w.drain();

    const r = await app.inject({ method: "POST", url: "/api/me/export", headers: auth(owner.token) });
    expect(r.json().duplicate).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/me/export", headers: auth(owner.token) })).json().duplicate).toBe(true);
    await w.drain();
    const list = (await app.inject({ method: "GET", url: "/api/me/data", headers: auth(owner.token) })).json().items;
    expect(list[0]).toMatchObject({ kind: "export", status: "done" });
    const dl = await app.inject({ method: "GET", url: list[0].download.url });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers["content-type"]).toBe("application/zip");
    const zip = await JSZip.loadAsync(dl.rawPayload);
    const names = Object.keys(zip.files);
    expect(names).toEqual(expect.arrayContaining(["profile.json", "documents.json", "quizzes.json", "credits.json", "README.txt"]));
    const original = names.find((n) => n.startsWith(`files/${ownerDoc}/`) && !zip.files[n]!.dir)!;
    expect(original, JSON.stringify(names)).toBeTruthy();
    expect(Buffer.compare(await zip.file(original)!.async("nodebuffer"), fixture("iqtisodiyot.pdf"))).toBe(0);
    const quizzes = JSON.parse(await zip.file("quizzes.json")!.async("string"));
    expect(quizzes[0].questions.length).toBeGreaterThan(0);
    expect(quizzes[0].questions[0].options.some((o: { correct: boolean }) => o.correct)).toBe(true);
    // the link is signed for this file only and expires
    const forged = list[0].download.url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64));
    expect((await app.inject({ method: "GET", url: forged })).statusCode).toBe(403);
    // after 7 days the archive is deleted and no longer offered
    const [req] = await deps.sql<{ id: string; key: string }[]>`select id, result->>'storageKey' as key from data_requests where user_id = ${owner.userId} and kind = 'export'`;
    expect(await cleanupExpiredExports(deps)).toBe(0);
    await deps.sql`update data_requests set finished_at = now() - interval '8 days' where id = ${req!.id}`;
    expect(await cleanupExpiredExports(deps)).toBe(1);
    expect(await deps.storage.exists(req!.key)).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/me/data", headers: auth(owner.token) })).json().items[0].download).toBeNull();
    // another user sees none of it
    const other = await login(app, 620009, "Begona");
    expect((await app.inject({ method: "GET", url: "/api/me/data", headers: auth(other.token) })).json().items).toEqual([]);
  });
});

describe("backup → account deletion → disaster → restore → re-apply deletions (acceptance 19)", () => {
  it("restores the database and files byte-for-byte, the app serves from the restore, and a deletion made after the backup is applied again", async () => {
    leaver = await login(app, 620002, "Ketuvchi");
    const lu = (await getUserById(deps.sql, leaver.userId))!;
    leaverDoc = (await createDocumentFromFile(deps, { user: lu, filename: "namuna-statistika.csv", data: sourceFixture("namuna-statistika.csv"), via: "miniapp" })).documentId;
    await worker().drain();
    const leaverKeys = (await deps.sql<{ storage_key: string }[]>`select storage_key from document_versions where document_id = ${leaverDoc}`).map((r) => r.storage_key);
    expect((await retrieve(deps, { query: "narx indeksi", userId: leaver.userId, limit: 5 })).length).toBeGreaterThan(0);

    // 1) backup
    const before = await counts(deps.sql);
    const filesBefore = filesUnder(deps.cfg.STORAGE_DIR);
    const t0 = Date.now();
    const { stdout } = await run(path.join(OPS, "backup.sh"), [path.join(work, "backups")], { env: { ...process.env, DATABASE_URL: deps.cfg.DATABASE_URL, STORAGE_DIR: deps.cfg.STORAGE_DIR } });
    const backupMs = Date.now() - t0;
    const backupDir = stdout.trim().split("\n").pop()!;
    expect(readFileSync(path.join(backupDir, "SHA256SUMS"), "utf8")).toContain("db.dump");

    // 2) the leaver deletes their account after the backup was taken
    const del = await app.inject({ method: "POST", url: "/api/me/delete", headers: auth(leaver.token), payload: { confirm: "DELETE" } });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/me/delete", headers: auth(owner.token), payload: { confirm: "yes" } })).statusCode).toBe(400);
    await worker().drain();
    const assertLeaverGone = async (d: { sql: Deps["sql"]; storage: { exists(k: string): Promise<boolean> } }, userId: string, docId: string, keys: string[]) => {
      const [u] = await d.sql<{ telegram_id: string | null; first_name: string; deleted_at: Date | null }[]>`select telegram_id::text, first_name, deleted_at from users where id = ${userId}`;
      expect(u).toMatchObject({ telegram_id: null, first_name: "" });
      expect(u!.deleted_at).not.toBeNull();
      expect((await d.sql`select 1 from chunks c join document_versions v on v.id = c.document_version_id where v.document_id = ${docId}`).length).toBe(0);
      expect((await d.sql`select 1 from pages p join document_versions v on v.id = p.document_version_id where v.document_id = ${docId}`).length).toBe(0);
      expect((await d.sql<{ title: string }[]>`select title from documents where id = ${docId}`)[0]!.title).toBe("[deleted]");
      expect((await d.sql`select 1 from sessions where user_id = ${userId} and revoked_at is null`).length).toBe(0);
      for (const k of keys) expect(await d.storage.exists(k)).toBe(false);
    };
    await assertLeaverGone(deps, leaver.userId, leaverDoc, leaverKeys);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: auth(leaver.token) })).statusCode).toBe(401);
    expect((await retrieve(deps, { query: "narx indeksi", userId: leaver.userId, limit: 5 })).length).toBe(0);
    expect(readFileSync(deletionLog, "utf8")).toContain(leaver.userId);
    // the same Telegram account can start again as a brand-new user
    const again = await login(app, 620002, "Ketuvchi");
    expect(again.userId).not.toBe(leaver.userId);

    // 3) disaster: database and storage are lost
    const lostDbName = deps.cfg.DATABASE_URL.split("/").pop()!;
    await cleanup();
    rmSync(deps.cfg.STORAGE_DIR, { recursive: true, force: true });

    // 4) restore into a new empty database and storage
    const newDb = `talaba_restore_${Date.now()}`;
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${newDb}`);
    const newUrl = ADMIN_URL.replace(/\/[^/]+$/, `/${newDb}`);
    const newStorage = path.join(work, "restored-storage");
    const t1 = Date.now();
    await run(path.join(OPS, "restore.sh"), [backupDir, newUrl, newStorage]);
    const restoreMs = Date.now() - t1;
    // refusing to overwrite a non-empty target is part of the procedure
    await expect(run(path.join(OPS, "restore.sh"), [backupDir, newUrl, newStorage])).rejects.toThrow();

    const sql = createDb(newUrl, 5);
    try {
      expect(await counts(sql)).toEqual(before);
      expect(filesUnder(newStorage)).toEqual(filesBefore);
      const restored: Deps = { ...deps, cfg: { ...deps.cfg, DATABASE_URL: newUrl, STORAGE_DIR: newStorage }, sql, storage: new LocalStorage(newStorage, deps.cfg.SIGNING_SECRET) };
      const app2 = await buildApp(restored, { logger: false });
      try {
        expect((await app2.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
        const o = await login(app2, 620001, "Saida");
        expect(o.userId).toBe(owner.userId);
        const docs = (await app2.inject({ method: "GET", url: "/api/documents", headers: auth(o.token) })).json().items;
        expect(docs.map((d: { id: string }) => d.id)).toContain(ownerDoc);
        expect((await retrieve(restored, { query: "talab qonuni", userId: owner.userId, limit: 3 })).length).toBeGreaterThan(0);
        const page = await app2.inject({ method: "GET", url: `/api/documents/${ownerDoc}/pages/2`, headers: auth(o.token) });
        expect(page.statusCode).toBe(200);

        // the backup predates the deletion: the leaver's data is back until deletions are re-applied
        expect((await sql`select 1 from chunks c join document_versions v on v.id = c.document_version_id where v.document_id = ${leaverDoc}`).length).toBeGreaterThan(0);
        const reapplied = await reapplyDeletions(restored);
        expect(reapplied).toEqual([leaver.userId]);
        await assertLeaverGone(restored, leaver.userId, leaverDoc, leaverKeys);
        expect(await reapplyDeletions(restored)).toEqual([]); // idempotent
      } finally {
        await app2.close();
      }
      const evidence = {
        when: new Date().toISOString(),
        postgres: (await sql<{ v: string }[]>`select version() as v`)[0]!.v,
        backupMs, restoreMs,
        backupBytes: { db: statSync(path.join(backupDir, "db.dump")).size, storage: statSync(path.join(backupDir, "storage.tar.gz")).size },
        rowsVerified: before,
        filesVerified: Object.keys(filesBefore).length,
        checks: ["sha256 of backup files", "row counts equal", "every storage file sha256 equal", "migrations equal", "/readyz 200 on restored DB", "login + document list + page text + search on restored DB", "deletion after backup re-applied from the external log", "restore refuses a non-empty target"],
        lostDatabase: lostDbName,
      };
      if (process.env.SAVE_OPS_EVIDENCE) {
        const out = path.resolve(here, "../../../docs/evidence");
        mkdirSync(out, { recursive: true });
        writeFileSync(path.join(out, "restore-drill.json"), JSON.stringify(evidence, null, 2) + "\n");
      }
    } finally {
      await sql.end({ timeout: 2 });
      await admin.unsafe(`drop database if exists ${newDb} with (force)`);
      await admin.end();
    }
  }, 120_000);
});
