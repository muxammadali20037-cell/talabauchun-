import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import { listDataRequests, requestDataJob } from "../account/data";
import { enqueueMessage } from "../telegram/outbox";

/** The user's own data: export everything, or delete the account. */
export async function registerAccountRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const limited = { preHandler: h.auth, config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };
  app.get("/api/me/data", { preHandler: h.auth }, async (req) => ({ items: await listDataRequests(deps, h.me(req)) }));
  app.post("/api/me/export", limited, async (req) => requestDataJob(deps, h.me(req), "export"));
  // in-app support (same tickets as /support and /paysupport in the bot)
  app.get("/api/support", { preHandler: h.auth }, async (req) => ({
    items: await deps.sql`select id::text, kind, body, status, resolution, created_at, replied_at from support_tickets where user_id = ${h.me(req).id} order by created_at desc limit 20`,
  }));
  app.post("/api/support", { preHandler: h.auth, config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const b = z.object({ kind: z.enum(["support", "paysupport", "content_error"]), body: z.string().trim().min(5).max(4000) }).parse(req.body);
    const user = h.me(req);
    const [t] = await deps.sql<{ id: string }[]>`insert into support_tickets (user_id, kind, body) values (${user.id}, ${b.kind}, ${b.body}) returning id::text`;
    if (deps.cfg.SUPPORT_CHAT_ID) {
      await enqueueMessage(deps.sql, { chatId: deps.cfg.SUPPORT_CHAT_ID, userId: null, method: "sendMessage", payload: { text: `#${t!.id} (${b.kind}, mini app)\n${b.body.slice(0, 3000)}` }, dedupeKey: `ticket:${t!.id}` });
    }
    return { ticketId: t!.id };
  });
  app.post("/api/me/delete", limited, async (req) => requestDataJob(deps, h.me(req), "delete", { confirm: z.object({ confirm: z.string().max(20) }).parse(req.body ?? {}).confirm }));
}
