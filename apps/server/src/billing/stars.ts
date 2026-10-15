import { translate } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { getUserByTelegramId } from "../auth/users";
import { randomToken } from "../lib/crypto";
import { AppError } from "../lib/errors";

import type { PlanRow } from "./plans";

/**
 * Telegram Stars (XTR) purchases of digital services, following
 * core.telegram.org/bots/payments-stars: invoice with currency "XTR" and an
 * empty provider_token, pre-checkout validation, and crediting ONLY after the
 * server receives `successful_payment` (never from a client-side "success").
 */
/** Creates the pending payment row whose payload is echoed back by Telegram in pre_checkout and successful_payment. */
async function createPendingPayment(deps: Deps, user: UserRow, planCode: string) {
  const [plan] = await deps.sql<PlanRow[]>`select * from plans where code = ${planCode} and active and price_stars > 0`;
  if (!plan) throw new AppError("plan_unavailable", 404);
  const payload = `p_${randomToken(18)}`;
  const [pay] = await deps.sql<{ id: string }[]>`insert into payments (user_id, plan_code, plan_snapshot, invoice_payload, amount, credits)
    values (${user.id}, ${plan.code}, ${deps.sql.json(plan as never)}, ${payload}, ${plan.price_stars}, ${plan.credits}) returning id`;
  const lang = user.language;
  const title = (plan.title[lang] ?? plan.title.uz ?? plan.code).slice(0, 32);
  const invoice = {
    title,
    description: translate(lang, "billing.invoiceDescription", { title, credits: plan.credits, days: plan.period_days ?? 0 }).slice(0, 255),
    payload,
    provider_token: "",
    currency: "XTR",
    prices: [{ label: title, amount: plan.price_stars }],
  };
  return { paymentId: pay!.id, invoice };
}

export async function sendPlanInvoice(deps: Deps, user: UserRow, chatId: number | string, planCode: string) {
  if (!deps.cfg.PAYMENTS_ENABLED || !deps.tg) {
    return deps.tg?.callWithRetry("sendMessage", { chat_id: chatId, text: translate(user.language, "bot.paymentsDisabled") });
  }
  const { invoice } = await createPendingPayment(deps, user, planCode);
  return deps.tg.callWithRetry("sendInvoice", { chat_id: chatId, ...invoice });
}

/** Invoice link for the Mini App (Telegram.WebApp.openInvoice). The client's "paid" callback is only a hint; credits come from successful_payment. */
export async function createPlanInvoiceLink(deps: Deps, user: UserRow, planCode: string) {
  if (!deps.cfg.PAYMENTS_ENABLED) throw new AppError("payments_disabled", 409);
  if (!deps.tg) throw new AppError("telegram_not_configured", 503);
  const { paymentId, invoice } = await createPendingPayment(deps, user, planCode);
  const link = await deps.tg.callWithRetry<string>("createInvoiceLink", invoice);
  return { paymentId, link };
}

/** The user closed the invoice: the pending payment can no longer be paid (pre-checkout will refuse it). */
export async function cancelPendingPayment(deps: Deps, user: Pick<UserRow, "id">, paymentId: string) {
  const r = await deps.sql`update payments set status = 'cancelled' where id = ${paymentId} and user_id = ${user.id} and status = 'pending' returning id`;
  return { cancelled: r.length > 0 };
}

