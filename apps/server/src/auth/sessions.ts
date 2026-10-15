import type { Config } from "../config";
import type { Sql } from "../db/index";
import { randomToken, sha256 } from "../lib/crypto";
import { unauthorized } from "../lib/errors";
import { getUserById, type UserRow } from "./users";

export async function createSession(sql: Sql, cfg: Config, userId: string, method: "telegram_webapp" | "dev", initDataHash?: string, initAuthDate?: Date) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + cfg.SESSION_TTL_HOURS * 3600_000);
  await sql`
    insert into sessions (user_id, token_hash, auth_method, init_data_hash, expires_at, init_auth_date)
    values (${userId}, ${sha256(token)}, ${method}, ${initDataHash ?? null}, ${expiresAt}, ${initAuthDate ?? null})`;
  await sql`insert into user_activity (user_id, day) values (${userId}, current_date) on conflict do nothing`;
  return { token, expiresAt };
}

export async function resolveSession(sql: Sql, token: string | undefined | null): Promise<UserRow> {
  if (!token || token.length < 20 || token.length > 200) throw unauthorized("no session");
  const [s] = await sql<{ user_id: string; expires_at: Date; last_seen_at: Date | null; id: string }[]>`
    select id, user_id, expires_at, last_seen_at from sessions
    where token_hash = ${sha256(token)} and revoked_at is null and expires_at > now()`;
  if (!s) throw unauthorized("session expired");
  if (!s.last_seen_at || Date.now() - s.last_seen_at.getTime() > 60_000) {
    await sql`update sessions set last_seen_at = now() where id = ${s.id}`;
    // one row per user per day: the basis for D1/D7/D30 retention (no content, no events)
    await sql`insert into user_activity (user_id, day) values (${s.user_id}, current_date) on conflict do nothing`;
  }
  const user = await getUserById(sql, s.user_id);
  if (!user) throw unauthorized("user missing");
  return user;
}

export async function revokeSession(sql: Sql, token: string) {
  await sql`update sessions set revoked_at = now() where token_hash = ${sha256(token)}`;
}
