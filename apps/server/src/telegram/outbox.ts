import type { Sql, Tx } from "../db/index";
import { TelegramError, type TelegramApi } from "./api";

/**
 * Durable outbound queue for non-interactive bot messages (job finished,
 * reminders, group quiz results). Results are already stored in the DB before a
 * message is enqueued, so a failed delivery never loses the user's work.
 */
export async function enqueueMessage(
  sql: Sql | Tx,
  msg: { chatId: number | string; method: string; payload: Record<string, unknown>; userId?: string | null; dedupeKey?: string; notBefore?: Date },
) {
  const r = await sql`
    insert into notifications (user_id, chat_id, method, payload, dedupe_key, next_attempt_at)
    values (${msg.userId ?? null}, ${String(msg.chatId)}, ${msg.method}, ${sql.json(msg.payload as never)}, ${msg.dedupeKey ?? null}, ${msg.notBefore ?? new Date()})
    on conflict (dedupe_key) do nothing returning id`;
  return r.length > 0;
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Rate limits follow Telegram's published guidance (bots FAQ): about 30
 * messages/second overall, about 1/second per private chat and 20/minute per
 * group. We stay below those and honour retry_after on 429.
 */
export class OutboxSender {
  private global = new TokenBucket(25, 25);
  private perChat = new Map<string, TokenBucket>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly sql: Sql, private readonly api: TelegramApi, private readonly log: (o: object, m: string) => void = () => {}) {}

  private chatBucket(chatId: string) {
    let b = this.perChat.get(chatId);
    if (!b) {
      b = chatId.startsWith("-") ? new TokenBucket(3, 20 / 60) : new TokenBucket(3, 1);
      this.perChat.set(chatId, b);
    }
    return b;
  }

  start(intervalMs = 500) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(batch = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      const rows = await this.sql.begin(async (tx) => {
        const picked = await tx<{ id: string; chat_id: string; method: string; payload: Record<string, unknown>; attempts: number; user_id: string | null }[]>`
          select id, chat_id::text as chat_id, method, payload, attempts, user_id from notifications
          where status = 'pending' and next_attempt_at <= now()
          order by next_attempt_at limit ${batch} for update skip locked`;
        if (picked.length) await tx`update notifications set status = 'sending' where id in ${tx(picked.map((p) => p.id))}`;
        return picked;
      });
      for (const n of rows) {
        if (!this.global.take() || !this.chatBucket(n.chat_id).take()) {
          await this.sql`update notifications set status = 'pending', next_attempt_at = now() + interval '1 second' where id = ${n.id}`;
          continue;
        }
        try {
          const result = await this.api.call(n.method, { chat_id: n.chat_id, ...n.payload });
          await this.sql`update notifications set status = 'sent', sent_at = now(), attempts = attempts + 1, result = ${this.sql.json((result ?? null) as never)} where id = ${n.id}`;
          sent++;
        } catch (e) {
          const err = e instanceof TelegramError ? e : new TelegramError(n.method, 0, String(e));
          const attempts = n.attempts + 1;
          if (err.code === 429) {
            await this.sql`update notifications set status = 'pending', attempts = ${attempts}, last_error = ${err.message},
              next_attempt_at = now() + make_interval(secs => ${Math.max(1, err.retryAfter ?? 5)}) where id = ${n.id}`;
          } else if (err.isRetryable && attempts < 8) {
            await this.sql`update notifications set status = 'pending', attempts = ${attempts}, last_error = ${err.message},
              next_attempt_at = now() + make_interval(secs => ${Math.min(600, 2 ** attempts)}) where id = ${n.id}`;
          } else {
            await this.sql`update notifications set status = ${err.isRetryable ? "dead" : "failed"}, attempts = ${attempts}, last_error = ${err.message} where id = ${n.id}`;
            if (err.isBlocked && n.user_id && !n.chat_id.startsWith("-")) {
              await this.sql`update users set bot_blocked_at = now(), bot_chat_open = false where id = ${n.user_id}`;
            }
            this.log({ notificationId: n.id, code: err.code }, "notification delivery failed");
          }
        }
      }
    } finally {
      this.running = false;
    }
    return sent;
  }
}
