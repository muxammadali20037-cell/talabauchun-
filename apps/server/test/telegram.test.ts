import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { signInitData, validateInitData } from "../src/auth/init-data";
import { TelegramApi } from "../src/telegram/api";
import { OutboxSender, enqueueMessage } from "../src/telegram/outbox";
import { tickGroupRuns } from "../src/group/native-quiz";
import { createDocumentFromFile } from "../src/ingest/documents";
import { approveQuestions, createQuiz, getQuizForEditor, publishQuiz } from "../src/quiz/service";
import { createTestDeps, makeUser, TEST_BOT_TOKEN } from "./helpers/deps";
import { FakeTelegram } from "./helpers/fake-telegram";
import { fixture } from "./helpers/fixtures";
import { testWorker } from "./helpers/worker";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
const fake = new FakeTelegram();
let updateId = 1;
const SECRET = "webhook-secret-test";

beforeAll(async () => {
  await fake.start();
  ({ deps, cleanup } = await createTestDeps());
  deps.tg = new TelegramApi(TEST_BOT_TOKEN, fake.url);
  app = await buildApp(deps, { logger: false });
});
afterAll(async () => {
  await app.close();
  await fake.stop();
  await cleanup();
});

function initDataFor(user: { id: number; first_name: string; language_code?: string }, opts: { authDate?: number; startParam?: string } = {}) {
  return signInitData(
    {
      auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
      query_id: "AAH" + user.id,
      user: JSON.stringify({ ...user, allows_write_to_pm: true }),
      ...(opts.startParam ? { start_param: opts.startParam } : {}),
      signature: "dGVzdC1zaWduYXR1cmU",
    },
    TEST_BOT_TOKEN,
  );
}

async function login(tgUser: { id: number; first_name: string; language_code?: string }) {
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData: initDataFor(tgUser) } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

async function webhook(update: Record<string, unknown>, secret = SECRET) {
  return app.inject({ method: "POST", url: "/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": secret }, payload: { update_id: updateId++, ...update } });
}

const privateMsg = (from: { id: number; first_name: string }, extra: Record<string, unknown>) => ({ message: { message_id: updateId, from, chat: { id: from.id, type: "private" }, date: 0, ...extra } });

describe("Mini App initData (acceptance 18: forged/expired initData)", () => {
  it("accepts Telegram-signed initData and rejects tampering, expiry and missing hash", () => {
    const good = initDataFor({ id: 555, first_name: "Ali" });
    expect(validateInitData(good, TEST_BOT_TOKEN, 3600).user.id).toBe(555);
    const tampered = good.replace("%22id%22%3A555", "%22id%22%3A556");
    expect(() => validateInitData(tampered, TEST_BOT_TOKEN, 3600)).toThrow();
    expect(() => validateInitData(good, "999:other-bot-token", 3600)).toThrow();
    const old = initDataFor({ id: 555, first_name: "Ali" }, { authDate: Math.floor(Date.now() / 1000) - 7200 });
    expect(() => validateInitData(old, TEST_BOT_TOKEN, 3600)).toThrowError(/too old/);
    expect(() => validateInitData(good.replace(/&?hash=[0-9a-f]+/, ""), TEST_BOT_TOKEN, 3600)).toThrow();
  });

  it("does not trust a user id in the URL or body without a valid signature", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData: "user=%7B%22id%22%3A1%7D&auth_date=1&hash=" + "0".repeat(64) } });
    expect(res.statusCode).toBe(401);
    const me = await app.inject({ method: "GET", url: "/api/me?user_id=1" });
    expect(me.statusCode).toBe(401);
    const dev = await app.inject({ method: "POST", url: "/api/auth/dev", payload: { telegramId: 1 } });
    expect(dev.statusCode).toBe(404); // dev login disabled unless explicitly enabled outside production
  });

  it("rejects webhook calls without the secret token", async () => {
    expect((await webhook({ message: { text: "/start" } }, "wrong")).statusCode).toBe(401);
  });
});

