import { createHmac } from "node:crypto";
import { RoomSettings, type RoomStateView } from "@talaba/shared";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import type { Sql, Tx } from "../db/index";
import { requireObjectRole } from "../access/policy";
import { AppError, forbidden, notFound } from "../lib/errors";
import { humanCode, randomToken, sha256 } from "../lib/crypto";
import { describeLocator } from "../search/retrieve";
import { startAppLink } from "../telegram/links";

export type RoomRow = {
  id: string; code: string; title: string; quiz_version_id: string; workspace_id: string; host_id: string; co_host_id: string | null; assignment_due_at: Date | null;
  status: "lobby" | "running" | "paused" | "finished" | "cancelled"; phase: "question" | "reveal" | null; settings: RoomSettings;
  question_ids: string[]; current_index: number; question_started_at: Date | null; deadline_at: Date | null; paused_remaining_ms: number | null;
  state_version: string; expires_at: Date;
};

const INVITE_TTL_HOURS = 24;

export async function notifyRoom(sql: Sql | Tx, roomId: string, kind: "state" | "answers" = "state") {
  await sql`select pg_notify('rooms', ${`${kind}:${roomId}`})`;
}

async function event(tx: Sql | Tx, roomId: string, type: string, actorId: string | null, data: Record<string, unknown> = {}) {
  await tx`insert into room_events (room_id, type, actor_id, data) values (${roomId}, ${type}, ${actorId}, ${tx.json(data as never)})`;
}

export async function getRoom(sql: Sql | Tx, roomId: string): Promise<RoomRow> {
  const [r] = await sql<RoomRow[]>`select * from rooms where id = ${roomId}`;
  if (!r) throw notFound("room");
  return { ...r, settings: RoomSettings.parse(r.settings ?? {}) };
}

/** Host opens a room for a published quiz version. */
export async function createRoom(deps: Deps, user: UserRow, quizId: string, rawSettings: unknown) {
  const { workspaceId } = await requireObjectRole(deps.sql, user, "quiz", quizId, "viewer");
  const settings = RoomSettings.parse(rawSettings ?? {});
  const [q] = await deps.sql<{ title: string; published_version_id: string | null }[]>`select title, published_version_id from quizzes where id = ${quizId}`;
  if (!q?.published_version_id) throw new AppError("quiz_not_published", 409);
  const qs = await deps.sql<{ id: string }[]>`select id from questions where quiz_version_id = ${q.published_version_id} and status = 'published' order by position`;
  if (!qs.length) throw new AppError("quiz_empty", 409);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await deps.sql.begin(async (tx) => {
        const [room] = await tx<{ id: string; code: string }[]>`
          insert into rooms (code, title, quiz_version_id, workspace_id, host_id, settings, question_ids)
          values (${humanCode(6)}, ${q.title}, ${q.published_version_id}, ${workspaceId}, ${user.id}, ${tx.json(settings as never)}, ${qs.map((x) => x.id)})
          returning id, code`;
        await tx`insert into room_members (room_id, user_id, display_name, role) values (${room!.id}, ${user.id}, ${displayName(user)}, 'host')`;
        if (settings.mode === "teams") {
          const palette = [["A", "#4F46E5"], ["B", "#0E7490"], ["C", "#B45309"], ["D", "#BE185D"]] as const;
          for (const [name, color] of palette.slice(0, settings.teamCount)) await tx`insert into teams (room_id, name, color) values (${room!.id}, ${name}, ${color})`;
          await tx`update rooms set team_count = ${settings.teamCount} where id = ${room!.id}`;
        }
        await event(tx, room!.id, "created", user.id, { quizId });
        if (settings.mode === "async") {
          // self-paced assignment: open at once until the deadline; the invite and the room live as long
          await tx`update rooms set status = 'running', started_at = now(), assignment_due_at = now() + make_interval(hours => ${settings.deadlineHours}),
            expires_at = greatest(expires_at, now() + make_interval(hours => ${settings.deadlineHours + 24})) where id = ${room!.id}`;
        }
        const invite = await issueInvite(tx, deps, room!.id, user.id, settings.mode === "async" ? settings.deadlineHours : undefined);
        return { roomId: room!.id, code: room!.code, mode: settings.mode, ...invite };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") continue; // code collision, retry
      throw e;
    }
  }
  throw new AppError("room_code_exhausted", 500);
}

