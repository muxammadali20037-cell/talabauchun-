import { suggestLang, type Lang } from "@talaba/shared";
import type { Config } from "../config";
import type { Sql, Tx } from "../db/index";
import { grantFreeCredits } from "../billing/credits";

export type UserRow = {
  id: string;
  telegram_id: string | null;
  username: string | null;
  first_name: string;
  last_name: string | null;
  language: Lang;
  language_confirmed: boolean;
  edu_role: "student" | "teacher" | null;
  platform_role: "user" | "moderator" | "admin";
  timezone: string;
  onboarding_goal: string | null;
  onboarded_at: Date | null;
  bot_chat_open: boolean;
  bot_blocked_at: Date | null;
  personal_workspace_id: string;
};

export type TelegramIdentity = {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

const USER_COLUMNS = `u.id, u.telegram_id::text as telegram_id, u.username, u.first_name, u.last_name, u.language,
  u.language_confirmed, u.edu_role, u.platform_role, u.timezone, u.onboarding_goal, u.onboarded_at,
  u.bot_chat_open, u.bot_blocked_at, w.id as personal_workspace_id`;

export async function getUserById(sql: Sql | Tx, id: string): Promise<UserRow | null> {
  const rows = await sql.unsafe<UserRow[]>(
    `select ${USER_COLUMNS} from users u join workspaces w on w.owner_id = u.id and w.kind = 'personal'
     where u.id = $1 and u.deleted_at is null`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getUserByTelegramId(sql: Sql | Tx, telegramId: number | string): Promise<UserRow | null> {
  const rows = await sql.unsafe<UserRow[]>(
    `select ${USER_COLUMNS} from users u join workspaces w on w.owner_id = u.id and w.kind = 'personal'
     where u.telegram_id = $1 and u.deleted_at is null`,
    [String(telegramId)],
  );
  return rows[0] ?? null;
}

/**
 * Creates or refreshes the account for a Telegram identity that was verified
 * server-side (Mini App initData signature or a webhook update with the secret).
 * Creates the personal workspace and the monthly free credit grant idempotently.
 */
export async function upsertTelegramUser(sql: Sql, cfg: Config, tg: TelegramIdentity, opts: { privateChat?: boolean } = {}): Promise<UserRow> {
  const telegramId = String(tg.id);
  const isAdmin = cfg.adminTelegramIds.has(telegramId);
  const userId = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into users (telegram_id, username, first_name, last_name, telegram_language, language, platform_role, bot_chat_open)
      values (${telegramId}, ${tg.username ?? null}, ${tg.first_name ?? ""}, ${tg.last_name ?? null}, ${tg.language_code ?? null},
              ${suggestLang(tg.language_code)}, ${isAdmin ? "admin" : "user"}, ${opts.privateChat ?? false})
      on conflict (telegram_id) do update set
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        telegram_language = excluded.telegram_language,
        platform_role = case when ${isAdmin} then 'admin' else users.platform_role end,
        bot_chat_open = users.bot_chat_open or excluded.bot_chat_open,
        bot_blocked_at = case when excluded.bot_chat_open then null else users.bot_blocked_at end,
        updated_at = now()
      returning id`;
    const id = row!.id;
    await tx`insert into profiles (user_id) values (${id}) on conflict do nothing`;
    const [ws] = await tx<{ id: string }[]>`
      insert into workspaces (name, kind, owner_id) values ('Shaxsiy', 'personal', ${id})
      on conflict (owner_id) where kind = 'personal' do nothing returning id`;
    if (ws) await tx`insert into memberships (workspace_id, user_id, role) values (${ws.id}, ${id}, 'owner')`;
    await grantFreeCredits(tx, id);
    return id;
  });
  const user = await getUserById(sql, userId);
  if (!user) throw new Error("user upsert failed");
  return user;
}
