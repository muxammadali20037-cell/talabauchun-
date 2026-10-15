import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { createSession } from "../src/auth/sessions";
import { createDocumentFromFile, createDocumentFromText } from "../src/ingest/documents";
import { approveQuestions, createQuiz, getQuizForEditor, publishQuiz } from "../src/quiz/service";
import { answerAttempt, attemptResults, attemptState, startAttempt } from "../src/quiz/practice";
import { sm2 } from "../src/study/flashcards";
import { buildSchedule, dueInstant, localDate } from "../src/study/plans";
import { compute } from "../src/study/stats";
import { startAssignment, assignmentView, closeExpiredAssignments } from "../src/rooms/assignment";
import { createRoom, joinRoom, loadSharedState, submitAnswer, hostAction, teamStandings, setCoHost, setPresence, pauseIfHostAway } from "../src/rooms/service";
import { createTestDeps, makeUser } from "./helpers/deps";
import { fixture, sourceFixture } from "./helpers/fixtures";
import { testWorker } from "./helpers/worker";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
  app = await buildApp(deps, { logger: false });
});
afterAll(async () => {
  await app.close();
  await cleanup();
});
const auth = async (u: Awaited<ReturnType<typeof makeUser>>) => ({ authorization: `Bearer ${(await createSession(deps.sql, deps.cfg, u.id, "dev")).token}` });

async function bookAndQuiz(user: Awaited<ReturnType<typeof makeUser>>, key: string) {
  const doc = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
  await testWorker(deps).drain();
  const { quizId } = await createQuiz(deps, user, { method: "from_source", documentIds: [doc.documentId], settings: { count: 5 }, idempotencyKey: key });
  await testWorker(deps).drain();
  const ed = await getQuizForEditor(deps, user, quizId);
  await approveQuestions(deps, user, quizId, ed.questions.map((q) => q.id));
  await publishQuiz(deps, user, quizId);
  return { documentId: doc.documentId, quizId, questions: (await getQuizForEditor(deps, user, quizId)).questions };
}

describe("flashcards + spaced repetition", () => {
  it("SM-2 grows intervals on success and resets on a lapse", () => {
    let s = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };
    s = sm2(s, 5);
    expect(s.intervalDays).toBe(1);
    s = sm2(s, 4);
    expect(s.intervalDays).toBe(6);
    s = sm2(s, 4);
    expect(s.intervalDays).toBe(16); // 6 × ease 2.6
    s = sm2(s, 1);
    expect(s).toMatchObject({ intervalDays: 1, reps: 0, lapses: 1 });
    expect(s.ease).toBeGreaterThanOrEqual(1.3);
  });
  it("creates sourced cards from a document and from a quiz, and schedules reviews", async () => {
    const user = await makeUser(deps);
    const { documentId, quizId } = await bookAndQuiz(user, "fc-quiz-1");
    const h = await auth(user);
    const fromDoc = (await app.inject({ method: "POST", url: `/api/flashcards/from-document/${documentId}`, headers: h })).json();
    expect(fromDoc.created).toBeGreaterThanOrEqual(4);
    const again = (await app.inject({ method: "POST", url: `/api/flashcards/from-document/${documentId}`, headers: h })).json();
    expect(again.created).toBe(0); // idempotent
    const fromQuiz = (await app.inject({ method: "POST", url: `/api/flashcards/from-quiz/${quizId}`, headers: h })).json();
    expect(fromQuiz.created).toBeGreaterThanOrEqual(3);
    const due = (await app.inject({ method: "GET", url: `/api/flashcards?due=1`, headers: h })).json();
    expect(due.due).toBe(fromDoc.created + fromQuiz.created);
    const card = due.items.find((c: { front: string }) => c.front === "Inflyatsiya");
    expect(card.source.where).toMatch(/sahifa 3/);
    const r = (await app.inject({ method: "POST", url: `/api/flashcards/${card.id}/review`, headers: h, payload: { grade: 5 } })).json();
    expect(new Date(r.dueAt).getTime()).toBeGreaterThan(Date.now() + 20 * 3600_000);
    const after = (await app.inject({ method: "GET", url: `/api/flashcards?due=1`, headers: h })).json();
    expect(after.due).toBe(due.due - 1);
  });
});