async function issueInvite(tx: Tx, deps: Deps, roomId: string, userId: string, ttlHours = INVITE_TTL_HOURS) {
  const token = randomToken(16); // 22 chars base64url
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await tx`insert into invitations (kind, target_id, role, token_hash, created_by, expires_at) values ('room', ${roomId}, 'participant', ${sha256(token)}, ${userId}, ${expiresAt})`;
  const startParam = `r${token}`;
  return { inviteToken: token, startParam, inviteLink: startAppLink(deps.cfg, startParam), inviteExpiresAt: expiresAt };
}

export async function rotateInvite(deps: Deps, user: UserRow, roomId: string) {
  const room = await getRoom(deps.sql, roomId);
  requireHost(room, user);
  return deps.sql.begin(async (tx) => {
    await tx`update invitations set revoked_at = now() where kind = 'room' and target_id = ${roomId} and revoked_at is null`;
    await event(tx, roomId, "invite_rotated", user.id);
    const ttl = room.settings.mode === "async" && room.assignment_due_at ? Math.max(1, Math.ceil((room.assignment_due_at.getTime() - Date.now()) / 3600_000)) : undefined;
    return issueInvite(tx, deps, roomId, user.id, ttl);
  });
}

export async function revokeInvites(deps: Deps, user: UserRow, roomId: string) {
  const room = await getRoom(deps.sql, roomId);
  requireHost(room, user);
  await deps.sql`update invitations set revoked_at = now() where kind = 'room' and target_id = ${roomId} and revoked_at is null`;
  await event(deps.sql, roomId, "invite_revoked", user.id);
}

function displayName(user: Pick<UserRow, "first_name" | "last_name">) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ").trim().slice(0, 40) || "Ishtirokchi";
}

/**
 * Joins with an invite token (from the startapp link) or a room code. Knowing
 * a room link only grants this room's participant view — never the quiz bank,
 * other projects or source documents.
 */
export async function joinRoom(deps: Deps, user: UserRow, p: { inviteToken?: string; code?: string; nickname?: string }) {
  let roomId: string | null = null;
  if (p.inviteToken) {
    const [inv] = await deps.sql<{ target_id: string; expires_at: Date; revoked_at: Date | null }[]>`
      select target_id, expires_at, revoked_at from invitations where kind = 'room' and token_hash = ${sha256(p.inviteToken)}`;
    if (!inv || inv.revoked_at || inv.expires_at < new Date()) throw new AppError("invite_invalid", 410);
    roomId = inv.target_id;
  } else if (p.code) {
    const [r] = await deps.sql<{ id: string }[]>`select id from rooms where code = ${p.code.trim().toUpperCase()} and expires_at > now()`;
    if (!r) throw new AppError("room_not_found", 404);
    roomId = r.id;
  } else throw new AppError("invite_invalid", 400);
  const room = await getRoom(deps.sql, roomId);
  if (room.status === "cancelled" || room.expires_at < new Date()) throw new AppError("room_closed", 410);
  const name = (p.nickname?.trim() || displayName(user)).replace(/[\u0000-\u001f<>]/g, "").slice(0, 40);
  await deps.sql.begin(async (tx) => {
    await tx`select id from rooms where id = ${roomId} for update`;
    // Quiz Battle: new participants go to the smallest team (ties → first team)
    const [team] = room.settings.mode === "teams"
      ? await tx<{ id: string }[]>`select t.id from teams t left join room_members m on m.team_id = t.id where t.room_id = ${roomId}
          group by t.id, t.name order by count(m.user_id), t.name limit 1`
      : [];
    await tx`
      insert into room_members (room_id, user_id, display_name, team_id) values (${roomId}, ${user.id}, ${name}, ${team?.id ?? null})
      on conflict (room_id, user_id) do update set display_name = case when room_members.role = 'host' then room_members.display_name else excluded.display_name end`;
  });
  await event(deps.sql, roomId, "joined", user.id);
  await notifyRoom(deps.sql, roomId);
  return { roomId, mode: room.settings.mode };
}

