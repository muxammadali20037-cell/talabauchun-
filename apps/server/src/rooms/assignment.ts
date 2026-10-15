import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import { AppError } from "../lib/errors";
import { shuffle } from "../lib/crypto";
import { getRoom, requireMember } from "./service";

/**
 * Self-paced assignment (room mode "async"): each participant takes the quiz
 * once, at their own pace, until the deadline. Scoring is the server's (the
 * practice attempt engine: option ids, private answer keys). The leaderboard
 * opens after the deadline or when the host closes the assignment.
 */
async function assignmentRoom(deps: Deps, roomId: string) {
  const room = await getRoom(deps.sql, roomId);
  if (room.settings.mode !== "async") throw new AppError("not_an_assignment", 409);
  return room;
}

const isOpen = (room: Awaited<ReturnType<typeof assignmentRoom>>) => room.status === "running" && !!room.assignment_due_at && room.assignment_due_at > new Date();

export async function startAssignment(deps: Deps, user: UserRow, roomId: string) {
  const room = await assignmentRoom(deps, roomId);
  const m = await requireMember(deps.sql, roomId, user.id);
  if (m.role === "host") throw new AppError("host_does_not_take", 409);
  const [existing] = await deps.sql<{ id: string }[]>`select id from attempts where room_id = ${roomId} and user_id = ${user.id} and mode = 'room'`;
  if (existing) return { attemptId: existing.id, resumed: true };
  if (!isOpen(room)) throw new AppError("assignment_closed", 409);
  const orders: Record<string, string[]> = {};
  const opts = await deps.sql<{ question_id: string; id: string; type: string }[]>`
    select o.question_id, o.id, q.type from options o join questions q on q.id = o.question_id where o.question_id in ${deps.sql(room.question_ids)} order by o.question_id, o.position`;
  for (const qid of room.question_ids) {
    const list = opts.filter((o) => o.question_id === qid);
    orders[qid] = room.settings.shuffleOptions && list[0]?.type !== "true_false" ? shuffle(list.map((o) => o.id)) : list.map((o) => o.id);
  }
  const [a] = await deps.sql<{ id: string }[]>`
    insert into attempts (quiz_version_id, user_id, mode, room_id, question_ids, option_orders, max_score)
    values (${room.quiz_version_id}, ${user.id}, 'room', ${roomId}, ${room.question_ids}, ${deps.sql.json(orders as never)}, ${room.question_ids.length * 100})
    on conflict (room_id, user_id) where room_id is not null and mode = 'room' do nothing returning id`;
  if (!a) {
    const [again] = await deps.sql<{ id: string }[]>`select id from attempts where room_id = ${roomId} and user_id = ${user.id} and mode = 'room'`;
    return { attemptId: again!.id, resumed: true };
  }
  return { attemptId: a.id, resumed: false };
}

export async function assignmentView(deps: Deps, user: UserRow, roomId: string) {
  const room = await assignmentRoom(deps, roomId);
  const m = await requireMember(deps.sql, roomId, user.id);
  const isHost = room.host_id === user.id || room.co_host_id === user.id || m.role === "host";
  const open = isOpen(room);
  const [mine] = await deps.sql<{ id: string; status: string; score: number; max_score: number; answered: number }[]>`
    select a.id, a.status, a.score, a.max_score, (select count(*)::int from attempt_answers x where x.attempt_id = a.id) as answered
    from attempts a where a.room_id = ${roomId} and a.user_id = ${user.id} and a.mode = 'room'`;
  const rows = await deps.sql<{ user_id: string; name: string; status: string | null; score: number | null; answered: number; finished_at: Date | null }[]>`
    select m.user_id, m.display_name as name, a.status, a.score, coalesce((select count(*)::int from attempt_answers x where x.attempt_id = a.id), 0) as answered, a.finished_at
    from room_members m left join attempts a on a.room_id = m.room_id and a.user_id = m.user_id and a.mode = 'room'
    where m.room_id = ${roomId} and m.role <> 'host' and m.user_id is distinct from ${room.co_host_id} order by a.score desc nulls last, a.finished_at nulls last, m.display_name`;
  const showBoard = !open && (room.settings.showLeaderboard || isHost);
  return {
    roomId, title: room.title, status: open ? "open" : "closed", dueAt: room.assignment_due_at, total: room.question_ids.length, isHost,
    rules: { pointsCorrect: 100, showLeaderboard: room.settings.showLeaderboard },
    me: mine ? { attemptId: mine.id, status: mine.status, score: mine.score, maxScore: mine.max_score, answered: mine.answered } : null,
    // host sees who has started/finished; participants see the ranking only after the deadline
    progress: isHost ? rows.map((r) => ({ userId: r.user_id, name: r.name, state: r.status === "finished" ? "finished" : r.status ? "started" : "not_started", score: r.score ?? 0, answered: r.answered })) : null,
    leaderboard: showBoard ? rows.filter((r) => r.status).map((r, i) => ({ rank: i + 1, name: r.name, score: r.score ?? 0, isMe: r.user_id === user.id })) : null,
  };
}

/** Worker tick: closes assignments whose deadline passed and finishes their open attempts. */
export async function closeExpiredAssignments(deps: Deps) {
  const closed = await deps.sql<{ id: string }[]>`
    update rooms set status = 'finished', finished_at = now(), state_version = state_version + 1
    where status = 'running' and settings->>'mode' = 'async' and assignment_due_at < now() returning id`;
  if (closed.length) await deps.sql`update attempts set status = 'finished', finished_at = now() where room_id in ${deps.sql(closed.map((r) => r.id))} and status = 'active'`;
  return closed.length;
}