describe("mistakes notebook", () => {
  it("lists wrong answers with the correct answer and source, and drops them once answered correctly", async () => {
    const user = await makeUser(deps);
    const { quizId, questions } = await bookAndQuiz(user, "mk-quiz-1");
    const key = new Map(questions.map((q) => [q.id, q.options!.find((o) => o.correct)!.id]));
    const { attemptId } = await startAttempt(deps, user, quizId, "app_practice");
    let st;
    while ((st = await attemptState(deps, user, attemptId)).question) {
      const wrong = st.question.options.find((o) => o.id !== key.get(st!.question!.id))!;
      await answerAttempt(deps, user, attemptId, st.question.id, [wrong.id]);
    }
    const h = await auth(user);
    const m = (await app.inject({ method: "GET", url: "/api/mistakes", headers: h })).json();
    expect(m.items).toHaveLength(questions.length);
    expect(m.items[0].correct.length).toBe(1);
    expect(m.items[0].source.where).toMatch(/sahifa/);
    // fix one mistake
    const a2 = await startAttempt(deps, user, quizId, "app_practice");
    const s2 = await attemptState(deps, user, a2.attemptId);
    await answerAttempt(deps, user, a2.attemptId, s2.question!.id, [key.get(s2.question!.id)!]);
    const m2 = (await app.inject({ method: "GET", url: "/api/mistakes", headers: h })).json();
    expect(m2.items).toHaveLength(questions.length - 1);
  });
});

describe("exam plan", () => {
  it("spreads topics until the exam, keeps a review day, stores UTC and respects the time zone", () => {
    const tasks = buildSchedule({ today: "2026-10-15", examDate: "2026-10-20", dailyMinutes: 60, topics: [{ name: "Talab", weight: 1 }, { name: "Inflyatsiya", weight: 2 }] });
    const days = [...new Set(tasks.map((t) => t.day))];
    expect(days).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(tasks.at(-1)).toMatchObject({ day: "2026-10-19", kind: "review" });
    const inf = tasks.filter((t) => t.topic === "Inflyatsiya").reduce((s, t) => s + t.minutes, 0);
    const tal = tasks.filter((t) => t.topic === "Talab").reduce((s, t) => s + t.minutes, 0);
    expect(inf).toBeGreaterThan(tal);
    for (const d of days.slice(0, -1)) expect(tasks.filter((t) => t.day === d).reduce((s, t) => s + t.minutes, 0)).toBeLessThanOrEqual(60);
    expect(dueInstant("2026-10-16", "Asia/Tashkent").toISOString()).toBe("2026-10-16T15:00:00.000Z");
    expect(localDate(new Date("2026-10-16T20:30:00Z"), "Asia/Tashkent")).toBe("2026-10-17");
  });
  it("never auto-completes tasks and moves missed ones forward without deleting them", async () => {
    const user = await makeUser(deps);
    const h = await auth(user);
    const exam = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const { planId } = (await app.inject({ method: "POST", url: "/api/plans", headers: h, payload: { title: "Iqtisod imtihoni", examDate: exam, dailyMinutes: 60, topics: [{ name: "Talab" }, { name: "Inflyatsiya" }, { name: "Bank" }] } })).json();
    let plan = (await app.inject({ method: "GET", url: `/api/plans/${planId}`, headers: h })).json();
    const total = plan.tasks.length;
    expect(plan.tasks.every((t: { status: string }) => t.status === "todo")).toBe(true);
    // simulate two missed days
    await deps.sql`update tasks set due_at = due_at - interval '3 days' where plan_id = ${planId} and kind = 'study' and position < 2`;
    plan = (await app.inject({ method: "GET", url: `/api/plans/${planId}`, headers: h })).json();
    expect(plan.overdue).toBe(2);
    const r = (await app.inject({ method: "POST", url: `/api/plans/${planId}/rebalance`, headers: h })).json();
    expect(r.moved).toBe(2);
    plan = (await app.inject({ method: "GET", url: `/api/plans/${planId}`, headers: h })).json();
    expect(plan.overdue).toBe(0);
    expect(plan.tasks).toHaveLength(total);
    expect(plan.tasks.filter((t: { status: string }) => t.status === "done")).toHaveLength(0);
    await app.inject({ method: "PATCH", url: `/api/tasks/${plan.tasks[0].id}`, headers: h, payload: { status: "done" } });
    plan = (await app.inject({ method: "GET", url: `/api/plans/${planId}`, headers: h })).json();
    expect(plan.progress.done).toBe(1);
  });
});

