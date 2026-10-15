import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import { createGroupRun, getRun, runResults } from "../group/native-quiz";
import { notFound } from "../lib/errors";

export async function registerGroupRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  app.post("/api/quizzes/:id/group-runs", { preHandler: h.auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = z.object({ anonymous: z.boolean().default(false), openPeriod: z.number().int().min(10).max(600).default(30) }).parse(req.body ?? {});
    return createGroupRun(deps, h.me(req), id, body);
  });
  app.get("/api/group-runs/:id", { preHandler: h.auth }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const run = await getRun(deps, id);
    // individual results are visible to the host only
    if (run.host_id !== h.me(req).id) throw notFound("group run");
    return runResults(deps, id);
  });
}
