/**
 * Acceptance 10 — baseline load test for one live room.
 * Usage: BASE_URL=http://127.0.0.1:8090 DATABASE_URL=… PARTICIPANTS=100 tsx scripts/load-room.ts
 * Creates a host + N participant accounts (sessions created directly in the DB),
 * a published quiz from the fixture book, then drives a real room over HTTP +
 * WebSocket and reports p50/p95/p99 for join, answer-ack and REST latency.
 */
import { cpus, totalmem } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { consoleLogger, createDeps } from "../src/bootstrap";
import { upsertTelegramUser } from "../src/auth/users";
import { createSession } from "../src/auth/sessions";
import { createDocumentFromFile } from "../src/ingest/documents";
import { JobWorker } from "../src/jobs/queue";
import { jobHandlers } from "../src/jobs/handlers";
import { approveQuestions, createQuiz, getQuizForEditor, publishQuiz } from "../src/quiz/service";
import { RoomClient } from "../test/helpers/ws-client";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8090";
const WS = BASE.replace(/^http/, "ws") + "/ws/rooms";
const N = Number(process.env.PARTICIPANTS ?? 100);
const QUESTIONS = Number(process.env.QUESTIONS ?? 3);

const cfg = loadConfig({ ...process.env, LOG_LEVEL: "silent" });
const deps = createDeps(cfg, consoleLogger("silent"));

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : NaN;
}
const summary = (xs: number[]) => ({ n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), p99: Math.round(pct(xs, 99)), max: Math.round(Math.max(...xs)) });

