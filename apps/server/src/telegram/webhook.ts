import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps";
import { safeEqual } from "../lib/crypto";
import { Bot, type TgUpdate } from "./bot";

/**
 * POST /telegram/webhook — accepted only with the exact secret registered via
 * setWebhook(secret_token=…), compared in constant time. Each update is
 * processed once (processed_updates); heavy work is queued as jobs.
 */
export async function registerTelegramWebhook(app: FastifyInstance, deps: Deps) {
  if (!deps.tg || !deps.cfg.TELEGRAM_WEBHOOK_SECRET) return;
  const bot = new Bot(deps);
  const secret = deps.cfg.TELEGRAM_WEBHOOK_SECRET;
  app.post("/telegram/webhook", { config: { rateLimit: false } }, async (req, reply) => {
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (typeof got !== "string" || !safeEqual(got, secret)) return reply.status(401).send({ ok: false });
    const update = req.body as TgUpdate;
    if (!update || typeof update.update_id !== "number") return reply.status(400).send({ ok: false });
    // a copy of an update that is still being handled: let Telegram retry later
    if ((await bot.handle(update)) === "busy") return reply.status(503).send({ ok: false });
    return { ok: true };
  });
}
