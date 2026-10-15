import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../src/deps";
import { buildApp } from "../src/http/app";
import { signInitData } from "../src/auth/init-data";
import { TelegramApi } from "../src/telegram/api";
import { getBalance } from "../src/billing/credits";
import { createTestDeps, TEST_BOT_TOKEN } from "./helpers/deps";
import { FakeTelegram } from "./helpers/fake-telegram";

let deps: Deps;
let cleanup: () => Promise<void>;
let app: FastifyInstance;
const fake = new FakeTelegram();
let updateId = 5000;
const SECRET = "webhook-secret-test";
const ADMIN_TG = 990001;

beforeAll(async () => {
  await fake.start();
  ({ deps, cleanup } = await createTestDeps({ PAYMENTS_ENABLED: "true", ADMIN_TELEGRAM_IDS: String(ADMIN_TG) }));
  deps.tg = new TelegramApi(TEST_BOT_TOKEN, fake.url);
  app = await buildApp(deps, { logger: false });
  // the operator sets a price first (plans ship inactive with price 0 until the cost model is approved)
  const admin = await login({ id: ADMIN_TG, first_name: "Admin" });
  const r = await app.inject({ method: "PUT", url: "/api/admin/plans/student_plus", headers: auth(admin), payload: { priceStars: 150, credits: 400, active: true } });
  expect(r.statusCode).toBe(200);
});
afterAll(async () => {
  await app.close();
  await fake.stop();
  await cleanup();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function login(u: { id: number; first_name: string }) {
  const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: "AAH" + u.id, user: JSON.stringify({ ...u, language_code: "uz" }) }, TEST_BOT_TOKEN);
  const res = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { initData } });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}
async function webhook(update: Record<string, unknown>, id = updateId++) {
  const r = await app.inject({ method: "POST", url: "/telegram/webhook", headers: { "x-telegram-bot-api-secret-token": SECRET }, payload: { update_id: id, ...update } });
  expect(r.statusCode).toBe(200);
  return r;
}
const from = (id: number) => ({ id, first_name: "Talaba", language_code: "uz", is_bot: false });
const paidMsg = (tgId: number, sp: Record<string, unknown>) => ({ message: { message_id: updateId, from: from(tgId), chat: { id: tgId, type: "private" }, date: 0, successful_payment: sp } });
async function userIdOf(tgId: number) {
  return (await deps.sql<{ id: string }[]>`select id from users where telegram_id = ${tgId}`)[0]!.id;
}

