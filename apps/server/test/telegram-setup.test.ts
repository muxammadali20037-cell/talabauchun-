import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { TelegramApi } from "../src/telegram/api";
import { ALLOWED_UPDATES, configureTelegram } from "../src/telegram/setup";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { FakeTelegram } from "./helpers/fake-telegram";

let deps: Deps;
let cleanup: () => Promise<void>;
const fake = new FakeTelegram();
beforeAll(async () => {
  await fake.start();
  ({ deps, cleanup } = await createTestDeps());
  deps.tg = new TelegramApi(TEST_BOT_TOKEN, fake.url);
});
afterAll(async () => {
  await fake.stop();
  await cleanup();
});

describe("bot setup (ops:telegram-setup)", () => {
  it("sets the webhook with its secret and handled update types, commands in uz/ru/en, the Mini App menu button and descriptions", async () => {
    const r = await configureTelegram(deps);
    expect(r.bot).toBe("talaba_test_bot");
    expect(fake.last("setWebhook")!.params).toEqual({ url: "https://talaba.example/telegram/webhook", secret_token: "webhook-secret-test", allowed_updates: [...ALLOWED_UPDATES], max_connections: 40, drop_pending_updates: false });
    // every update type the bot handles is requested (payments and poll answers included)
    expect(ALLOWED_UPDATES).toEqual(expect.arrayContaining(["pre_checkout_query", "poll_answer", "my_chat_member"]));
    const cmds = fake.byMethod("setMyCommands");
    expect(cmds.map((c) => c.params.language_code ?? "default")).toEqual(["default", "ru", "en", "default"]);
    expect((cmds[0]!.params.commands as { command: string }[]).map((c) => c.command)).toEqual(expect.arrayContaining(["start", "quiz", "slides", "support", "paysupport", "terms", "privacy"]));
    for (const c of cmds.slice(0, 3)) for (const x of c.params.commands as { command: string; description: string }[]) {
      expect(x.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(x.description.length).toBeLessThanOrEqual(256);
    }
    expect(fake.last("setChatMenuButton")!.params).toEqual({ menu_button: { type: "web_app", text: "TALABA AI", web_app: { url: "https://talaba.example/app/" } } });
    for (const d of fake.byMethod("setMyShortDescription")) expect(String(d.params.short_description).length).toBeLessThanOrEqual(120);
    for (const d of fake.byMethod("setMyDescription")) expect(String(d.params.description).length).toBeLessThanOrEqual(512);
  });

  it("refuses a token that belongs to another bot and a non-https public URL", async () => {
    deps.cfg.TELEGRAM_BOT_USERNAME = "some_other_bot";
    await expect(configureTelegram(deps)).rejects.toThrow(/does not match/);
    deps.cfg.TELEGRAM_BOT_USERNAME = "talaba_test_bot";
    deps.cfg.PUBLIC_BASE_URL = "http://localhost:8080";
    await expect(configureTelegram(deps)).rejects.toThrow(/https/);
    deps.cfg.PUBLIC_BASE_URL = "https://talaba.example";
  });
});
