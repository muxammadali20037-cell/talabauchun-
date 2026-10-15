import type { Deps } from "../deps";
import { Bot, type TgUpdate } from "./bot";

/** Long polling for local development without a public HTTPS URL (deletes any webhook first). */
export async function runPolling(deps: Deps, signal: AbortSignal) {
  if (!deps.tg) throw new Error("TELEGRAM_BOT_TOKEN missing");
  const bot = new Bot(deps);
  await deps.tg.call("deleteWebhook", { drop_pending_updates: false });
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await deps.tg.call<TgUpdate[]>("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query", "poll", "poll_answer", "my_chat_member", "pre_checkout_query"],
      });
      for (const u of updates) {
        offset = u.update_id + 1;
        await bot.handle(u);
      }
    } catch (e) {
      deps.log.warn({ err: String(e) }, "getUpdates failed");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