describe("Bot → Mini App (acceptance 1)", () => {
  it("a book sent to the bot appears in the same account's Mini App library, not in another account's", async () => {
    const tgUser = { id: 700001, first_name: "Dilnoza", language_code: "uz" };
    fake.files.set("FILE_BOOK_1", fixture("iqtisodiyot.pdf"));
    expect((await webhook(privateMsg(tgUser, { text: "/start" }))).statusCode).toBe(200);
    const greetings = fake.byMethod("sendMessage").filter((c) => c.params.chat_id === tgUser.id).map((c) => String(c.params.text));
    expect(greetings[0]).toMatch(/TALABA AI/);
    expect(greetings[1]).toMatch(/Tilni tanlang/); // first visit: language suggested from Telegram, user can switch
    await webhook(privateMsg(tgUser, { document: { file_id: "FILE_BOOK_1", file_name: "iqtisodiyot.pdf", file_size: fixture("iqtisodiyot.pdf").length, mime_type: "application/pdf" } }));
    expect(fake.byMethod("getFile")).toHaveLength(1);
    expect(fake.last("sendMessage")!.params.text).toMatch(/qabul qilindi/);
    await testWorker(deps).drain();
    // the "ready" notification goes through the outbox (rate limited, retried)
    const sender = new OutboxSender(deps.sql, deps.tg!);
    await sender.tick();
    expect(fake.calls.some((c) => c.method === "sendMessage" && String(c.params.text).includes("tayyor: 5/5"))).toBe(true);

    const token = await login(tgUser);
    const list = await app.inject({ method: "GET", url: "/api/documents", headers: { authorization: `Bearer ${token}` } });
    const docs = list.json().items as { id: string; title: string; version: { status: string } }[];
    expect(docs).toHaveLength(1);
    expect(docs[0]!.version.status).toBe("ready");

    const otherToken = await login({ id: 700002, first_name: "Bekzod" });
    const other = await app.inject({ method: "GET", url: "/api/documents", headers: { authorization: `Bearer ${otherToken}` } });
    expect(other.json().items).toEqual([]);
    const direct = await app.inject({ method: "GET", url: `/api/documents/${docs[0]!.id}`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(direct.statusCode).toBe(404);
    const search = await app.inject({ method: "GET", url: `/api/search?q=inflyatsiya`, headers: { authorization: `Bearer ${otherToken}` } });
    expect(search.json().items).toEqual([]);
  });

  it("refuses files above the Telegram bot download limit and points to the web upload", async () => {
    const tgUser = { id: 700003, first_name: "Aziz" };
    await webhook(privateMsg(tgUser, { document: { file_id: "BIG", file_name: "katta.pdf", file_size: 60 * 1024 * 1024 } }));
    expect(fake.byMethod("getFile").filter((c) => c.params.file_id === "BIG")).toHaveLength(0);
    expect(fake.last("sendMessage")!.params.text).toMatch(/chegarasidan katta/);
  });

  it("ignores a duplicate update_id", async () => {
    const before = fake.byMethod("sendMessage").length;
    const id = updateId++;
    const body = { update_id: id, ...privateMsg({ id: 700004, first_name: "Z" }, { text: "/help" }) };
    await app.inject({ method: "POST", url: "/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": SECRET }, payload: body });
    await app.inject({ method: "POST", url: "/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": SECRET }, payload: body });
    expect(fake.byMethod("sendMessage").length - before).toBe(1);
  });
});

async function publishedQuiz(tgId: number) {
  const user = await makeUser(deps, { id: tgId });
  const r = await createDocumentFromFile(deps, { user, filename: "iqtisodiyot.pdf", data: fixture("iqtisodiyot.pdf"), via: "miniapp" });
  await testWorker(deps).drain();
  const { quizId } = await createQuiz(deps, user, { method: "from_source", documentIds: [r.documentId], settings: { count: 4 }, idempotencyKey: `tg-quiz-${tgId}` });
  await testWorker(deps).drain();
  const q = await getQuizForEditor(deps, user, quizId);
  await approveQuestions(deps, user, quizId, q.questions.map((x) => x.id));
  await publishQuiz(deps, user, quizId);
  return { user, quizId, questions: (await getQuizForEditor(deps, user, quizId)).questions };
}