describe("tutor and summaries (no AI configured)", () => {
  it("answers only from the selected sources and says so when nothing is found", async () => {
    const user = await makeUser(deps);
    const doc = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
    await testWorker(deps).drain();
    const h = await auth(user);
    const ok = (await app.inject({ method: "POST", url: "/api/tutor/ask", headers: h, payload: { question: "Inflyatsiya qanday oʻlchanadi?", documentIds: [doc.documentId] } })).json();
    expect(ok.status).toBe("extractive");
    expect(ok.claims[0].text).toMatch(/isteʼmol|iste’mol|indeks/);
    expect(ok.claims[0].where).toMatch(/sahifa 3/);
    const nf = (await app.inject({ method: "POST", url: "/api/tutor/ask", headers: h, payload: { question: "Mars sayyorasida nechta yoʻldosh bor?", documentIds: [doc.documentId] } })).json();
    expect(nf.status).toBe("not_found");
    const web = await app.inject({ method: "POST", url: "/api/tutor/ask", headers: h, payload: { question: "Inflyatsiya?", mode: "sources_plus_web" } });
    expect(web.json().error.code).toBe("web_search_not_enabled");
    const sum = (await app.inject({ method: "GET", url: `/api/documents/${doc.documentId}/summary`, headers: h })).json();
    expect(sum.sections.map((s: { title: string }) => s.title)).toEqual(expect.arrayContaining(["2-bob. Inflyatsiya"]));
    const inf = sum.sections.find((s: { title: string }) => s.title === "2-bob. Inflyatsiya");
    expect(inf.points.every((p: { verified: boolean; aiWritten: boolean }) => p.verified && !p.aiWritten)).toBe(true);
    expect(inf.terms.map((t: { term: string }) => t.term)).toContain("Inflyatsiya");
    // overlapping chunks must not repeat a point
    for (const sec of sum.sections as { points: { text: string }[] }[]) expect(new Set(sec.points.map((p) => p.text)).size).toBe(sec.points.length);
  });
});

describe("statistics from a user table (acceptance 12)", () => {
  it("copies exact values with row locators, flags example data, computes with a formula and builds a sourced quiz", async () => {
    const user = await makeUser(deps);
    const doc = await createDocumentFromFile(deps, { user, filename: "namuna.xlsx", data: fixture("namuna.xlsx"), via: "miniapp" });
    await testWorker(deps).drain();
    const h = await auth(user);
    const tables = (await app.inject({ method: "GET", url: `/api/documents/${doc.documentId}/tables`, headers: h })).json().tables;
    expect(tables[0].columns).toEqual(["Yil", "Narx indeksi (bazaviy yil = 100)", "Izoh"]);
    const f = (await app.inject({ method: "POST", url: "/api/stats/facts", headers: h, payload: { documentId: doc.documentId, sheet: "Namuna", labelColumn: 0, valueColumn: 1, indicator: "Narx indeksi", unit: "indeks (2021=100)", geography: "—" } })).json();
    expect(f.created.map((c: { period: string; value: number }) => [c.period, c.value])).toEqual([["2021", 100], ["2022", 110], ["2023", 121], ["2024", 130]]);
    expect(f.created.every((c: { isExample: boolean }) => c.isExample)).toBe(true);
    const facts = (await app.inject({ method: "GET", url: `/api/documents/${doc.documentId}/facts`, headers: h })).json().items;
    expect(facts[1].locator).toEqual({ sheet: "Namuna", row: 3 });
    expect(facts[1].quote).toBe("Yil: 2022; Narx indeksi (bazaviy yil = 100): 110");
    const pct = (await app.inject({ method: "POST", url: "/api/stats/compute", headers: h, payload: { aId: facts[1].id, bId: facts[2].id, op: "pct_change" } })).json();
    expect(pct).toMatchObject({ value: 10, unit: "%", formula: "(121 − 110) / 110 × 100", isExample: true });
    expect(compute("pct_change", { value: 100, period: "a", unit: "x" }, { value: 130, period: "b", unit: "x" }).value).toBe(30);
    expect(() => compute("diff", { value: 1, period: "a", unit: "kg" }, { value: 2, period: "b", unit: "%" })).toThrow();
    const quiz = (await app.inject({ method: "POST", url: "/api/stats/quiz", headers: h, payload: { documentId: doc.documentId, indicator: "Narx indeksi" } })).json();
    expect(quiz.exampleData).toBe(true);
    const ed = (await app.inject({ method: "GET", url: `/api/quizzes/${quiz.quizId}/editor`, headers: h })).json();
    expect(ed.title).toMatch(/^Namuna maʼlumot/);
    const q2022 = ed.questions.find((q: { text: string }) => q.text.includes("2022"));
    expect(q2022.options.find((o: { correct: boolean }) => o.correct).text).toBe("110");
    expect(q2022.evidence.verification).toBe("table_value");
    expect(q2022.checks.find((c: { rule: string }) => c.rule === "facts_numbers").result).toBe("pass");
  });
});

