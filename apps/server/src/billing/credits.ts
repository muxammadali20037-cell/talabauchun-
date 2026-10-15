import { randomUUID } from "node:crypto";
import type { Sql, Tx } from "../db/index";
import { AppError } from "../lib/errors";

/**
 * Credit ledger: balance = SUM(amount). A job reserves credits up front
 * (negative `reserve` entry), then either captures (keeps all or part, returning
 * the rest with a `release`) or releases everything on failure/cancel.
 * Every entry has a unique idempotency key, so retries and duplicate clicks
 * never debit twice.
 */
export async function getBalance(sql: Sql | Tx, userId: string): Promise<number> {
  const [r] = await sql<{ balance: string | null }[]>`select coalesce(sum(amount), 0)::text as balance from credit_ledger where user_id = ${userId}`;
  return Number(r?.balance ?? 0);
}

export async function grantFreeCredits(tx: Sql | Tx, userId: string, now = new Date()) {
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [plan] = await tx<{ credits: number }[]>`select credits from plans where code = 'free'`;
  const amount = plan?.credits ?? 0;
  if (amount <= 0) return;
  await tx`
    insert into credit_ledger (user_id, entry_type, amount, reason, idempotency_key)
    values (${userId}, 'grant', ${amount}, ${"free monthly " + period}, ${`free:${userId}:${period}`})
    on conflict (idempotency_key) do nothing`;
}

export async function reserveCredits(tx: Tx, userId: string, amount: number, key: string, jobId: string | null): Promise<string | null> {
  if (amount <= 0) return null;
  const [existing] = await tx<{ reservation_id: string }[]>`select reservation_id from credit_ledger where idempotency_key = ${"reserve:" + key}`;
  if (existing) return existing.reservation_id;
  // serialise concurrent reservations for one user
  await tx`select id from users where id = ${userId} for update`;
  const balance = await getBalance(tx, userId);
  if (balance < amount) throw new AppError("credits_insufficient", 402, "not enough credits", { need: amount, balance });
  const reservationId = randomUUID();
  await tx`
    insert into credit_ledger (user_id, entry_type, amount, reservation_id, job_id, reason, idempotency_key)
    values (${userId}, 'reserve', ${-amount}, ${reservationId}, ${jobId}, 'job reservation', ${"reserve:" + key})`;
  return reservationId;
}

async function reservationState(tx: Sql | Tx, reservationId: string) {
  const rows = await tx<{ entry_type: string; amount: number; user_id: string; job_id: string | null }[]>`
    select entry_type, amount, user_id, job_id from credit_ledger where reservation_id = ${reservationId}`;
  const reserve = rows.find((r) => r.entry_type === "reserve");
  return {
    reserve,
    captured: rows.some((r) => r.entry_type === "capture"),
    released: rows.filter((r) => r.entry_type === "release").reduce((s, r) => s + r.amount, 0),
  };
}

/** Finalise a reservation, charging `actual` (<= reserved) and returning the remainder. */
export async function captureCredits(tx: Sql | Tx, reservationId: string, actual: number) {
  const st = await reservationState(tx, reservationId);
  if (!st.reserve || st.captured || st.released > 0) return;
  const reserved = -st.reserve.amount;
  const charge = Math.max(0, Math.min(reserved, Math.round(actual)));
  if (reserved - charge > 0) {
    await tx`
      insert into credit_ledger (user_id, entry_type, amount, reservation_id, job_id, reason, idempotency_key)
      values (${st.reserve.user_id}, 'release', ${reserved - charge}, ${reservationId}, ${st.reserve.job_id}, 'unused reservation', ${"release:" + reservationId})
      on conflict (idempotency_key) do nothing`;
  }
  await tx`
    insert into credit_ledger (user_id, entry_type, amount, reservation_id, job_id, reason, idempotency_key)
    values (${st.reserve.user_id}, 'capture', 0, ${reservationId}, ${st.reserve.job_id}, ${"charged " + charge}, ${"capture:" + reservationId})
    on conflict (idempotency_key) do nothing`;
}

export async function releaseCredits(tx: Sql | Tx, reservationId: string, reason = "job failed or cancelled") {
  const st = await reservationState(tx, reservationId);
  if (!st.reserve || st.captured || st.released > 0) return;
  await tx`
    insert into credit_ledger (user_id, entry_type, amount, reservation_id, job_id, reason, idempotency_key)
    values (${st.reserve.user_id}, 'release', ${-st.reserve.amount}, ${reservationId}, ${st.reserve.job_id}, ${reason}, ${"release:" + reservationId})
    on conflict (idempotency_key) do nothing`;
}

/**
 * Pilot pricing in credits. These are placeholders until the cost model in
 * docs/cost-model.md is validated with real usage; admins can override them
 * via the `pricing` feature flag.
 */
export type PricingInput =
  | { kind: "ingest"; pages: number; scanned: boolean }
  | { kind: "quiz"; questions: number; ai: boolean }
  | { kind: "deck"; slides: number; ai: boolean }
  | { kind: "slide_regen"; ai: boolean }
  | { kind: "export" };

export const DEFAULT_PRICING = {
  ingestPagesPerCredit: 50,
  ocrPagesPerCredit: 10,
  quizAiQuestionsPerCredit: 2,
  quizExtractiveQuestionsPerCredit: 5,
  deckAiCreditsPerSlide: 1,
  deckExtractiveSlidesPerCredit: 3,
  slideRegenAi: 1,
  slideRegenExtractive: 0,
};
export type Pricing = typeof DEFAULT_PRICING;

export async function loadPricing(sql: Sql | Tx): Promise<Pricing> {
  const [flag] = await sql<{ data: Partial<Pricing> }[]>`select data from feature_flags where key = 'pricing' and enabled`;
  return { ...DEFAULT_PRICING, ...(flag?.data ?? {}) };
}

export function estimateCredits(p: Pricing, input: PricingInput): number {
  switch (input.kind) {
    case "ingest":
      // text extraction: the first block of pages is free; OCR is charged per page block
      return input.scanned ? Math.ceil(input.pages / p.ocrPagesPerCredit) : Math.max(0, Math.ceil(input.pages / p.ingestPagesPerCredit) - 1);
    case "quiz":
      return Math.ceil(input.questions / (input.ai ? p.quizAiQuestionsPerCredit : p.quizExtractiveQuestionsPerCredit));
    case "deck":
      return input.ai ? input.slides * p.deckAiCreditsPerSlide : Math.ceil(input.slides / p.deckExtractiveSlidesPerCredit);
    case "slide_regen":
      return input.ai ? p.slideRegenAi : p.slideRegenExtractive;
    case "export":
      return 0;
  }
}