describe("practice inside the bot (flow A)", () => {
  it("asks questions with buttons, grades, explains with the source and replays mistakes", async () => {
    const { quizId } = await publishedQuiz(710001);
    const from = { id: 710001, first_name: "Test" };
    fake.reset();
    await webhook({ callback_query: { id: "cb1", from, data: `qp:${quizId}`, message: { message_id: 1, chat: { id: from.id, type: "private" } } } });
    const q1 = fake.last("sendMessage")!;
    expect(String(q1.params.text)).toMatch(/^<b>1\/4\.<\/b>/);
    const kb = (q1.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;
    expect(kb[0]!.map((b) => b.text)).toEqual(["A", "B", "C", "D"]);
    for (const b of kb[0]!) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    // answer A for every question (some will be wrong), pressing twice on the first one
    for (let i = 0; i < 4; i++) {
      const msg = fake.last("sendMessage")!;
      const buttons = (msg.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]!;
      await webhook({ callback_query: { id: `a${i}`, from, data: buttons[0]!.callback_data, message: { message_id: 2 + i, text: msg.params.text, chat: { id: from.id, type: "private" } } } });
      if (i === 0) await webhook({ callback_query: { id: `a${i}x`, from, data: buttons[0]!.callback_data, message: { message_id: 2, text: msg.params.text, chat: { id: from.id, type: "private" } } } });
      const edited = fake.last("editMessageText")!;
      expect(String(edited.params.text)).toMatch(/✅|❌/);
      expect(String(edited.params.text)).toMatch(/📖 .*sahifa \d/);
      if (i < 3) {
        const next = (edited.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data;
        await webhook({ callback_query: { id: `n${i}`, from, data: next, message: { message_id: 10, chat: { id: from.id, type: "private" } } } });
      }
    }
    const done = fake.byMethod("sendMessage").find((c) => String(c.params.text).includes("🏁"))!;
    expect(done).toBeTruthy();
    const [att] = await deps.sql<{ score: number; n: number }[]>`select a.score, (select count(*)::int from attempt_answers where attempt_id = a.id) as n from attempts a join users u on u.id = a.user_id where u.telegram_id = 710001 and a.mode = 'bot_practice'`;
    expect(att!.n).toBe(4); // the double press did not add a second answer
  });
});

describe("native quiz in a Telegram group (acceptance 6)", () => {
  async function linkAndRun(anonymous: boolean, hostTg: number, groupId: number) {
    const { user, quizId } = await publishedQuiz(hostTg);
    const token = await login({ id: hostTg, first_name: "Host" });
    const res = await app.inject({ method: "POST", url: `/api/quizzes/${quizId}/group-runs`, headers: { authorization: `Bearer ${token}` }, payload: { anonymous, openPeriod: 10 } });
    expect(res.statusCode).toBe(200);
    const { link, runId } = res.json() as { link: string; runId: string };
    expect(link).toMatch(/^https:\/\/t\.me\/talaba_test_bot\?startgroup=g[A-Za-z0-9_-]{22}$/);
    const param = link.split("startgroup=")[1]!;
    const group = { id: groupId, type: "supergroup", title: "Iqtisod 101" };
    // someone else in the group cannot hijack the link
    await webhook({ message: { message_id: 1, from: { id: 999, first_name: "Stranger" }, chat: group, text: `/start@talaba_test_bot ${param}` } });
    expect(fake.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === groupId)).toHaveLength(0);
    await webhook({ message: { message_id: 2, from: { id: hostTg, first_name: "Host" }, chat: group, text: `/start@talaba_test_bot ${param}` } });
    const intro = fake.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === groupId).pop()!;
    const startData = (intro.params.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data;
    await webhook({ callback_query: { id: "g1", from: { id: 999, first_name: "Stranger" }, data: startData, message: { message_id: 3, chat: group } } });
    expect(fake.last("answerCallbackQuery")!.params.show_alert).toBe(true);
    await webhook({ callback_query: { id: "g2", from: { id: hostTg, first_name: "Host" }, data: startData, message: { message_id: 3, chat: group } } });
    return { runId, user, quizId };
  }

  it("sends real quiz polls, scores only real non-anonymous poll_answer events", async () => {
    const groupId = -100777;
    const { runId } = await linkAndRun(false, 720001, groupId);
    fake.reset();
    for (let i = 0; i < 4; i++) {
      await deps.sql`update group_quiz_runs set next_send_at = now() where id = ${runId}`;
      await tickGroupRuns(deps);
      const poll = fake.last("sendPoll")!;
      expect(poll.params).toMatchObject({ chat_id: String(groupId), type: "quiz", is_anonymous: false, open_period: 10 });
      expect((poll.params.options as unknown[]).length).toBe(4);
      expect((poll.params.correct_option_ids as number[]).length).toBe(1);
      expect(String(poll.params.explanation ?? "").length).toBeLessThanOrEqual(200);
      const [tp] = await deps.sql<{ poll_id: string; correct_indices: number[] }[]>`select poll_id, correct_indices from telegram_polls where run_id = ${runId} order by sent_at desc limit 1`;
      const correct = tp!.correct_indices[0]!;
      await webhook({ poll_answer: { poll_id: tp!.poll_id, user: { id: 801, first_name: "Malika" }, option_ids: [correct] } });
      await webhook({ poll_answer: { poll_id: tp!.poll_id, user: { id: 802, first_name: "Jasur" }, option_ids: [(correct + 1) % 4] } });
      await webhook({ poll_answer: { poll_id: tp!.poll_id, voter_chat: { id: -1009, type: "channel" }, option_ids: [correct] } });
      await webhook({ poll_answer: { poll_id: "unknown_poll", user: { id: 803, first_name: "X" }, option_ids: [0] } });
    }
    await deps.sql`update group_quiz_runs set next_send_at = now() where id = ${runId}`;
    await tickGroupRuns(deps);
    await new OutboxSender(deps.sql, deps.tg!).tick();
    const final = fake.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === String(groupId)).pop()!;
    expect(String(final.params.text)).toMatch(/Malika — 4\/4/);
    expect(String(final.params.text)).toMatch(/Jasur — 0\/4/);
    expect(String(final.params.text)).toMatch(/Qatnashchilar: 2/);
    const [n] = await deps.sql<{ n: number }[]>`select count(*)::int as n from poll_answers a join telegram_polls p on p.poll_id = a.poll_id where p.run_id = ${runId}`;
    expect(n!.n).toBe(8);
  });

  it("anonymous runs never produce personal rankings", async () => {
    const groupId = -100778;
    const { runId } = await linkAndRun(true, 720002, groupId);
    fake.reset();
    await deps.sql`update group_quiz_runs set next_send_at = now() where id = ${runId}`;
    await tickGroupRuns(deps);
    expect(fake.last("sendPoll")!.params.is_anonymous).toBe(true);
    const [tp] = await deps.sql<{ poll_id: string }[]>`select poll_id from telegram_polls where run_id = ${runId}`;
    await webhook({ poll: { id: tp!.poll_id, is_closed: true, total_voter_count: 3, options: [{ voter_count: 2 }, { voter_count: 1 }, { voter_count: 0 }, { voter_count: 0 }] } });
    await deps.sql`update group_quiz_runs set current_index = cardinality(question_ids) - 1, next_send_at = now() where id = ${runId}`;
    await tickGroupRuns(deps);
    await new OutboxSender(deps.sql, deps.tg!).tick();
    const final = fake.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === String(groupId)).pop()!;
    expect(String(final.params.text)).toMatch(/anonim/);
    expect(String(final.params.text)).not.toMatch(/\d\/4/);
  });

  it("reports a missing permission to the host instead of failing silently", async () => {
    const groupId = -100779;
    const { runId } = await linkAndRun(false, 720003, groupId);
    fake.failNext("sendPoll", 403, "Forbidden: bot is not a member of the supergroup chat");
    await deps.sql`update group_quiz_runs set next_send_at = now() where id = ${runId}`;
    await tickGroupRuns(deps);
    const [run] = await deps.sql<{ status: string }[]>`select status from group_quiz_runs where id = ${runId}`;
    expect(run!.status).toBe("failed");
    await new OutboxSender(deps.sql, deps.tg!).tick();
    expect(fake.calls.some((c) => c.method === "sendMessage" && c.params.chat_id === "720003" && String(c.params.text).includes("ruxsat"))).toBe(true);
  });
});