export async function requireMember(sql: Sql | Tx, roomId: string, userId: string) {
  const [m] = await sql<{ role: string; display_name: string }[]>`select role, display_name from room_members where room_id = ${roomId} and user_id = ${userId}`;
  if (!m) throw notFound("room");
  return m;
}

function requireHost(room: RoomRow, user: Pick<UserRow, "id">) {
  if (room.host_id !== user.id && room.co_host_id !== user.id) throw forbidden("host only");
}

/** Host actions; every transition is a single conditional UPDATE so concurrent clicks/instances cannot double-advance. */
export async function hostAction(deps: Deps, user: Pick<UserRow, "id">, roomId: string, action: "start" | "next" | "reveal" | "pause" | "resume" | "finish") {
  const room = await getRoom(deps.sql, roomId);
  requireHost(room, user);
  // a self-paced assignment has no live question flow: it can only be closed early
  if (room.settings.mode === "async" && action !== "finish") throw new AppError("not_for_assignment", 409);
  const t = room.settings.timePerQuestionSec;
  let changed: { id: string }[] = [];
  switch (action) {
    case "start":
      changed = await deps.sql`update rooms set status = 'running', phase = 'question', current_index = 0, started_at = now(),
        question_started_at = clock_timestamp(), deadline_at = clock_timestamp() + make_interval(secs => ${t}), state_version = state_version + 1
        where id = ${roomId} and status = 'lobby' returning id`;
      break;
    case "reveal":
      changed = await revealIfDue(deps.sql, roomId, true);
      break;
    case "next":
      changed = await deps.sql`update rooms set
          current_index = current_index + 1, phase = 'question', question_started_at = clock_timestamp(),
          deadline_at = clock_timestamp() + make_interval(secs => ${t}), state_version = state_version + 1
        where id = ${roomId} and status = 'running' and phase = 'reveal' and current_index + 1 < cardinality(question_ids) returning id`;
      if (!changed.length) {
        changed = await deps.sql`update rooms set status = 'finished', phase = 'reveal', finished_at = now(), deadline_at = null, state_version = state_version + 1
          where id = ${roomId} and status = 'running' and phase = 'reveal' and current_index + 1 >= cardinality(question_ids) returning id`;
      }
      break;
    case "pause":
      changed = await deps.sql`update rooms set status = 'paused',
          paused_remaining_ms = case when phase = 'question' then greatest(0, (extract(epoch from (deadline_at - clock_timestamp())) * 1000)::int) else null end,
          deadline_at = null, state_version = state_version + 1
        where id = ${roomId} and status = 'running' returning id`;
      break;
    case "resume":
      changed = await deps.sql`update rooms set status = 'running',
          deadline_at = case when phase = 'question' then clock_timestamp() + make_interval(secs => greatest(coalesce(paused_remaining_ms, 0), 3000) / 1000.0) else null end,
          paused_remaining_ms = null, state_version = state_version + 1
        where id = ${roomId} and status = 'paused' returning id`;
      break;
    case "finish":
      changed = await deps.sql`update rooms set status = 'finished', phase = 'reveal', finished_at = now(), deadline_at = null, state_version = state_version + 1
        where id = ${roomId} and status in ('lobby','running','paused') returning id`;
      // closing an assignment early also ends attempts still in progress
      if (changed.length && room.settings.mode === "async") await deps.sql`update attempts set status = 'finished', finished_at = now() where room_id = ${roomId} and status = 'active'`;
      break;
  }
  if (!changed.length) return { changed: false };
  await event(deps.sql, roomId, `host_${action}`, user.id);
  await notifyRoom(deps.sql, roomId);
  return { changed: true };
}

