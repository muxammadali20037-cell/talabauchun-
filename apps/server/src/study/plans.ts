import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { AppError, notFound } from "../lib/errors";

export const PlanInput = z.object({
  title: z.string().min(1).max(200),
  examDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dailyMinutes: z.number().int().min(10).max(600),
  topics: z.array(z.object({ name: z.string().min(1).max(200), documentId: z.string().uuid().optional(), weight: z.number().min(0.5).max(3).optional() })).min(1).max(40),
});

/** Local calendar date (YYYY-MM-DD) in the user's time zone. */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** UTC instant for 20:00 local time on a local date (the default "due by" time of a study task). */
export function dueInstant(localDay: string, tz: string, hour = 20): Date {
  const [y, m, d] = localDay.split("-").map(Number) as [number, number, number];
  // find the UTC offset of the zone on that day by formatting a probe instant
  const probe = new Date(Date.UTC(y, m - 1, d, hour, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(probe);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(probe.getTime() - (asLocal - probe.getTime()));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds a day-by-day plan until the exam: each topic gets study time
 * proportional to its weight (weak topics from diagnostics weigh more), the
 * last day before the exam is reserved for review. Times are stored in UTC.
 */
export function buildSchedule(p: { today: string; examDate: string; dailyMinutes: number; topics: { name: string; weight: number }[] }) {
  const days: string[] = [];
  for (let d = p.today; d < p.examDate; d = addDays(d, 1)) days.push(d);
  if (!days.length) throw new AppError("exam_date_in_past", 400);
  const studyDays = days.length > 1 ? days.slice(0, -1) : days;
  const reviewDay = days.length > 1 ? days[days.length - 1]! : null;
  const total = p.topics.reduce((s, t) => s + t.weight, 0);
  const budget = studyDays.length * p.dailyMinutes;
  // minutes per topic, in 15-minute blocks
  const blocks = p.topics.map((t) => ({ name: t.name, left: Math.max(15, Math.round(((budget * t.weight) / total) / 15) * 15) }));
  const tasks: { day: string; topic: string; minutes: number; kind: "study" | "review" }[] = [];
  let ti = 0;
  for (const day of studyDays) {
    let free = p.dailyMinutes;
    while (free >= 15 && blocks.some((b) => b.left > 0)) {
      const b = blocks[ti % blocks.length]!;
      ti++;
      if (b.left <= 0) continue;
      const m = Math.min(b.left, free, 60);
      tasks.push({ day, topic: b.name, minutes: m, kind: "study" });
      b.left -= m;
      free -= m;
    }
  }
  if (reviewDay) tasks.push({ day: reviewDay, topic: "*", minutes: p.dailyMinutes, kind: "review" });
  return tasks;
}

export async function createPlan(deps: Deps, user: UserRow, raw: unknown) {
  const p = PlanInput.parse(raw);
  const today = localDate(new Date(), user.timezone);
  if (p.examDate <= today) throw new AppError("exam_date_in_past", 400);
  // weak topics: more mistakes recorded for questions mentioning the topic weigh more
  const weights = await Promise.all(
    p.topics.map(async (t) => {
      if (t.weight) return t.weight;
      const [r] = await deps.sql<{ n: number }[]>`
        select count(*)::int as n from attempt_answers aa join attempts a on a.id = aa.attempt_id join questions q on q.id = aa.question_id
        where a.user_id = ${user.id} and not aa.is_correct and (q.topic ilike ${"%" + t.name + "%"} or q.text ilike ${"%" + t.name + "%"})`;
      return 1 + Math.min(2, (r?.n ?? 0) / 3);
    }),
  );
  const schedule = buildSchedule({ today, examDate: p.examDate, dailyMinutes: p.dailyMinutes, topics: p.topics.map((t, i) => ({ name: t.name, weight: weights[i]! })) });
  return deps.sql.begin(async (tx) => {
    const [plan] = await tx<{ id: string }[]>`
      insert into study_plans (user_id, workspace_id, title, exam_date, daily_minutes, topics, timezone)
      values (${user.id}, ${user.personal_workspace_id}, ${p.title}, ${p.examDate}, ${p.dailyMinutes}, ${tx.json(p.topics.map((t, i) => ({ ...t, weight: weights[i] })) as never)}, ${user.timezone}) returning id`;
    let pos = 0;
    for (const s of schedule) {
      await tx`insert into tasks (workspace_id, plan_id, title, kind, assignee_id, due_at, created_by, topic, minutes, position)
        values (${user.personal_workspace_id}, ${plan!.id}, ${s.kind === "review" ? "Umumiy takrorlash" : s.topic}, ${s.kind}, ${user.id}, ${dueInstant(s.day, user.timezone)}, ${user.id}, ${s.topic}, ${s.minutes}, ${pos++})`;
    }
    return { planId: plan!.id, tasks: schedule.length };
  });
}

export async function getPlan(deps: Deps, user: UserRow, planId: string) {
  const [plan] = await deps.sql<{ id: string; title: string; exam_date: string; daily_minutes: number; topics: unknown; timezone: string; status: string }[]>`
    select id, title, exam_date::text, daily_minutes, topics, timezone, status from study_plans where id = ${planId} and user_id = ${user.id}`;
  if (!plan) throw notFound("plan");
  const tasks = await deps.sql<{ id: string; title: string; kind: string; topic: string | null; minutes: number | null; due_at: Date; status: string; rescheduled_count: number }[]>`
    select id, title, kind, topic, minutes, due_at, status, rescheduled_count from tasks where plan_id = ${planId} order by due_at, position`;
  const today = localDate(new Date(), plan.timezone);
  const overdue = tasks.filter((t) => (t.status === "todo" || t.status === "in_progress") && localDate(t.due_at, plan.timezone) < today).length;
  return {
    ...plan,
    today,
    overdue,
    tasks: tasks.map((t) => ({ ...t, day: localDate(t.due_at, plan.timezone) })),
    progress: { done: tasks.filter((t) => t.status === "done").length, total: tasks.length },
  };
}

export async function listPlans(deps: Deps, user: UserRow) {
  return deps.sql`select p.id, p.title, p.exam_date::text, p.status,
      (select count(*)::int from tasks t where t.plan_id = p.id) as total,
      (select count(*)::int from tasks t where t.plan_id = p.id and t.status = 'done') as done
    from study_plans p where p.user_id = ${user.id} order by p.exam_date limit 50`;
}

/** Only the user marks tasks done; nothing is auto-completed. */
export async function setTaskStatus(deps: Deps, user: UserRow, taskId: string, status: "todo" | "in_progress" | "done" | "skipped") {
  const r = await deps.sql`update tasks set status = ${status}, completed_at = case when ${status}::text = 'done' then now() else null end, updated_at = now()
    where id = ${taskId} and (assignee_id = ${user.id} or created_by = ${user.id}) returning id`;
  if (!r.length) throw notFound("task");
}

/**
 * Missed days: unfinished past tasks are spread over the remaining days
 * before the exam (keeping the review day), without deleting anything.
 */
export async function rebalancePlan(deps: Deps, user: UserRow, planId: string) {
  const plan = await getPlan(deps, user, planId);
  const today = plan.today;
  const overdue = plan.tasks.filter((t) => (t.status === "todo" || t.status === "in_progress") && t.day < today && t.kind === "study");
  const days: string[] = [];
  for (let d = today; d < plan.exam_date; d = addDays(d, 1)) days.push(d);
  const studyDays = days.length > 1 ? days.slice(0, -1) : days;
  if (!studyDays.length || !overdue.length) return { moved: 0 };
  const load = new Map(studyDays.map((d) => [d, plan.tasks.filter((t) => t.day === d && t.status !== "skipped").reduce((s, t) => s + (t.minutes ?? 0), 0)]));
  let moved = 0;
  for (const t of overdue) {
    const target = [...load.entries()].sort((a, b) => a[1] - b[1])[0]![0];
    load.set(target, (load.get(target) ?? 0) + (t.minutes ?? 0));
    await deps.sql`update tasks set due_at = ${dueInstant(target, plan.timezone)}, rescheduled_count = rescheduled_count + 1, updated_at = now() where id = ${t.id}`;
    moved++;
  }
  return { moved };
}