async function main() {
  const runTag = Date.now() % 1_000_000;
  const host = await upsertTelegramUser(deps.sql, cfg, { id: 5_000_000_000 + runTag, first_name: "LoadHost" }, { privateChat: true });
  const hostToken = (await createSession(deps.sql, cfg, host.id, "dev")).token;
  const doc = await createDocumentFromFile(deps, { user: host, filename: "iqtisodiyot.pdf", data: readFileSync(path.join(here, "../test/fixtures/generated/iqtisodiyot.pdf")), via: "api" });
  const worker = new JobWorker(deps.sql, jobHandlers(deps), { concurrency: 1, leaseSec: 60 });
  await worker.drain();
  const { quizId } = await createQuiz(deps, host, { method: "from_source", documentIds: [doc.documentId], settings: { count: QUESTIONS }, idempotencyKey: `load-${runTag}` });
  await worker.drain();
  const ed = await getQuizForEditor(deps, host, quizId);
  await approveQuestions(deps, host, quizId, ed.questions.map((q) => q.id));
  await publishQuiz(deps, host, quizId);
  const keys = new Map((await getQuizForEditor(deps, host, quizId)).questions.map((q) => [q.id, q.options!.find((o) => o.correct)!.id]));

  const http = async (token: string, method: string, p: string, body?: unknown) => {
    const t0 = performance.now();
    const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await r.json();
    return { ms: performance.now() - t0, status: r.status, json };
  };
  const room = await http(hostToken, "POST", "/api/rooms", { quizId, settings: { timePerQuestionSec: 30, showLeaderboard: true } });
  const { roomId, inviteToken } = room.json as { roomId: string; inviteToken: string };

  const tokens: string[] = [];
  for (let i = 0; i < N; i++) {
    const u = await upsertTelegramUser(deps.sql, cfg, { id: 5_100_000_000 + runTag * 1000 + i, first_name: `P${i}` });
    tokens.push((await createSession(deps.sql, cfg, u.id, "dev")).token);
  }
  const joins = await Promise.all(tokens.map((t) => http(t, "POST", "/api/rooms/join", { inviteToken })));
  const joinMs = joins.map((j) => j.ms);
  if (joins.some((j) => j.status !== 200)) throw new Error("join failed: " + JSON.stringify(joins.find((j) => j.status !== 200)?.json));

  const hostC = new RoomClient(WS, hostToken, roomId);
  await hostC.connect();
  const clients = tokens.map((t) => new RoomClient(WS, t, roomId));
  const tConn = performance.now();
  await Promise.all(clients.map((c) => c.connect()));
  const connectAllMs = performance.now() - tConn;
  await hostC.waitFor((s) => s.participants.filter((p) => p.connected).length === N + 1, 30_000);

  const ackMs: number[] = [];
  const fanoutMs: number[] = [];
  const rejected: string[] = [];
  for (let qi = 0; qi < QUESTIONS; qi++) {
    const t0 = performance.now();
    await hostC.host(qi === 0 ? "start" : "next");
    const states = await Promise.all(clients.map((c) => c.waitFor((s) => s.phase === "question" && s.question?.index === qi, 30_000).then((s) => ({ s, at: performance.now() }))));
    fanoutMs.push(...states.map((x) => x.at - t0));
    await Promise.all(
      clients.map(async (c, i) => {
        await new Promise((r) => setTimeout(r, Math.random() * 2000));
        const q = c.state!.question!;
        const pick = i % 3 === 0 ? q.options.find((o) => o.id !== keys.get(q.id))!.id : keys.get(q.id)!;
        const a0 = performance.now();
        const ack = await c.answer(q.id, [pick]);
        ackMs.push(performance.now() - a0);
        if (!ack.accepted) rejected.push(ack.reason ?? "?");
      }),
    );
    await hostC.host("reveal");
    await hostC.waitFor((s) => s.phase === "reveal", 30_000);
  }
  await hostC.host("finish");
  const final = await hostC.waitFor((s) => s.status === "finished", 30_000);

  // REST baseline under concurrency: N clients × 10 GET /api/me
  const restMs: number[] = [];
  await Promise.all(tokens.map(async (t) => { for (let k = 0; k < 10; k++) restMs.push((await http(t, "GET", "/api/me")).ms); }));
  const stateMs: number[] = [];
  await Promise.all(tokens.slice(0, 50).map(async (t) => { for (let k = 0; k < 5; k++) stateMs.push((await http(t, "GET", `/api/rooms/${roomId}`)).ms); }));

  // integrity: every accepted answer was stored exactly once, points match correctness
  const [db] = await deps.sql<{ answers: number; dupes: number; wrongPoints: number }[]>`
    select count(*)::int as answers,
      (select count(*)::int from (select 1 from room_answers where room_id = ${roomId} group by question_id, user_id having count(*) > 1) d) as dupes,
      count(*) filter (where (is_correct and points <> 100) or (not is_correct and points <> 0))::int as "wrongPoints"
    from room_answers where room_id = ${roomId}`;

  for (const c of [hostC, ...clients]) c.close();
  const [pg] = await deps.sql<{ version: string; fsync: string; sync: string }[]>`select version(), current_setting('fsync') as fsync, current_setting('synchronous_commit') as sync`;
  const result = {
    when: new Date().toISOString(),
    environment: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGb: Math.round(totalmem() / 1e9), node: process.version, network: "loopback (same container)", server: "single Node process (tsx), PostgreSQL local", postgres: pg!.version.split(" on ")[0], fsync: pg!.fsync, synchronousCommit: pg!.sync },
    participants: N,
    questions: QUESTIONS,
    joinHttpMs: summary(joinMs),
    wsConnectAllMs: Math.round(connectAllMs),
    questionFanoutMs: summary(fanoutMs),
    answerAckMs: summary(ackMs),
    restGetMeMs: summary(restMs),
    restRoomStateMs: summary(stateMs),
    rejectedAnswers: rejected.length,
    integrity: db,
    leaderboardSize: final.leaderboard?.length ?? 0,
    target: "pilot target p95 < 1000 ms for API and answer confirmation (not a guarantee)",
  };
  mkdirSync(path.join(here, "../../../docs/evidence"), { recursive: true });
  writeFileSync(path.join(here, "../../../docs/evidence/load-room.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await deps.sql.end();
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  await deps.sql.end();
  process.exit(1);
});