describe("Telegram Stars payments (acceptance 16)", () => {
  it("success: XTR invoice → pre-checkout ok → successful_payment credits once, entitlement with plan snapshot, confirmation", async () => {
    const tgId = 800101;
    await webhook({ message: { message_id: 1, from: from(tgId), chat: { id: tgId, type: "private" }, date: 0, text: "/buy student_plus" } });
    const inv = fake.last("sendInvoice")!.params;
    expect(inv).toMatchObject({ chat_id: tgId, currency: "XTR", provider_token: "", prices: [{ amount: 150 }] });
    const payload = String(inv.payload);
    const uid = await userIdOf(tgId);
    const before = await getBalance(deps.sql, uid);

    await webhook({ pre_checkout_query: { id: "pcq1", from: from(tgId), currency: "XTR", total_amount: 150, invoice_payload: payload } });
    expect(fake.last("answerPreCheckoutQuery")!.params).toEqual({ pre_checkout_query_id: "pcq1", ok: true });

    const sp = { currency: "XTR", total_amount: 150, invoice_payload: payload, telegram_payment_charge_id: "stxCharge-1" };
    await webhook(paidMsg(tgId, sp));
    expect(await getBalance(deps.sql, uid)).toBe(before + 400);
    expect(fake.last("sendMessage")!.params.text).toContain("+400 kredit");
    const [ent] = await deps.sql<{ plan_code: string; plan_snapshot: { price_stars: number; credits: number }; status: string }[]>`select plan_code, plan_snapshot, status from entitlements where user_id = ${uid}`;
    expect(ent).toMatchObject({ plan_code: "student_plus", status: "active", plan_snapshot: { price_stars: 150, credits: 400 } });

    // duplicate delivery: same update id (dedup) and a new update id with the same charge id → no second credit
    const dupId = updateId++;
    await webhook(paidMsg(tgId, sp), dupId);
    await webhook(paidMsg(tgId, sp), dupId);
    await webhook(paidMsg(tgId, sp));
    expect(await getBalance(deps.sql, uid)).toBe(before + 400);
    const purchases = await deps.sql`select 1 from credit_ledger where user_id = ${uid} and entry_type = 'purchase'`;
    expect(purchases.length).toBe(1);
    expect((await deps.sql`select 1 from entitlements where user_id = ${uid}`).length).toBe(1);
  });

  it("failure: wrong amount / currency / foreign payer is refused at pre-checkout; a mismatched successful_payment never credits", async () => {
    const tgId = 800102;
    await webhook({ message: { message_id: 2, from: from(tgId), chat: { id: tgId, type: "private" }, date: 0, text: "/buy student_plus" } });
    const payload = String(fake.last("sendInvoice")!.params.payload);
    for (const [q, why] of [
      [{ currency: "XTR", total_amount: 1, from: from(tgId) }, "amount"],
      [{ currency: "USD", total_amount: 150, from: from(tgId) }, "currency"],
      [{ currency: "XTR", total_amount: 150, from: from(800999) }, "other user"],
    ] as const) {
      await webhook({ pre_checkout_query: { id: `pcq-${why}`, invoice_payload: payload, ...q } });
      expect(fake.last("answerPreCheckoutQuery")!.params, why).toMatchObject({ ok: false });
    }
    const uid = await userIdOf(tgId);
    const before = await getBalance(deps.sql, uid);
    await webhook(paidMsg(tgId, { currency: "XTR", total_amount: 1, invoice_payload: payload, telegram_payment_charge_id: "stxCharge-bad" }));
    expect(await getBalance(deps.sql, uid)).toBe(before);
    expect((await deps.sql<{ status: string }[]>`select status from payments where invoice_payload = ${payload}`)[0]!.status).toBe("failed");
    expect(fake.last("sendMessage")!.params.text).toContain("/paysupport");
  });

  it("cancel: closing the Mini App invoice cancels the pending payment; paying it later is refused", async () => {
    const tgId = 800103;
    const token = await login({ id: tgId, first_name: "Nodira" });
    const billing = (await app.inject({ method: "GET", url: "/api/billing", headers: auth(token) })).json();
    expect(billing.paymentsEnabled).toBe(true);
    expect(billing.plans.find((p: { code: string }) => p.code === "student_plus")).toMatchObject({ priceStars: 150, credits: 400, purchasable: true });
    expect(billing.current.planCode).toBe("free");
    const inv = (await app.inject({ method: "POST", url: "/api/billing/invoice", headers: auth(token), payload: { planCode: "student_plus" } })).json();
    expect(inv.link).toMatch(/^https:\/\/t\.me\/\$/);
    expect(fake.last("createInvoiceLink")!.params).toMatchObject({ currency: "XTR", provider_token: "" });
    const payload = String(fake.last("createInvoiceLink")!.params.payload);
    // the client says "cancelled" → server marks it; a client "paid" would change nothing by itself
    expect((await app.inject({ method: "POST", url: `/api/billing/payments/${inv.paymentId}/cancel`, headers: auth(token) })).json()).toEqual({ cancelled: true });
    const st = (await app.inject({ method: "GET", url: `/api/billing/payments/${inv.paymentId}`, headers: auth(token) })).json();
    expect(st.status).toBe("cancelled");
    await webhook({ pre_checkout_query: { id: "pcq-cancelled", from: from(tgId), currency: "XTR", total_amount: 150, invoice_payload: payload } });
    expect(fake.last("answerPreCheckoutQuery")!.params).toMatchObject({ ok: false });
    // another user cannot read or cancel it
    const other = await login({ id: 800104, first_name: "Boshqa" });
    expect((await app.inject({ method: "GET", url: `/api/billing/payments/${inv.paymentId}`, headers: auth(other) })).statusCode).toBe(404);
  });

  it("plan edits never change what was already sold: an invoice for the old version is refused, the entitlement keeps its snapshot", async () => {
    const tgId = 800105;
    await webhook({ message: { message_id: 3, from: from(tgId), chat: { id: tgId, type: "private" }, date: 0, text: "/buy student_plus" } });
    const payload = String(fake.last("sendInvoice")!.params.payload);
    const admin = await login({ id: ADMIN_TG, first_name: "Admin" });
    await app.inject({ method: "PUT", url: "/api/admin/plans/student_plus", headers: auth(admin), payload: { priceStars: 200 } });
    await webhook({ pre_checkout_query: { id: "pcq-old", from: from(tgId), currency: "XTR", total_amount: 150, invoice_payload: payload } });
    expect(fake.last("answerPreCheckoutQuery")!.params).toMatchObject({ ok: false });
    const [snap] = await deps.sql<{ plan_snapshot: { price_stars: number } }[]>`select e.plan_snapshot from entitlements e join users u on u.id = e.user_id where u.telegram_id = 800101`;
    expect(snap!.plan_snapshot.price_stars).toBe(150);
    await app.inject({ method: "PUT", url: "/api/admin/plans/student_plus", headers: auth(admin), payload: { priceStars: 150 } });
  });

  it("refund: admin refund calls refundStarPayment, reverses credits and revokes the plan once; refunded_payment update is idempotent", async () => {
    const uid = await userIdOf(800101);
    const [p] = await deps.sql<{ id: string }[]>`select id from payments where user_id = ${uid} and status = 'paid'`;
    const admin = await login({ id: ADMIN_TG, first_name: "Admin" });
    const before = await getBalance(deps.sql, uid);
    const r = await app.inject({ method: "POST", url: `/api/admin/payments/${p!.id}/refund`, headers: auth(admin) });
    expect(r.json()).toEqual({ refunded: true });
    expect(fake.last("refundStarPayment")!.params).toEqual({ user_id: 800101, telegram_payment_charge_id: "stxCharge-1" });
    expect(await getBalance(deps.sql, uid)).toBe(before - 400);
    expect((await deps.sql<{ status: string }[]>`select status from entitlements where user_id = ${uid}`)[0]!.status).toBe("revoked");
    // Telegram's refunded_payment service message for the same charge, and a second admin click: no further change
    await webhook({ message: { message_id: 9, from: from(800101), chat: { id: 800101, type: "private" }, date: 0, refunded_payment: { currency: "XTR", total_amount: 150, invoice_payload: "x", telegram_payment_charge_id: "stxCharge-1" } } });
    expect((await app.inject({ method: "POST", url: `/api/admin/payments/${p!.id}/refund`, headers: auth(admin) })).json()).toEqual({ refunded: false, reason: "already_refunded" });
    expect(await getBalance(deps.sql, uid)).toBe(before - 400);
    expect((await deps.sql`select 1 from credit_ledger where user_id = ${uid} and entry_type = 'refund'`).length).toBe(1);
    const audit = await deps.sql<{ action: string; ip: string | null }[]>`select action, ip from audit_events where action = 'payment.refund' and target_id = ${p!.id}`;
    expect(audit.length).toBe(1);
    // the user's history shows purchase and refund
    const history = (await app.inject({ method: "GET", url: "/api/billing/history", headers: auth(await login({ id: 800101, first_name: "Talaba" })) })).json();
    expect(history.payments[0].status).toBe("refunded");
    expect(history.ledger.map((l: { entry_type: string }) => l.entry_type)).toEqual(expect.arrayContaining(["purchase", "refund"]));
  });

  it("payments switched off: /buy explains instead of sending an invoice; the Mini App invoice endpoint refuses", async () => {
    deps.cfg.PAYMENTS_ENABLED = false;
    try {
      fake.reset();
      await webhook({ message: { message_id: 4, from: from(800106), chat: { id: 800106, type: "private" }, date: 0, text: "/buy student_plus" } });
      expect(fake.byMethod("sendInvoice").length).toBe(0);
      expect(fake.last("sendMessage")!.params.text).toContain("Toʻlovlar hozircha yoqilmagan");
      const token = await login({ id: 800106, first_name: "X" });
      expect((await app.inject({ method: "POST", url: "/api/billing/invoice", headers: auth(token), payload: { planCode: "student_plus" } })).json().error.code).toBe("payments_disabled");
    } finally {
      deps.cfg.PAYMENTS_ENABLED = true;
    }
  });
});