describe("outbox delivery", () => {
  it("honours 429 retry_after without losing the message and marks blocked users", async () => {
    const user = await makeUser(deps, { id: 730001 });
    await enqueueMessage(deps.sql, { chatId: 730001, userId: user.id, method: "sendMessage", payload: { text: "salom" }, dedupeKey: "t-429" });
    fake.failNext("sendMessage", 429, "Too Many Requests: retry after 2", 2);
    const sender = new OutboxSender(deps.sql, deps.tg!);
    await sender.tick();
    const [n] = await deps.sql<{ status: string; wait: number }[]>`select status, extract(epoch from next_attempt_at - now())::int as wait from notifications where dedupe_key = 't-429'`;
    expect(n!.status).toBe("pending");
    expect(n!.wait).toBeGreaterThanOrEqual(1);
    await deps.sql`update notifications set next_attempt_at = now() where dedupe_key = 't-429'`;
    await sender.tick();
    expect((await deps.sql`select status from notifications where dedupe_key = 't-429'`)[0]!.status).toBe("sent");

    await enqueueMessage(deps.sql, { chatId: 730001, userId: user.id, method: "sendMessage", payload: { text: "x" }, dedupeKey: "t-403" });
    fake.failNext("sendMessage", 403, "Forbidden: bot was blocked by the user");
    await sender.tick();
    const [u] = await deps.sql<{ bot_blocked_at: Date | null }[]>`select bot_blocked_at from users where id = ${user.id}`;
    expect(u!.bot_blocked_at).not.toBeNull();
  });
});
