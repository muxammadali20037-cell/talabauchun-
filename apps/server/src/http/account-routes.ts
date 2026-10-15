import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import { listDataRequests, requestDataJob } from "../account/data";

/** The user's own data: export everything, or delete the account. */
export async function registerAccountRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const limited = { preHandler: h.auth, config: { rateLimit: { max: 5, timeWindow: "1 hour" } } };
  app.get("/api/me/data", { preHandler: h.auth }, async (req) => ({ items: await listDataRequests(deps, h.me(req)) }));
  app.post("/api/me/export", limited, async (req) => requestDataJob(deps, h.me(req), "export"));
  app.post("/api/me/delete", limited, async (req) => requestDataJob(deps, h.me(req), "delete", { confirm: z.object({ confirm: z.string().max(20) }).parse(req.body ?? {}).confirm }));
}