describe("matching game", () => {
  it("keeps the key on the server and scores one submission", async () => {
    const user = await makeUser(deps);
    const doc = await createDocumentFromText(deps, { user, title: "Atamalar", via: "miniapp", text: sourceFixture("iqtisodiyot.html").toString("utf8").replace(/<[^>]+>/g, "\n") });
    await testWorker(deps).drain();
    const h = await auth(user);
    const g = (await app.inject({ method: "POST", url: "/api/games/matching", headers: h, payload: { documentId: doc.documentId, size: 4 } })).json();
    expect(g.terms).toHaveLength(4);
    expect(JSON.stringify(g)).not.toMatch(/private|answer/);
    const [row] = await deps.sql<{ private_key: Record<string, string> }[]>`select private_key from game_sessions where id = ${g.sessionId}`;
    const pairs = g.terms.map((t: { id: string }, i: number) => ({ termId: t.id, definitionId: i === 0 ? g.definitions.find((d: { id: string }) => d.id !== row!.private_key[t.id]).id : row!.private_key[t.id] }));
    const r = (await app.inject({ method: "POST", url: `/api/games/matching/${g.sessionId}/submit`, headers: h, payload: { pairs } })).json();
    expect(r.score).toBe(3);
    expect((await app.inject({ method: "POST", url: `/api/games/matching/${g.sessionId}/submit`, headers: h, payload: { pairs } })).statusCode).toBe(409);
  });
});

describe("Quiz Battle teams", () => {
  it("balances members and ranks teams by average points", async () => {
    const host = await makeUser(deps);
    const { quizId, questions } = await bookAndQuiz(host, "battle-1");
    const { roomId, inviteToken } = await createRoom(deps, host, quizId, { mode: "teams", teamCount: 2, timePerQuestionSec: 60 });
    const players = await Promise.all([1, 2, 3].map(() => makeUser(deps)));
    for (const p of players) await joinRoom(deps, p, { inviteToken });
    let shared = await loadSharedState(deps.sql, roomId);
    expect(shared.teams.map((t) => t.memberIds.length).sort()).toEqual([1, 2]);
    await hostAction(deps, host, roomId, "start");
    shared = await loadSharedState(deps.sql, roomId);
    const qid = shared.question!.id;
    const key = questions.find((q) => q.id === qid)!.options!.find((o) => o.correct)!.id;
    const wrong = questions.find((q) => q.id === qid)!.options!.find((o) => !o.correct)!.id;
    // the pair team: one right, one wrong → average 50; the single team: right → 100
    const big = shared.teams.find((t) => t.memberIds.length === 2)!;
    const small = shared.teams.find((t) => t.memberIds.length === 1)!;
    await submitAnswer(deps, { id: big.memberIds[0]! }, roomId, qid, [key]);
    await submitAnswer(deps, { id: big.memberIds[1]! }, roomId, qid, [wrong]);
    await submitAnswer(deps, { id: small.memberIds[0]! }, roomId, qid, [key]);
    const standings = teamStandings(await loadSharedState(deps.sql, roomId));
    expect(standings.map((s) => [s.members, s.averagePoints])).toEqual([[1, 100], [2, 50]]);
  });
});

