import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { RoomHub } from "../src/rooms/hub";
import { signInitData } from "../src/auth/init-data";
import { createDocumentFromFile } from "../src/ingest/documents";
import { approveQuestions, createQuiz, getQuizForEditor, publishQuiz } from "../src/quiz/service";
import { getUserByTelegramId } from "../src/auth/users";
import { createTestDeps, makeUser, TEST_BOT_TOKEN } from "./helpers/deps";
import { fixture } from "./helpers/fixtures";
import { testWorker } from "./helpers/worker";
import { RoomClient } from "./helpers/ws-client";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
let hub: RoomHub;
let base = "";
let wsUrl = "";

beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
  hub = new RoomHub(deps);
  await hub.start();
  app = await buildApp(deps, { hub, logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws/rooms`;
});
afterAll(async () => {
  await hub.stop();
  await app.close();
  await cleanup();
});

async function login(id: number, name: string) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }) }, TEST_BOT_TOKEN);
  const r = await fetch(`${base}/api/auth/telegram`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData }) });
  return ((await r.json()) as { token: string }).token;
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function setupQuiz(hostTg: number) {
  const hostToken = await login(hostTg, "Host");
  const host = (await getUserByTelegramId(deps.sql, hostTg))!;
  const doc = await createDocumentFromFile(deps, { user: host, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
  await testWorker(deps).drain();
  const { quizId } = await createQuiz(deps, host, { method: "from_source", documentIds: [doc.documentId], settings: { count: 3 }, idempotencyKey: `room-quiz-${hostTg}` });
  await testWorker(deps).drain();
  const editor = await getQuizForEditor(deps, host, quizId);
  await approveQuestions(deps, host, quizId, editor.questions.map((q) => q.id));
  await publishQuiz(deps, host, quizId);
  const keys = new Map((await getQuizForEditor(deps, host, quizId)).questions.map((q) => [q.id, q.options!.find((o) => o.correct)!.id]));
  return { hostToken, quizId, keys };
}

describe("live room", () => {
  it("two real accounts join through one invite link and see the same question (acceptance 7); scoring is server-side (acceptance 8)", async () => {
    const { hostToken, quizId, keys } = await setupQuiz(900001);
    const created = await api(hostToken, "POST", "/api/rooms", { quizId, settings: { timePerQuestionSec: 20, showLeaderboard: true } });
    expect(created.status).toBe(200);
    const { roomId, startParam, inviteLink } = created.json as { roomId: string; startParam: string; inviteLink: string };
    expect(inviteLink).toBe(`https://t.me/talaba_test_bot?startapp=${startParam}`);
    expect(startParam).toMatch(/^r[A-Za-z0-9_-]{22}$/);
    expect(inviteLink).not.toMatch(/correct|answer|key/i);

    const t1 = await login(900101, "Malika");
    const t2 = await login(900102, "Jasur");
    for (const t of [t1, t2]) expect((await api(t, "POST", "/api/rooms/join", { inviteToken: startParam.slice(1) })).status).toBe(200);
    // joining the room does not open the quiz bank or the editor
    expect((await api(t1, "GET", `/api/quizzes/${quizId}/editor`)).status).toBe(404);
    expect((await api(t1, "GET", `/api/quizzes/${quizId}/preview`)).status).toBe(404);

    const hostC = new RoomClient(wsUrl, hostToken, roomId);
    const c1 = new RoomClient(wsUrl, t1, roomId);
    const c2 = new RoomClient(wsUrl, t2, roomId);
    await Promise.all([hostC.connect(), c1.connect(), c2.connect()]);
    await hostC.waitFor((s) => s.participants.length === 3);
    expect(await c1.host("start")).toEqual({ accepted: false, reason: "forbidden" }); // participants cannot drive the room
    expect((await hostC.host("start")).accepted).toBe(true);
    const s1 = await c1.waitFor((s) => s.status === "running" && !!s.question);
    const s2 = await c2.waitFor((s) => s.status === "running" && !!s.question);
    expect(s1.question!.id).toBe(s2.question!.id);
    expect(s1.question!.index).toBe(0);
    // no answer key or explanation reaches participants before reveal
    const rawBefore = c1.raw.join("\n");
    expect(rawBefore).not.toContain('"correctOptionIds"');
    expect(s1.reveal).toBeNull();

    const qid = s1.question!.id;
    const correct = keys.get(qid)!;
    const wrong = s2.question!.options.find((o) => o.id !== correct)!.id;
    // a forged answer to a different question, an unknown option and extra fields do nothing
    expect((await c1.send({ type: "answer", questionId: [...keys.keys()].find((k) => k !== qid)!, optionIds: [correct] })).reason).toBe("not_current_question");
    expect((await c1.answer(qid, ["00000000-0000-4000-8000-000000000000"])).reason).toBe("invalid_option");
    // client-supplied "points" is ignored by the schema; the server computes the score itself
    const forged = await c1.send({ type: "answer", questionId: qid, optionIds: [correct], points: 100000, isCorrect: true });
    expect(forged.accepted).toBe(true);
    expect((await c1.answer(qid, [correct])).reason).toBe("already_answered");
    expect((await c2.answer(qid, [wrong])).accepted).toBe(true);
    const mine = await c1.waitFor((s) => s.myAnswer?.questionId === qid);
    expect(mine.myAnswer!.optionIds).toEqual([correct]);

    expect((await hostC.host("reveal")).accepted).toBe(true);
    const rv = await c1.waitFor((s) => s.phase === "reveal");
    expect(rv.reveal!.correctOptionIds).toEqual([correct]);
    expect(rv.myScore).toEqual({ points: 100, correct: 1, answered: 1 });
    expect((await c2.waitFor((s) => s.phase === "reveal")).myScore).toEqual({ points: 0, correct: 0, answered: 1 });
    // answers after the question closed are refused
    expect((await c2.answer(qid, [correct])).reason).toBe("closed");

    // finish and compare leaderboard
    await hostC.host("finish");
    const fin = await c1.waitFor((s) => s.status === "finished");
    expect(fin.leaderboard!.map((r) => [r.name, r.points])).toEqual([["Malika", 100], ["Jasur", 0]]);
    const res = await api(t2, "GET", `/api/rooms/${roomId}/results`);
    expect(res.json.individual).toBeNull(); // per-student analysis is host-only
    expect((await api(hostToken, "GET", `/api/rooms/${roomId}/results`)).json.individual.length).toBe(2);
    for (const c of [hostC, c1, c2]) c.close();
  });

  it("rejects late answers by the server clock and restores state after reconnect; pauses when the host leaves (acceptance 9)", async () => {
    const { hostToken, quizId, keys } = await setupQuiz(900002);
    const { roomId, startParam } = (await api(hostToken, "POST", "/api/rooms", { quizId, settings: { timePerQuestionSec: 5, hostGraceSec: 5 } })).json as { roomId: string; startParam: string };
    const t1 = await login(900201, "Nodira");
    await api(t1, "POST", "/api/rooms/join", { inviteToken: startParam.slice(1) });
    const hostC = new RoomClient(wsUrl, hostToken, roomId);
    let c1 = new RoomClient(wsUrl, t1, roomId);
    await Promise.all([hostC.connect(), c1.connect()]);
    await hostC.host("start");
    const s = await c1.waitFor((x) => x.status === "running" && !!x.question);
    const qid = s.question!.id;
    await c1.answer(qid, [keys.get(qid)!]);
    // reconnect: the client restores the same question, its own accepted answer and score
    c1.close();
    c1 = new RoomClient(wsUrl, t1, roomId);
    const back = await c1.connect();
    expect(back.question!.id).toBe(qid);
    expect(back.myAnswer!.optionIds).toEqual([keys.get(qid)!]);
    // the deadline passes on the server -> question closes by itself; a late answer is refused
    const closed = await c1.waitFor((x) => x.phase === "reveal", 9000);
    expect(closed.reveal!.correctOptionIds).toEqual([keys.get(qid)!]);
    await hostC.host("next");
    const q2 = await c1.waitFor((x) => x.phase === "question" && x.question!.index === 1);
    await deps.sql`update rooms set deadline_at = clock_timestamp() - interval '1 second' where id = ${roomId}`;
    expect((await c1.answer(q2.question!.id, [keys.get(q2.question!.id)!])).reason).toBe("time_up");
    await hostC.host("finish").catch(() => {});

    // host leaves a running room -> automatic pause after the grace period
    const room2 = (await api(hostToken, "POST", "/api/rooms", { quizId, settings: { timePerQuestionSec: 60, hostGraceSec: 5 } })).json as { roomId: string; startParam: string };
    await api(t1, "POST", "/api/rooms/join", { inviteToken: room2.startParam.slice(1) });
    const h2 = new RoomClient(wsUrl, hostToken, room2.roomId);
    const p2 = new RoomClient(wsUrl, t1, room2.roomId);
    await Promise.all([h2.connect(), p2.connect()]);
    await h2.host("start");
    await p2.waitFor((x) => x.status === "running");
    h2.close();
    const paused = await p2.waitFor((x) => x.status === "paused", 9000);
    expect(paused.hostConnected).toBe(false);
    expect(paused.pausedRemainingMs).toBeGreaterThan(40_000);
    for (const c of [hostC, c1, p2]) c.close();
  }, 30_000);

  it("revoked or expired invite links stop working (acceptance 14, part)", async () => {
    const { hostToken, quizId } = await setupQuiz(900003);
    const { roomId, startParam } = (await api(hostToken, "POST", "/api/rooms", { quizId })).json as { roomId: string; startParam: string };
    const t1 = await login(900301, "Otabek");
    await api(hostToken, "DELETE", `/api/rooms/${roomId}/invite`);
    expect((await api(t1, "POST", "/api/rooms/join", { inviteToken: startParam.slice(1) })).json.error.code).toBe("invite_invalid");
    const rotated = (await api(hostToken, "POST", `/api/rooms/${roomId}/invite`)).json as { inviteToken: string };
    expect((await api(t1, "POST", "/api/rooms/join", { inviteToken: rotated.inviteToken })).status).toBe(200);
    await deps.sql`update invitations set expires_at = now() - interval '1 minute' where target_id = ${roomId}`;
    const t2 = await login(900302, "Sevara");
    expect((await api(t2, "POST", "/api/rooms/join", { inviteToken: rotated.inviteToken })).status).toBe(410);
    // non-members cannot read room state by id
    expect((await api(t2, "GET", `/api/rooms/${roomId}`)).status).toBe(404);
    void makeUser;
  });
});
