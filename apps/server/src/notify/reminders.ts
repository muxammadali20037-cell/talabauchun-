import { translate, type Lang } from "@talaba/shared";
import type { Deps } from "../deps";
import { enqueueMessage } from "../telegram/outbox";
import { appButton } from "../telegram/ui";

/** Local hour (0–23) and date (YYYY-MM-DD) of `now` in an IANA time zone. */
export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => f.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** Quiet hours may wrap midnight (22 → 7). Equal start/end means "no quiet hours". */
export function inQuietHours(hour: number, start: number | null, end: number | null) {
  if (start == null || end == null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const DIGEST_FROM_HOUR = 9;
const DIGEST_UNTIL_HOUR = 21;

type Candidate = { user_id: string; telegram_id: string; language: Lang; timezone: string; quiet_start: number | null; quiet_end: number | null };

/**
 * Bot reminders, only for people who opened the bot chat, did not block it and
 * keep notifications on:
 *  - one daily study digest (plan tasks for today + flashcards due), sent between
 *    09:00 and 21:00 local time and never inside the user's quiet hours;
 *  - one reminder per group-project task due within 24 h, for its assignee.
 * Every message has a dedupe key, so running this every few minutes is safe.
 */
export async function tickReminders(deps: Deps, now = new Date()) {
  let sent = 0;
  const users = await deps.sql<Candidate[]>`
    select u.id as user_id, u.telegram_id::text, u.language, u.timezone, p.quiet_hours_start as quiet_start, p.quiet_hours_end as quiet_end
    from users u left join profiles p on p.user_id = u.id
    where u.deleted_at is null and u.telegram_id is not null and u.bot_chat_open and u.bot_blocked_at is null and coalesce(p.notifications_enabled, true)
      and (exists (select 1 from tasks t where (t.assignee_id = u.id or (t.plan_id is not null and t.created_by = u.id)) and t.status in ('todo','in_progress') and t.due_at < ${new Date(now.getTime() + 36 * 3600_000)} and t.due_at > ${new Date(now.getTime() - 36 * 3600_000)})
        or exists (select 1 from flashcards f where f.owner_id = u.id and f.deleted_at is null and f.due_at <= ${now}))`;
  for (const u of users) {
    const { date, hour, minute } = localParts(now, u.timezone);
    const quiet = inQuietHours(hour, u.quiet_start, u.quiet_end);

    // daily digest
    if (!quiet && hour >= DIGEST_FROM_HOUR && hour < DIGEST_UNTIL_HOUR) {
      const tasks = await deps.sql<{ title: string; kind: string; minutes: number | null; due_at: Date }[]>`
        select title, kind, minutes, due_at from tasks where plan_id is not null and created_by = ${u.user_id} and status in ('todo','in_progress')
          and due_at > ${new Date(now.getTime() - 36 * 3600_000)} and due_at < ${new Date(now.getTime() + 36 * 3600_000)} order by due_at, position`;
      const today = tasks.filter((x) => localParts(x.due_at, u.timezone).date === date);
      const [cards] = await deps.sql<{ n: number }[]>`select count(*)::int as n from flashcards where owner_id = ${u.user_id} and deleted_at is null and due_at <= ${now}`;
      if (today.length || cards!.n) {
        const lines = [translate(u.language, "reminders.digestTitle")];
        if (today.length) lines.push(translate(u.language, "reminders.planToday", { n: today.length, minutes: today.reduce((s, x) => s + (x.minutes ?? 0), 0) }));
        if (cards!.n) lines.push(translate(u.language, "reminders.cardsDue", { n: cards!.n }));
        lines.push(translate(u.language, "reminders.footer"));
        const button = appButton(deps.cfg, u.language, today.length ? "/plans" : "/cards", "reminders.open");
        const r = await enqueueMessage(deps.sql, {
          chatId: u.telegram_id, userId: u.user_id, method: "sendMessage",
          payload: { text: lines.join("\n"), ...(button.length ? { reply_markup: { inline_keyboard: [button] } } : {}) },
          dedupeKey: `digest:${u.user_id}:${date}`,
        });
        if (r) sent++;
      }
    }

    // group-project deadlines within 24 h (assignee only)
    const due = await deps.sql<{ id: string; title: string; due_at: Date; workspace: string }[]>`
      select t.id, t.title, t.due_at, w.name as workspace from tasks t join workspaces w on w.id = t.workspace_id
      where t.plan_id is null and t.assignee_id = ${u.user_id} and t.status in ('todo','in_progress') and t.due_at > ${now} and t.due_at <= ${new Date(now.getTime() + 24 * 3600_000)}`;
    for (const t of due) {
      // inside quiet hours the message waits until they end
      let notBefore: Date | undefined;
      if (quiet && u.quiet_end != null) {
        const quietEnds = new Date(now.getTime() + (((u.quiet_end - hour + 24) % 24) * 60 - minute) * 60_000);
        // but never later than shortly before the deadline itself
        const latest = new Date(t.due_at.getTime() - 15 * 60_000);
        notBefore = quietEnds < latest ? quietEnds : latest;
        if (notBefore <= now) notBefore = undefined;
      }
      const when = new Intl.DateTimeFormat(u.language === "en" ? "en-GB" : u.language === "ru" ? "ru-RU" : "uz-UZ", { timeZone: u.timezone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(t.due_at);
      const r = await enqueueMessage(deps.sql, {
        chatId: u.telegram_id, userId: u.user_id, method: "sendMessage",
        payload: { text: translate(u.language, "reminders.taskDue", { title: t.title, workspace: t.workspace, when }) },
        dedupeKey: `due:${t.id}:${t.due_at.toISOString()}`, notBefore,
      });
      if (r) sent++;
    }
  }
  return sent;
}