describe("group workspace", () => {
  it("invites with roles, revokes links, tracks tasks, comments and history", async () => {
    const owner = await makeUser(deps);
    const editor = await makeUser(deps);
    const teacher = await makeUser(deps);
    const late = await makeUser(deps);
    const ho = await auth(owner);
    const { workspaceId } = (await app.inject({ method: "POST", url: "/api/workspaces", headers: ho, payload: { name: "Iqtisod 2-guruh" } })).json();
    const inv = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/invites`, headers: ho, payload: { role: "editor" } })).json();
    expect(inv.link).toBe(`https://t.me/talaba_test_bot?startapp=w${inv.token}`);
    const ro = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/invites`, headers: ho, payload: { role: "viewer", ttlHours: 24 } })).json();
    const he = await auth(editor);
    const ht = await auth(teacher);
    expect((await app.inject({ method: "POST", url: "/api/workspaces/join", headers: he, payload: { token: inv.token } })).json()).toMatchObject({ role: "editor" });
    expect((await app.inject({ method: "POST", url: "/api/workspaces/join", headers: ht, payload: { token: ro.token } })).json()).toMatchObject({ role: "viewer" });
    await app.inject({ method: "DELETE", url: `/api/workspaces/${workspaceId}/invites/${inv.inviteId}`, headers: ho });
    expect((await app.inject({ method: "POST", url: "/api/workspaces/join", headers: await auth(late), payload: { token: inv.token } })).statusCode).toBe(410);
    // editor creates a shared document and a task; the read-only teacher can read and comment but not edit
    const doc = await createDocumentFromText(deps, { user: editor, workspaceId, title: "Guruh konspekti", text: "Markaziy bank asosiy stavkani oshirsa, kreditlar qimmatlashadi. Bu inflyatsiyani pasaytiradi.", via: "miniapp" });
    const task = (await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/tasks`, headers: he, payload: { title: "Slaydlar 5–8", assigneeId: editor.id, dueAt: new Date(Date.now() + 86_400_000).toISOString() } })).json();
    expect((await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/tasks`, headers: ht, payload: { title: "x" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/tasks/${task.taskId}`, headers: ht, payload: { title: "hijack" } })).statusCode).toBe(403);
    const cm = await app.inject({ method: "POST", url: "/api/comments", headers: ht, payload: { targetType: "document", targetId: doc.documentId, body: "Manbalarni toʻliqroq yozing." } });
    expect(cm.statusCode, cm.body).toBe(200);
    const done = await app.inject({ method: "PATCH", url: `/api/tasks/${task.taskId}`, headers: he, payload: { status: "done" } });
    expect(done.statusCode, done.body).toBe(200);
    const view = (await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}`, headers: ht })).json();
    expect(view.role).toBe("viewer");
    expect(view.members.map((m: { role: string }) => m.role).sort()).toEqual(["editor", "owner", "viewer"]);
    expect(view.tasks[0]).toMatchObject({ title: "Slaydlar 5–8", status: "done" });
    expect(view.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(["member.joined", "task.created", "task.updated", "comment.added", "invite.revoked"]));
    expect(view.invites).toEqual([]); // only owners see invites
    // last owner cannot be removed
    expect((await app.inject({ method: "PUT", url: `/api/workspaces/${workspaceId}/members/${owner.id}`, headers: ho, payload: { role: "viewer" } })).statusCode).toBe(409);
    // outsiders see nothing
    expect((await app.inject({ method: "GET", url: `/api/workspaces/${workspaceId}`, headers: await auth(late) })).statusCode).toBe(404);
  });
});

describe("co-host", () => {
  it("only the host names a co-host; the co-host can run the room, and the room is not paused while either is connected", async () => {
    const host = await makeUser(deps);
    const { quizId } = await bookAndQuiz(host, "cohost-1");
    const { roomId, inviteToken } = await createRoom(deps, host, quizId, { timePerQuestionSec: 60 });
    const helper = await makeUser(deps);
    const player = await makeUser(deps);
    await joinRoom(deps, helper, { inviteToken });
    await joinRoom(deps, player, { inviteToken });
    await expect(setCoHost(deps, player, roomId, helper.id)).rejects.toThrow();
    await expect(setCoHost(deps, host, roomId, (await makeUser(deps)).id)).rejects.toThrow(); // not in the room
    await setCoHost(deps, host, roomId, helper.id);
    const shared = await loadSharedState(deps.sql, roomId);
    expect(shared.participants.find((p) => p.userId === helper.id)).toMatchObject({ isHost: true, isCoHost: true });
    await hostAction(deps, helper, roomId, "start");
    await expect(hostAction(deps, player, roomId, "pause")).rejects.toThrow();
    // host away, co-host connected → keeps running; both away → paused
    await setPresence(deps.sql, roomId, host.id, false);
    await setPresence(deps.sql, roomId, helper.id, true);
    expect(await pauseIfHostAway(deps, roomId)).toBe(false);
    await setPresence(deps.sql, roomId, helper.id, false);
    expect(await pauseIfHostAway(deps, roomId)).toBe(true);
    await setCoHost(deps, host, roomId, null);
    await expect(hostAction(deps, helper, roomId, "resume")).rejects.toThrow();
  });
});

describe("self-paced assignment (room mode async)", () => {
  it("each participant takes it once before the deadline; correctness and ranking stay hidden until it closes", async () => {
    const host = await makeUser(deps);
    const { quizId, questions } = await bookAndQuiz(host, "assign-1");
    const { roomId, inviteToken, mode } = await createRoom(deps, host, quizId, { mode: "async", deadlineHours: 48 }) as { roomId: string; inviteToken: string; mode: string };
    expect(mode).toBe("async");
    await expect(hostAction(deps, host, roomId, "start")).rejects.toMatchObject({ code: "not_for_assignment" });
    const [a, b] = [await makeUser(deps), await makeUser(deps)];
    for (const u of [a, b]) expect((await joinRoom(deps, u, { inviteToken })).mode).toBe("async");
    await expect(startAssignment(deps, host, roomId)).rejects.toMatchObject({ code: "host_does_not_take" });

    const sa = await startAssignment(deps, a, roomId);
    expect((await startAssignment(deps, a, roomId)).attemptId).toBe(sa.attemptId); // one attempt per person
    const st = await attemptState(deps, a, sa.attemptId);
    expect(st.hidden).toBe(true);
    const q0 = st.question!;
    const key = questions.find((q) => q.id === q0.id)!.options!.find((o) => o.correct)!.id;
    const r = await answerAttempt(deps, a, sa.attemptId, q0.id, [key]);
    expect(r).toMatchObject({ hidden: true, isCorrect: null, explanation: null, score: null });
    expect((await attemptResults(deps, a, sa.attemptId)).score).toBeNull();

    let view = await assignmentView(deps, a, roomId);
    expect(view.status).toBe("open");
    expect(view.leaderboard).toBeNull();
    expect(view.progress).toBeNull();
    const hv = await assignmentView(deps, host, roomId);
    expect(hv.progress!.map((p) => p.state).sort()).toEqual(["not_started", "started"]);

    // deadline passes → closed by the worker tick; answers are refused; results and ranking open
    await deps.sql`update rooms set assignment_due_at = now() - interval '1 minute' where id = ${roomId}`;
    const sb = await startAssignment(deps, b, roomId).catch((e) => e);
    expect(sb).toMatchObject({ code: "assignment_closed" });
    const q1 = (await attemptState(deps, a, sa.attemptId)).question;
    if (q1) await expect(answerAttempt(deps, a, sa.attemptId, q1.id, [questions.find((q) => q.id === q1.id)!.options![0]!.id])).rejects.toMatchObject({ code: "assignment_closed" });
    expect(await closeExpiredAssignments(deps)).toBe(1);
    view = await assignmentView(deps, a, roomId);
    expect(view.status).toBe("closed");
    expect(view.leaderboard).toEqual([{ rank: 1, name: expect.any(String), score: 100, isMe: true }]);
    const res = await attemptResults(deps, a, sa.attemptId);
    expect(res).toMatchObject({ hidden: false, score: 100, correct: 1 });
  });
});
