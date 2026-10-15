import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import type { RouteHelpers } from "./app";
import { getBalance, loadPricing } from "../billing/credits";
import { effectiveLimits, listPlans } from "../billing/plans";
import { cancelPendingPayment, createPlanInvoiceLink } from "../billing/stars";
import { notFound } from "../lib/errors";

const uuid = z.string().uuid();
const pid = (req: FastifyRequest) => uuid.parse((req.params as { id: string }).id);

export async function registerBillingRoutes(app: FastifyInstance, deps: Deps, h: RouteHelpers) {
  const pre = { preHandler: h.auth };

  /** Everything the pricing screen needs: what each action costs, balance, current limits and purchasable plans. */
  app.get("/api/billing", pre, async (req) => {
    const user = h.me(req);
    const [plans, pricing, balance, limits] = await Promise.all([listPlans(deps.sql), loadPricing(deps.sql), getBalance(deps.sql, user.id), effectiveLimits(deps.sql, user.id)]);
    return {
      paymentsEnabled: deps.cfg.PAYMENTS_ENABLED && !!deps.tg,
      balance,
      current: limits,
      pricing,
      plans: plans.map((p) => ({ code: p.code, title: p.title[user.language] ?? p.title.uz ?? p.code, priceStars: p.price_stars, credits: p.credits, periodDays: p.period_days, limits: p.limits, purchasable: p.code !== "free" && p.price_stars > 0 })),
    };
  });

  app.post("/api/billing/invoice", { preHandler: h.auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) =>
    createPlanInvoiceLink(deps, h.me(req), z.object({ planCode: z.string().min(1).max(40) }).parse(req.body).planCode),
  );

  /** Polled after openInvoice: only the server-side successful_payment flips this to "paid". */
  app.get("/api/billing/payments/:id", pre, async (req) => {
    const [p] = await deps.sql<{ id: string; status: string; credits: number; amount: number; plan_code: string; paid_at: Date | null }[]>`
      select id, status, credits, amount, plan_code, paid_at from payments where id = ${pid(req)} and user_id = ${h.me(req).id}`;
    if (!p) throw notFound("payment");
    return { ...p, balance: await getBalance(deps.sql, h.me(req).id) };
  });
  app.post("/api/billing/payments/:id/cancel", pre, async (req) => cancelPendingPayment(deps, h.me(req), pid(req)));

  app.get("/api/billing/history", pre, async (req) => {
    const user = h.me(req);
    const ledger = await deps.sql`select id::text, entry_type, amount, reason, created_at from credit_ledger where user_id = ${user.id} order by id desc limit 50`;
    const payments = await deps.sql`select id, plan_code, amount, credits, status, created_at, paid_at, refunded_at from payments where user_id = ${user.id} and status <> 'pending' order by created_at desc limit 20`;
    return { balance: await getBalance(deps.sql, user.id), ledger, payments };
  });
}
