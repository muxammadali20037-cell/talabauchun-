import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import { requirePlatformAdmin } from "../access/policy";
import { listPlans, updatePlan } from "../billing/plans";
import { sha256 } from "../lib/crypto";
import { AppError } from "../lib/errors";
import * as admin from "../admin/service";

const uuid = z.string().uuid();

/**
 * Operator API. Every route requires a platform admin; every mutation also
 * requires a recently created session (fresh Telegram sign-in) and is written
 * to audit_events with the caller's IP.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const read = async (req: FastifyRequest) => {
    await h.auth(req);
    requirePlatformAdmin(h.me(req));
  };
  const write = async (req: FastifyRequest) => {
    await read(req);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const [s] = await deps.sql<{ fresh: boolean }[]>`select created_at > now() - make_interval(mins => ${deps.cfg.ADMIN_FRESH_SESSION_MIN}) as fresh from sessions where token_hash = ${sha256(token)}`;
    if (!s?.fresh) throw new AppError("admin_reauth_required", 401, "sign in again to confirm this admin action");
  };
  const R = { preHandler: read };
  const W = { preHandler: write, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const me = (req: FastifyRequest) => h.me(req).id;
  const id = (req: FastifyRequest, k = "id") => uuid.parse((req.params as Record<string, string>)[k]);

  app.get("/api/admin/overview", R, async () => admin.overview(deps));
  app.get("/api/admin/metrics", R, async () => admin.productMetrics(deps));

  app.get("/api/admin/jobs", R, async (req) => admin.listJobs(deps, z.object({ status: z.string().max(20).optional(), kind: z.string().max(40).optional(), limit: z.coerce.number().int().optional() }).parse(req.query)));
  app.post("/api/admin/jobs/:id/retry", W, async (req) => admin.retryJob(deps, me(req), id(req), req.ip));

  app.get("/api/admin/plans", R, async () => listPlans(deps.sql, { includeInactive: true }));
  app.put("/api/admin/plans/:code", W, async (req) => {
    const code = z.string().regex(/^[a-z_]{2,40}$/).parse((req.params as { code: string }).code);
    const plan = await updatePlan(deps.sql, me(req), code, req.body);
    if (req.ip) await deps.sql`update audit_events set ip = ${req.ip} where id = (select max(id) from audit_events where actor_id = ${me(req)} and action = 'plan.update')`;
    return plan;
  });

  app.get("/api/admin/models", R, async () => admin.listModelConfigs(deps));
  app.put("/api/admin/models/:task", W, async (req) => admin.setModelConfig(deps, me(req), (req.params as { task: string }).task, req.body, req.ip));
  app.post("/api/admin/models/:task/rollback", W, async (req) => admin.rollbackModelConfig(deps, me(req), (req.params as { task: string }).task, req.ip));

  app.get("/api/admin/flags", R, async () => admin.listFlags(deps));
  app.put("/api/admin/flags/:key", W, async (req) => admin.setFlag(deps, me(req), (req.params as { key: string }).key, req.body, req.ip));

  app.get("/api/admin/reports", R, async (req) => admin.listReports(deps, z.object({ status: z.enum(["open", "resolved", "rejected"]).default("open") }).parse(req.query).status));
  app.post("/api/admin/reports/:id/resolve", W, async (req) => admin.resolveReport(deps, me(req), id(req), req.body, req.ip));

  app.get("/api/admin/tickets", R, async (req) => admin.listTickets(deps, z.object({ status: z.enum(["open", "in_progress", "resolved", "rejected"]).optional() }).parse(req.query).status));
  app.post("/api/admin/tickets/:id/reply", W, async (req) => admin.replyTicket(deps, me(req), z.string().regex(/^\d+$/).parse((req.params as { id: string }).id), req.body, req.ip));

  app.get("/api/admin/users", R, async (req) => admin.searchUsers(deps, z.object({ q: z.string().max(64).default("") }).parse(req.query).q));
  app.post("/api/admin/users/:id/credits", W, async (req) => admin.adjustCredits(deps, me(req), id(req), req.body, req.ip));

  app.get("/api/admin/payments", R, async (req) => admin.listPayments(deps, z.object({ status: z.enum(["pending", "paid", "refunded", "failed", "cancelled"]).optional() }).parse(req.query).status));
  app.post("/api/admin/payments/:id/refund", W, async (req) => admin.adminRefund(deps, me(req), id(req), req.ip));

  app.get("/api/admin/audit", R, async (req) => admin.listAudit(deps, z.object({ action: z.string().max(40).optional(), limit: z.coerce.number().int().optional() }).parse(req.query)));
}