/** Closes the current question once its server deadline has passed (or immediately when forced by the host). */
export async function revealIfDue(sql: Sql, roomId: string, force = false) {
  return sql<{ id: string }[]>`update rooms set phase = 'reveal', deadline_at = null, state_version = state_version + 1
    where id = ${roomId} and status = 'running' and phase = 'question' and (${force} or deadline_at <= clock_timestamp()) returning id`;
}

/** Deterministic per-user option order: stable across reconnects, different between participants. */
export function optionOrder(roomId: string, userId: string, questionId: string, optionIds: string[], secret: string): string[] {
  return [...optionIds]
    .map((id) => ({ id, k: createHmac("sha256", secret).update(`${roomId}:${userId}:${questionId}:${id}`).digest("hex") }))
    .sort((a, b) => (a.k < b.k ? -1 : 1))
    .map((x) => x.id);
}

/**
 * Accepts an answer only while the question is open by the DB clock. The
 * unique (room, question, user) constraint makes retries/duplicates harmless;
 * points are computed from server timestamps. Acknowledged only after commit.
 */
export async function submitAnswer(deps: Deps, user: Pick<UserRow, "id">, roomId: string, questionId: string, optionIds: string[]) {
  await requireMember(deps.sql, roomId, user.id);
  return deps.sql.begin(async (tx) => {
    const [r] = await tx<{ status: string; phase: string | null; qid: string | null; open: boolean; started: Date; deadline: Date | null; settings: RoomSettings; latency_ms: number }[]>`
      select status, phase, question_ids[current_index + 1] as qid, (deadline_at is not null and clock_timestamp() <= deadline_at) as open,
        question_started_at as started, deadline_at as deadline, settings,
        greatest(0, (extract(epoch from (clock_timestamp() - question_started_at)) * 1000)::int) as latency_ms
      from rooms where id = ${roomId}`;
    if (!r) throw notFound("room");
    if (r.status !== "running" || r.phase !== "question") return { accepted: false, reason: r.status === "paused" ? "paused" : "closed" };
    if (r.qid !== questionId) return { accepted: false, reason: "not_current_question" };
    if (!r.open) return { accepted: false, reason: "time_up" };
    const valid = new Set((await tx<{ id: string }[]>`select id from options where question_id = ${questionId}`).map((o) => o.id));
    const chosen = [...new Set(optionIds)];
    if (!chosen.length || chosen.some((id) => !valid.has(id))) return { accepted: false, reason: "invalid_option" };
    const [key] = await tx<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${questionId}`;
    const correct = new Set(key?.correct_option_ids ?? []);
    const isCorrect = chosen.length === correct.size && chosen.every((id) => correct.has(id));
    const settings = RoomSettings.parse(r.settings ?? {});
    const totalMs = r.deadline && r.started ? r.deadline.getTime() - r.started.getTime() : settings.timePerQuestionSec * 1000;
    const bonus = isCorrect && settings.speedBonus ? Math.max(0, Math.round(settings.speedBonusMax * (1 - r.latency_ms / totalMs))) : 0;
    const points = isCorrect ? 100 + bonus : 0;
    const [ins] = await tx<{ id: string }[]>`
      insert into room_answers (room_id, question_id, user_id, selected_option_ids, latency_ms, is_correct, points)
      values (${roomId}, ${questionId}, ${user.id}, ${chosen}, ${r.latency_ms}, ${isCorrect}, ${points})
      on conflict (room_id, question_id, user_id) do nothing returning id`;
    if (!ins) return { accepted: false, reason: "already_answered" };
    await tx`insert into scores (room_id, user_id, points, correct, answered) values (${roomId}, ${user.id}, ${points}, ${isCorrect ? 1 : 0}, 1)
      on conflict (room_id, user_id) do update set points = scores.points + excluded.points, correct = scores.correct + excluded.correct, answered = scores.answered + 1`;
    await tx`select pg_notify('rooms', ${`answers:${roomId}`})`;
    return { accepted: true as const };
  });
}

export async function setPresence(sql: Sql, roomId: string, userId: string, connected: boolean) {
  await sql`update room_members set connected = ${connected}, last_seen_at = now() where room_id = ${roomId} and user_id = ${userId}`;
}

/**
 * The host may name one participant co-host: they get the host controls, and while
 * either of them is connected the room is not paused for "host away".
 */
export async function setCoHost(deps: Deps, user: UserRow, roomId: string, coHostId: string | null) {
  const [room] = await deps.sql<{ host_id: string; status: string }[]>`select host_id, status from rooms where id = ${roomId}`;
  if (!room) throw notFound("room");
  if (room.host_id !== user.id) throw forbidden("host only");
  if (coHostId) {
    if (coHostId === user.id) throw new AppError("already_host", 400);
    const [m] = await deps.sql`select 1 from room_members where room_id = ${roomId} and user_id = ${coHostId}`;
    if (!m) throw notFound("participant");
  }
  await deps.sql`update rooms set co_host_id = ${coHostId}, state_version = state_version + 1 where id = ${roomId}`;
  await event(deps.sql, roomId, coHostId ? "co_host_set" : "co_host_removed", user.id);
  await notifyRoom(deps.sql, roomId);
  return { coHostId };
}

/** Called after the host's grace period: pause a running room if the host (and co-host) are still away. */
export async function pauseIfHostAway(deps: Deps, roomId: string) {
  const changed = await deps.sql<{ id: string }[]>`
    update rooms set status = 'paused',
      paused_remaining_ms = case when phase = 'question' then greatest(0, (extract(epoch from (deadline_at - clock_timestamp())) * 1000)::int) else null end,
      deadline_at = null, state_version = state_version + 1
    where id = ${roomId} and status = 'running'
      and not exists (select 1 from room_members m where m.room_id = rooms.id and m.connected and (m.user_id = rooms.host_id or m.user_id = rooms.co_host_id))
    returning id`;
  if (changed.length) {
    await event(deps.sql, roomId, "host_left_paused", null);
    await notifyRoom(deps.sql, roomId);
  }
  return changed.length > 0;
}

export type SharedRoomState = {
  room: RoomRow;
  participants: { userId: string; name: string; connected: boolean; isHost: boolean; isCoHost: boolean }[];
  question: { id: string; text: string; type: string; optionIds: string[]; options: Map<string, string> } | null;
  answers: Map<string, { optionIds: string[]; at: number }>;
  answeredCount: number;
  reveal: RoomStateView["reveal"];
  scores: Map<string, { points: number; correct: number; answered: number }>;
  leaderboard: { userId: string; name: string; points: number; correct: number }[];
  hostConnected: boolean;
  teams: { id: string; name: string; color: string; memberIds: string[] }[];
  teamOf: Map<string, string>;
};

/** Loads everything common to all viewers in a few queries (used to fan out to 100+ sockets). */
export async function loadSharedState(sql: Sql, roomId: string): Promise<SharedRoomState> {
  const room = await getRoom(sql, roomId);
  const members = await sql<{ user_id: string; display_name: string; connected: boolean; role: string; team_id: string | null }[]>`select user_id, display_name, connected, role, team_id from room_members where room_id = ${roomId} order by joined_at`;
  const teamRows = room.settings.mode === "teams" ? await sql<{ id: string; name: string; color: string }[]>`select id, name, color from teams where room_id = ${roomId} order by name` : [];
  const qid = room.current_index >= 0 ? room.question_ids[room.current_index] ?? null : null;
  let question: SharedRoomState["question"] = null;
  let answers = new Map<string, { optionIds: string[]; at: number }>();
  let reveal: SharedRoomState["reveal"] = null;
  if (qid && room.status !== "lobby") {
    const [q] = await sql<{ id: string; text: string; type: string; explanation: string | null; quote: string | null; locator: Record<string, unknown> | null; document_title: string | null }[]>`
      select q.id, q.text, q.type, q.explanation, sr.quote, sr.locator, sr.document_title from questions q left join source_references sr on sr.id = q.source_ref_id where q.id = ${qid}`;
    const opts = await sql<{ id: string; text: string }[]>`select id, text from options where question_id = ${qid} order by position`;
    question = { id: q!.id, text: q!.text, type: q!.type, optionIds: opts.map((o) => o.id), options: new Map(opts.map((o) => [o.id, o.text])) };
    const rows = await sql<{ user_id: string; selected_option_ids: string[]; received_at: Date }[]>`select user_id, selected_option_ids, received_at from room_answers where room_id = ${roomId} and question_id = ${qid}`;
    answers = new Map(rows.map((r) => [r.user_id, { optionIds: r.selected_option_ids, at: r.received_at.getTime() }]));
    if (room.phase === "reveal") {
      const [key] = await sql<{ correct_option_ids: string[] }[]>`select correct_option_ids from private_answer_keys where question_id = ${qid}`;
      const counts: Record<string, number> = {};
      for (const o of opts) counts[o.id] = 0;
      for (const r of rows) for (const id of r.selected_option_ids) counts[id] = (counts[id] ?? 0) + 1;
      reveal = {
        questionId: qid,
        correctOptionIds: key?.correct_option_ids ?? [],
        explanation: room.settings.revealExplanation === "after_question" || room.status === "finished" ? q!.explanation : null,
        source: q!.quote ? `${q!.document_title ?? ""}, ${describeLocator((q!.locator ?? {}) as never)}` : null,
        counts,
      };
    }
  }
  const scoreRows = await sql<{ user_id: string; points: number; correct: number; answered: number }[]>`select user_id, points, correct, answered from scores where room_id = ${roomId}`;
  const scores = new Map(scoreRows.map((s) => [s.user_id, { points: s.points, correct: s.correct, answered: s.answered }]));
  const names = new Map(members.map((m) => [m.user_id, m.display_name]));
  // Tie rule: equal points share a rank; order by correct answers, then by earlier join.
  const leaderboard = members
    .filter((m) => m.role !== "host")
    .map((m) => ({ userId: m.user_id, name: names.get(m.user_id) ?? "", points: scores.get(m.user_id)?.points ?? 0, correct: scores.get(m.user_id)?.correct ?? 0 }))
    .sort((a, b) => b.points - a.points || b.correct - a.correct);
  return {
    room,
    participants: members.map((m) => ({ userId: m.user_id, name: m.display_name, connected: m.connected, isHost: m.role === "host" || m.user_id === room.co_host_id, isCoHost: m.user_id === room.co_host_id })),
    question,
    answers,
    answeredCount: answers.size,
    reveal,
    scores,
    leaderboard,
    hostConnected: members.some((m) => (m.user_id === room.host_id || m.user_id === room.co_host_id) && m.connected),
    teams: teamRows.map((t) => ({ ...t, memberIds: members.filter((m) => m.team_id === t.id && m.role !== "host").map((m) => m.user_id) })),
    teamOf: new Map(members.filter((m) => m.team_id).map((m) => [m.user_id, m.team_id!])),
  };
}

/** Team standings: average member points, so a bigger team gets no advantage from size alone. */
export function teamStandings(shared: SharedRoomState) {
  return shared.teams
    .map((t) => {
      const total = t.memberIds.reduce((s, id) => s + (shared.scores.get(id)?.points ?? 0), 0);
      return { id: t.id, name: t.name, color: t.color, members: t.memberIds.length, averagePoints: t.memberIds.length ? Math.round((total / t.memberIds.length) * 10) / 10 : 0 };
    })
    .sort((a, b) => b.averagePoints - a.averagePoints);
}

/** Per-viewer projection: participants never receive the key before reveal, nor other people's choices. */
export function viewFor(shared: SharedRoomState, userId: string, secret: string, now = Date.now()): RoomStateView {
  const { room } = shared;
  const isHost = room.host_id === userId || room.co_host_id === userId;
  const q = shared.question;
  const showBoard = room.status === "finished" ? room.settings.showLeaderboard || isHost : isHost;
  const mine = q ? shared.answers.get(userId) : undefined;
  return {
    roomId: room.id,
    title: room.title,
    status: room.status,
    phase: room.phase,
    isHost,
    code: isHost ? room.code : null,
    serverNow: now,
    deadline: room.deadline_at ? room.deadline_at.getTime() : null,
    pausedRemainingMs: room.paused_remaining_ms,
    participants: isHost ? shared.participants : shared.participants.map((p) => ({ ...p, connected: p.connected })),
    question:
      q && room.status !== "lobby"
        ? {
            id: q.id,
            index: room.current_index,
            total: room.question_ids.length,
            text: q.text,
            type: q.type,
            multiple: q.type === "multiple",
            options: (q.type === "true_false" || room.settings.shuffleOptions === false ? q.optionIds : optionOrder(room.id, userId, q.id, q.optionIds, secret)).map((id) => ({ id, text: q.options.get(id)! })),
          }
        : null,
    myAnswer: mine && q ? { questionId: q.id, optionIds: mine.optionIds, acceptedAt: mine.at } : null,
    answeredCount: shared.answeredCount,
    reveal: shared.reveal,
    myScore: shared.scores.get(userId) ?? (isHost ? null : { points: 0, correct: 0, answered: 0 }),
    leaderboard: showBoard ? shared.leaderboard : null,
    rules: { pointsCorrect: 100, speedBonusMax: room.settings.speedBonus ? room.settings.speedBonusMax : 0, showLeaderboard: room.settings.showLeaderboard, timePerQuestionSec: room.settings.timePerQuestionSec, teamScoring: room.settings.mode === "teams" ? "average" : null },
    hostConnected: shared.hostConnected,
    teams: room.settings.mode === "teams" ? teamStandings(shared) : null,
    myTeamId: shared.teamOf.get(userId) ?? null,
  };
}

export async function roomResults(deps: Deps, user: UserRow, roomId: string) {
  const room = await getRoom(deps.sql, roomId);
  const m = await requireMember(deps.sql, roomId, user.id);
  const isHost = room.host_id === user.id || room.co_host_id === user.id || m.role === "host";
  const shared = await loadSharedState(deps.sql, roomId);
  const mine = await deps.sql<{ question_id: string; is_correct: boolean; points: number; selected_option_ids: string[] }[]>`
    select question_id, is_correct, points, selected_option_ids from room_answers where room_id = ${roomId} and user_id = ${user.id}`;
  const perQuestion = isHost
    ? await deps.sql<{ question_id: string; answered: number; correct: number }[]>`
        select question_id, count(*)::int as answered, count(*) filter (where is_correct)::int as correct from room_answers where room_id = ${roomId} group by question_id`
    : null;
  // Individual mistake analysis only for the student themselves and the host.
  const individual = isHost
    ? await deps.sql<{ user_id: string; question_id: string; is_correct: boolean }[]>`select user_id, question_id, is_correct from room_answers where room_id = ${roomId}`
    : null;
  return {
    status: room.status,
    title: room.title,
    isHost,
    my: { score: shared.scores.get(user.id) ?? { points: 0, correct: 0, answered: 0 }, answers: mine },
    leaderboard: room.status === "finished" && (room.settings.showLeaderboard || isHost) ? shared.leaderboard : null,
    perQuestion,
    individual,
    total: room.question_ids.length,
  };
}