export async function handlePreCheckout(deps: Deps, q: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string }) {
  const [p] = await deps.sql<{ status: string; amount: number; currency: string; plan_code: string; plan_snapshot: PlanRow; user_tg: string }[]>`
    select p.status, p.amount, p.currency, p.plan_code, p.plan_snapshot, u.telegram_id::text as user_tg from payments p join users u on u.id = p.user_id where p.invoice_payload = ${q.invoice_payload}`;
  const [plan] = p ? await deps.sql<PlanRow[]>`select * from plans where code = ${p.plan_code}` : [];
  const ok =
    !!p && p.status === "pending" && p.currency === q.currency && q.currency === "XTR" && p.amount === q.total_amount && p.user_tg === String(q.from.id) &&
    !!plan && plan.active && plan.version === p.plan_snapshot.version;
  await deps.tg?.call("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: "Invoice is no longer valid. Please request a new one." });
  return ok;
}

/** Idempotent on telegram_payment_charge_id: a repeated update never credits twice. */
export async function handleSuccessfulPayment(
  deps: Deps,
  user: Pick<UserRow, "id">,
  sp: { currency: string; total_amount: number; invoice_payload: string; telegram_payment_charge_id: string; provider_payment_charge_id?: string },
) {
  return deps.sql.begin(async (tx) => {
    const [p] = await tx<{ id: string; status: string; amount: number; credits: number; plan_code: string; plan_snapshot: PlanRow; user_id: string; telegram_payment_charge_id: string | null }[]>`
      select id, status, amount, credits, plan_code, plan_snapshot, user_id, telegram_payment_charge_id from payments where invoice_payload = ${sp.invoice_payload} for update`;
    if (!p) {
      await tx`insert into audit_events (actor_id, action, target_type, target_id, data) values (${user.id}, 'payment.unknown_payload', 'payment', ${sp.telegram_payment_charge_id}, ${tx.json(sp as never)})`;
      return { credited: false, reason: "unknown_payload" };
    }
    if (p.status === "paid" || p.status === "refunded") return { credited: false, reason: "duplicate", paymentId: p.id };
    if (p.user_id !== user.id || sp.currency !== "XTR" || sp.total_amount !== p.amount) {
      await tx`update payments set status = 'failed', raw = ${tx.json(sp as never)} where id = ${p.id}`;
      return { credited: false, reason: "mismatch", paymentId: p.id };
    }
    await tx`update payments set status = 'paid', paid_at = now(), telegram_payment_charge_id = ${sp.telegram_payment_charge_id},
      payer_telegram_id = (select telegram_id from users where id = ${p.user_id}),
      provider_payment_charge_id = ${sp.provider_payment_charge_id ?? null}, raw = ${tx.json(sp as never)} where id = ${p.id}`;
    await tx`insert into credit_ledger (user_id, entry_type, amount, payment_id, reason, idempotency_key)
      values (${p.user_id}, 'purchase', ${p.credits}, ${p.id}, ${"plan " + p.plan_code}, ${"purchase:" + sp.telegram_payment_charge_id})
      on conflict (idempotency_key) do nothing`;
    if (p.plan_snapshot.period_days) {
      await tx`insert into entitlements (user_id, plan_code, plan_snapshot, ends_at, source_payment_id)
        values (${p.user_id}, ${p.plan_code}, ${tx.json(p.plan_snapshot as never)}, now() + make_interval(days => ${p.plan_snapshot.period_days}), ${p.id})`;
    }
    return { credited: true, paymentId: p.id, credits: p.credits };
  });
}

/** Admin refund: calls refundStarPayment first; ledger/entitlements change only after Telegram confirms. */
export async function refundPayment(deps: Deps, adminId: string, paymentId: string) {
  const [p] = await deps.sql<{ id: string; status: string; credits: number; user_id: string; telegram_payment_charge_id: string | null; user_tg: string }[]>`
    select p.id, p.status, p.credits, p.user_id, p.telegram_payment_charge_id, coalesce(p.payer_telegram_id, u.telegram_id)::text as user_tg from payments p join users u on u.id = p.user_id where p.id = ${paymentId}`;
  if (!p) throw new AppError("not_found", 404);
  if (p.status === "refunded") return { refunded: false, reason: "already_refunded" };
  if (p.status !== "paid" || !p.telegram_payment_charge_id) throw new AppError("not_refundable", 409);
  if (!deps.tg) throw new AppError("telegram_not_configured", 503);
  if (!p.user_tg) throw new AppError("payer_unknown", 409);
  await deps.tg.call("refundStarPayment", { user_id: Number(p.user_tg), telegram_payment_charge_id: p.telegram_payment_charge_id });
  await applyRefund(deps, p.telegram_payment_charge_id, adminId);
  return { refunded: true };
}

/** Shared by the admin action and the `refunded_payment` service message (idempotent). */
export async function applyRefund(deps: Deps, chargeId: string, actorId: string | null) {
  await deps.sql.begin(async (tx) => {
    const [p] = await tx<{ id: string; status: string; credits: number; user_id: string }[]>`select id, status, credits, user_id from payments where telegram_payment_charge_id = ${chargeId} for update`;
    if (!p || p.status === "refunded") return;
    await tx`update payments set status = 'refunded', refunded_at = now() where id = ${p.id}`;
    await tx`insert into credit_ledger (user_id, entry_type, amount, payment_id, reason, idempotency_key)
      values (${p.user_id}, 'refund', ${-p.credits}, ${p.id}, 'payment refunded', ${"refund:" + chargeId}) on conflict (idempotency_key) do nothing`;
    await tx`update entitlements set status = 'revoked', ends_at = now() where source_payment_id = ${p.id} and status = 'active'`;
    await tx`insert into audit_events (actor_id, action, target_type, target_id) values (${actorId}, 'payment.refund', 'payment', ${p.id})`;
  });
}

export async function userForTelegram(deps: Deps, telegramId: number) {
  return getUserByTelegramId(deps.sql, telegramId);
}
