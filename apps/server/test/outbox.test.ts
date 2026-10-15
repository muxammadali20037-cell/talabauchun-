import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { TelegramApi } from "../src/telegram/api";
import { OutboxSender, enqueueMessage } from "../src/telegram/outbox";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { FakeTelegram } from "./helpers/fake-telegram";

let deps: Deps;
let cleanup: () => Promise<void>;
const fake = new FakeTelegram();
beforeAll(async () => {
  await fake.start();
  ({ deps, cleanup } = await createTestDeps());
});
afterAll(async () => {
  await fake.stop();
  await cleanup();
});

describe("outbox", () => {
  it("re-sends a message left in 'sending' by a crashed sender, after its 2-minute lease", async () => {
    await enqueueMessage(deps.sql, { chatId: 501, method: "sendMessage", payload: { text: "stuck" }, dedupeKey: "stuck-1" });
    await deps.sql`update notifications set status = 'sending', next_attempt_at = now() + interval '2 minutes' where dedupe_key = 'stuck-1'`;
    const s = new OutboxSender(deps.sql, new TelegramApi(TEST_BOT_TOKEN, fake.url));
    expect(await s.tick()).toBe(0);
    await deps.sql`update notifications set next_attempt_at = now() - interval '1 second' where dedupe_key = 'stuck-1'`;
    expect(await s.tick()).toBe(1);
    expect((await deps.sql<{ status: string }[]>`select status from notifications where dedupe_key = 'stuck-1'`)[0]!.status).toBe("sent");
  });

  it("two sender processes never send the same batch: one holds the lock, the other skips", async () => {
    fake.reset();
    for (let i = 0; i < 6; i++) await enqueueMessage(deps.sql, { chatId: 600 + i, method: "sendMessage", payload: { text: `m${i}` }, dedupeKey: `pair-${i}` });
    const a = new OutboxSender(deps.sql, new TelegramApi(TEST_BOT_TOKEN, fake.url));
    const b = new OutboxSender(deps.sql, new TelegramApi(TEST_BOT_TOKEN, fake.url));
    const [x, y] = await Promise.all([a.tick(), b.tick()]);
    expect(x + y).toBe(6);
    expect(Math.min(x, y)).toBe(0);
    expect(fake.byMethod("sendMessage").length).toBe(6);
  });
});

describe("Telegram update handling (at-least-once)", () => {
  it("a copy that arrives while the first is being handled gets 'busy'; a dead claim is taken over after 2 minutes; done updates are skipped", async () => {
    const { Bot } = await import("../src/telegram/bot");
    deps.tg = new TelegramApi(TEST_BOT_TOKEN, fake.url);
    const bot = new Bot(deps);
    const update = { update_id: 99001, message: { message_id: 1, from: { id: 880001, first_name: "A", language_code: "uz" }, chat: { id: 880001, type: "private" as const }, text: "/help" } };
    // claimed by a handler that never finished
    await deps.sql`insert into processed_updates (update_id, done, claimed_at) values (99001, false, now())`;
    expect(await bot.handle(update)).toBe("busy");
    await deps.sql`update processed_updates set claimed_at = now() - interval '3 minutes' where update_id = 99001`;
    fake.reset();
    expect(await bot.handle(update)).toBe("done");
    expect(fake.byMethod("sendMessage").length).toBeGreaterThan(0);
    expect(await bot.handle(update)).toBe("duplicate");
  });
});

describe("retention", () => {
  it("removes old update ids and old delivered messages, keeps recent ones", async () => {
    const { retentionCleanup } = await import("../src/ops/retention");
    await deps.sql`insert into processed_updates (update_id, done, claimed_at) values (77001, true, now() - interval '8 days'), (77002, true, now())`;
    await deps.sql`insert into notifications (chat_id, method, payload, status, created_at) values (1, 'sendMessage', '{}', 'sent', now() - interval '31 days'), (1, 'sendMessage', '{}', 'sent', now())`;
    const r = await retentionCleanup(deps);
    expect(r.updates).toBe(1);
    expect(r.messages).toBeGreaterThanOrEqual(1);
    expect((await deps.sql`select 1 from processed_updates where update_id = 77002`).length).toBe(1);
  });
});
