import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Deps } from "../src/deps";
import { inQuietHours, localParts, tickReminders } from "../src/notify/reminders";
import { createTestDeps, makeUser } from "./helpers/deps";

let deps: Deps;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ deps, cleanup } = await createTestDeps());
});
afterAll(async () => cleanup());

// 2026-10-16 10:00 in Tashkent (UTC+5)
const NOW = new Date("2026-10-16T05:00:00Z");
const at = (iso: string) => new Date(iso);

async function studentWithPlan(opts: { quiet?: [number, number]; notifications?: boolean } = {}) {
  const u = await makeUser(deps);
  await deps.sql`update users set bot_chat_open = true where id = ${u.id}`;
  await deps.sql`update profiles set notifications_enabled = ${opts.notifications ?? true}, quiet_hours_start = ${opts.quiet?.[0] ?? null}, quiet_hours_end = ${opts.quiet?.[1] ?? null} where user_id = ${u.id}`;
  const [plan] = await deps.sql<{ id: string }[]>`insert into study_plans (user_id, workspace_id, title, exam_date, daily_minutes) values (${u.id}, ${u.personal_workspace_id}, 'Iqtisodiyot', '2026-10-20', 60) returning id`;
  await deps.sql`insert into tasks (workspace_id, plan_id, title, kind, minutes, due_at, created_by, position) values
    (${u.personal_workspace_id}, ${plan!.id}, 'Talab va taklif', 'study', 45, ${at("2026-10-16T15:00:00Z")}, ${u.id}, 0),
    (${u.personal_workspace_id}, ${plan!.id}, 'Inflyatsiya', 'study', 15, ${at("2026-10-16T15:00:00Z")}, ${u.id}, 1),
    (${u.personal_workspace_id}, ${plan!.id}, 'Ertangi', 'study', 60, ${at("2026-10-17T15:00:00Z")}, ${u.id}, 0)`;
  return u;
}
const messagesFor = (userId: string) => deps.sql<{ payload: { text: string }; next_attempt_at: Date; dedupe_key: string }[]>`select payload, next_attempt_at, dedupe_key from notifications where user_id = ${userId} order by created_at`;

describe("reminders (time zone, quiet hours, opt-out)", () => {
  it("helpers: local time in Tashkent and quiet hours that wrap midnight", () => {
    expect(localParts(NOW, "Asia/Tashkent")).toEqual({ date: "2026-10-16", hour: 10, minute: 0 });
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(6, 22, 7)).toBe(true);
    expect(inQuietHours(7, 22, 7)).toBe(false);
    expect(inQuietHours(10, 9, 12)).toBe(true);
    expect(inQuietHours(10, null, null)).toBe(false);
  });

  it("sends one daily digest with today's plan only, once per local day", async () => {
    const u = await studentWithPlan();
    await tickReminders(deps, NOW);
    await tickReminders(deps, new Date(NOW.getTime() + 3600_000));
    const msgs = await messagesFor(u.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.payload.text).toContain("2 ta vazifa (~60 daqiqa)");
    expect(msgs[0]!.dedupe_key).toBe(`digest:${u.id}:2026-10-16`);
    // next local day → a new digest
    await tickReminders(deps, at("2026-10-17T05:00:00Z"));
    expect((await messagesFor(u.id)).length).toBe(2);
  });

  it("never before 09:00 local, never inside quiet hours, never when switched off or the bot is blocked", async () => {
    const early = await studentWithPlan();
    await tickReminders(deps, at("2026-10-16T02:00:00Z")); // 07:00 local
    expect((await messagesFor(early.id)).length).toBe(0);

    const quiet = await studentWithPlan({ quiet: [9, 12] });
    await tickReminders(deps, NOW);
    expect((await messagesFor(quiet.id)).length).toBe(0);
    await tickReminders(deps, at("2026-10-16T08:00:00Z")); // 13:00 local
    expect((await messagesFor(quiet.id)).length).toBe(1);

    const off = await studentWithPlan({ notifications: false });
    const blocked = await studentWithPlan();
    await deps.sql`update users set bot_blocked_at = now() where id = ${blocked.id}`;
    await tickReminders(deps, NOW);
    expect((await messagesFor(off.id)).length).toBe(0);
    expect((await messagesFor(blocked.id)).length).toBe(0);
  });

  it("reminds the assignee of a group task due within 24 h; inside quiet hours it waits until they end", async () => {
    const owner = await makeUser(deps);
    const member = await makeUser(deps);
    await deps.sql`update users set bot_chat_open = true where id = ${member.id}`;
    await deps.sql`update profiles set quiet_hours_start = 22, quiet_hours_end = 8 where user_id = ${member.id}`;
    const [ws] = await deps.sql<{ id: string }[]>`insert into workspaces (name, kind, owner_id) values ('Kurs ishi', 'group', ${owner.id}) returning id`;
    await deps.sql`insert into memberships (workspace_id, user_id, role) values (${ws!.id}, ${owner.id}, 'owner'), (${ws!.id}, ${member.id}, 'editor')`;
    await deps.sql`insert into tasks (workspace_id, title, assignee_id, due_at, created_by) values (${ws!.id}, 'Ikkinchi bob', ${member.id}, ${at("2026-10-16T09:00:00Z")}, ${owner.id})`;
    // 23:30 local the night before: quiet → queued for 08:00 local
    await tickReminders(deps, at("2026-10-15T18:30:00Z"));
    const [m] = await messagesFor(member.id);
    expect(m!.payload.text).toContain("Ikkinchi bob");
    expect(m!.next_attempt_at.toISOString()).toBe("2026-10-16T03:00:00.000Z");
    await tickReminders(deps, NOW);
    expect((await messagesFor(member.id)).filter((x) => x.dedupe_key.startsWith("due:")).length).toBe(1);
  });
});
