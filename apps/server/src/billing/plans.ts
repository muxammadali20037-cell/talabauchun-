import { z } from "zod";
import type { Sql, Tx } from "../db/index";
import { AppError, notFound } from "../lib/errors";

export type PlanLimits = { maxQuestionsPerQuiz?: number; maxUploadMb?: number; maxSlides?: number; maxOcrPagesPerMonth?: number };
export type PlanRow = { code: string; title: Record<string, string>; price_stars: number; credits: number; period_days: number | null; limits: PlanLimits; active: boolean; version: number; updated_at: Date };

const DEFAULT_LIMITS: Required<PlanLimits> = { maxQuestionsPerQuiz: 30, maxUploadMb: 50, maxSlides: 20, maxOcrPagesPerMonth: 300 };

/**
 * Limits in force for a user: the snapshot stored with their active
 * entitlement (terms they paid for never change silently when an admin edits
 * the plan later), otherwise the current free plan.
 */
export async function effectiveLimits(sql: Sql | Tx, userId: string): Promise<Required<PlanLimits> & { planCode: string; endsAt: Date | null }> {
  const [ent] = await sql<{ plan_code: string; plan_snapshot: { limits?: PlanLimits }; ends_at: Date | null }[]>`
    select plan_code, plan_snapshot, ends_at from entitlements
    where user_id = ${userId} and status = 'active' and (ends_at is null or ends_at > now()) order by created_at desc limit 1`;
  if (ent) return { ...DEFAULT_LIMITS, ...(ent.plan_snapshot.limits ?? {}), planCode: ent.plan_code, endsAt: ent.ends_at };
  const [free] = await sql<{ limits: PlanLimits }[]>`select limits from plans where code = 'free'`;
  return { ...DEFAULT_LIMITS, ...(free?.limits ?? {}), planCode: "free", endsAt: null };
}

export async function listPlans(sql: Sql | Tx, opts: { includeInactive?: boolean } = {}) {
  return sql<PlanRow[]>`select code, title, price_stars, credits, period_days, limits, active, version, updated_at from plans
    where ${opts.includeInactive ?? false} or active order by price_stars, code`;
}

export const PlanUpdate = z.object({
  title: z.record(z.string(), z.string().min(1).max(32)).optional(),
  priceStars: z.number().int().min(0).max(100_000).optional(),
  credits: z.number().int().min(0).max(1_000_000).optional(),
  periodDays: z.number().int().min(1).max(366).nullable().optional(),
  limits: z.object({ maxQuestionsPerQuiz: z.number().int().min(1).max(200), maxUploadMb: z.number().int().min(1).max(500), maxSlides: z.number().int().min(1).max(80), maxOcrPagesPerMonth: z.number().int().min(0).max(100_000) }).partial().optional(),
  active: z.boolean().optional(),
});

/**
 * Admin edit of a plan. Each change bumps `version`; invoices issued for an
 * older version are rejected at pre-checkout, and existing entitlements keep
 * their own snapshot, so nobody is charged or limited under terms they did
 * not see.
 */
export async function updatePlan(sql: Sql, adminId: string, code: string, raw: unknown) {
  const p = PlanUpdate.parse(raw);
  return sql.begin(async (tx) => {
    const [cur] = await tx<PlanRow[]>`select * from plans where code = ${code} for update`;
    if (!cur) throw notFound("plan");
    if (code === "free" && (p.priceStars ?? 0) > 0) throw new AppError("free_plan_price", 400);
    const next = {
      title: p.title ? { ...cur.title, ...p.title } : cur.title,
      price_stars: p.priceStars ?? cur.price_stars,
      credits: p.credits ?? cur.credits,
      period_days: p.periodDays === undefined ? cur.period_days : p.periodDays,
      limits: p.limits ? { ...cur.limits, ...p.limits } : cur.limits,
      active: p.active ?? cur.active,
    };
    if (next.active && code !== "free" && next.price_stars <= 0) throw new AppError("plan_price_required", 400, "a paid plan needs a price before it can be sold");
    await tx`update plans set title = ${tx.json(next.title as never)}, price_stars = ${next.price_stars}, credits = ${next.credits}, period_days = ${next.period_days},
      limits = ${tx.json(next.limits as never)}, active = ${next.active}, version = version + 1, updated_by = ${adminId}, updated_at = now() where code = ${code}`;
    await tx`insert into audit_events (actor_id, action, target_type, target_id, data) values (${adminId}, 'plan.update', 'plan', ${code},
      ${tx.json({ before: { price_stars: cur.price_stars, credits: cur.credits, period_days: cur.period_days, limits: cur.limits, active: cur.active, version: cur.version }, after: next } as never)})`;
    const [row] = await tx<PlanRow[]>`select * from plans where code = ${code}`;
    return row!;
  });
}
