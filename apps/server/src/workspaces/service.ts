import { z } from "zod";
import type { Deps } from "../deps";
import type { UserRow } from "../auth/users";
import type { Sql, Tx } from "../db/index";
import { requireObjectRole, requireWorkspaceRole, workspaceRole, type OwnedKind } from "../access/policy";
import { AppError, forbidden, notFound } from "../lib/errors";
import { randomToken, sha256 } from "../lib/crypto";
import { startAppLink } from "../telegram/links";

export async function wsEvent(sql: Sql | Tx, workspaceId: string, actorId: string | null, type: string, target?: { type: string; id: string }, data: Record<string, unknown> = {}) {
  await sql`insert into workspace_events (workspace_id, actor_id, type, target_type, target_id, data) values (${workspaceId}, ${actorId}, ${type}, ${target?.type ?? null}, ${target?.id ?? null}, ${sql.json(data as never)})`;
}

export async function createWorkspace(deps: Deps, user: UserRow, name: string) {
  const clean = name.trim().slice(0, 120);
  if (!clean) throw new AppError("name_required", 400);
  return deps.sql.begin(async (tx) => {
    const [w] = await tx<{ id: string }[]>`insert into workspaces (name, kind, owner_id) values (${clean}, 'group', ${user.id}) returning id`;
    await tx`insert into memberships (workspace_id, user_id, role) values (${w!.id}, ${user.id}, 'owner')`;
    await wsEvent(tx, w!.id, user.id, "workspace.created");
    return { workspaceId: w!.id };
  });
}

export async function getWorkspace(deps: Deps, user: UserRow, id: string) {
  const role = await requireWorkspaceRole(deps.sql, user, id, "viewer");
  const [w] = await deps.sql<{ id: string; name: string; kind: string; created_at: Date }[]>`select id, name, kind, created_at from workspaces where id = ${id}`;
  const members = await deps.sql<{ user_id: string; name: string; role: string; joined: Date }[]>`
    select m.user_id, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as name, m.role, m.created_at as joined
    from memberships m join users u on u.id = m.user_id where m.workspace_id = ${id} order by m.created_at`;
  const docs = await deps.sql`select id, title, source_kind, created_at from documents where workspace_id = ${id} and deleted_at is null order by created_at desc limit 50`;
  const quizzes = await deps.sql`select id, title, published_version_id is not null as published, updated_at from quizzes where workspace_id = ${id} and deleted_at is null order by updated_at desc limit 50`;
  const decks = await deps.sql`select id, title, status, updated_at from decks where workspace_id = ${id} and deleted_at is null order by updated_at desc limit 50`;
  const tasks = await deps.sql`select t.id, t.title, t.description, t.status, t.due_at, t.assignee_id, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as assignee_name, t.created_at
    from tasks t left join users u on u.id = t.assignee_id where t.workspace_id = ${id} and t.plan_id is null order by coalesce(t.due_at, t.created_at) limit 200`;
  const events = await deps.sql`select e.id, e.type, e.target_type, e.target_id, e.data, e.at, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as actor
    from workspace_events e left join users u on u.id = e.actor_id where e.workspace_id = ${id} order by e.id desc limit 50`;
  const invites = role === "owner"
    ? await deps.sql`select id, role, expires_at, revoked_at, uses, created_at from invitations where kind = 'workspace' and workspace_id = ${id} order by created_at desc limit 20`
    : [];
  return { ...w, role, members, documents: docs, quizzes, decks, tasks, events, invites };
}

export async function createWorkspaceInvite(deps: Deps, user: UserRow, workspaceId: string, p: { role: "editor" | "viewer"; ttlHours?: number; maxUses?: number }) {
  await requireWorkspaceRole(deps.sql, user, workspaceId, "owner");
  const token = randomToken(16);
  const expiresAt = new Date(Date.now() + Math.min(Math.max(p.ttlHours ?? 72, 1), 24 * 30) * 3600_000);
  const [inv] = await deps.sql<{ id: string }[]>`
    insert into invitations (kind, workspace_id, target_id, role, token_hash, created_by, expires_at, max_uses)
    values ('workspace', ${workspaceId}, ${workspaceId}, ${p.role}, ${sha256(token)}, ${user.id}, ${expiresAt}, ${p.maxUses ?? null}) returning id`;
  await wsEvent(deps.sql, workspaceId, user.id, "invite.created", undefined, { role: p.role });
  return { inviteId: inv!.id, token, startParam: `w${token}`, link: startAppLink(deps.cfg, `w${token}`), expiresAt, role: p.role };
}

export async function revokeWorkspaceInvite(deps: Deps, user: UserRow, workspaceId: string, inviteId: string) {
  await requireWorkspaceRole(deps.sql, user, workspaceId, "owner");
  const r = await deps.sql`update invitations set revoked_at = now() where id = ${inviteId} and workspace_id = ${workspaceId} and revoked_at is null returning id`;
  if (!r.length) throw notFound("invite");
  await wsEvent(deps.sql, workspaceId, user.id, "invite.revoked");
}

/** Revoked/expired/exhausted invites stop future joins; existing members keep their role. */
export async function joinWorkspace(deps: Deps, user: UserRow, token: string) {
  return deps.sql.begin(async (tx) => {
    const [inv] = await tx<{ id: string; workspace_id: string; role: "editor" | "viewer"; expires_at: Date; revoked_at: Date | null; max_uses: number | null; uses: number }[]>`
      select id, workspace_id, role, expires_at, revoked_at, max_uses, uses from invitations where kind = 'workspace' and token_hash = ${sha256(token)} for update`;
    if (!inv || inv.revoked_at || inv.expires_at < new Date() || (inv.max_uses != null && inv.uses >= inv.max_uses)) throw new AppError("invite_invalid", 410);
    const current = await workspaceRole(tx, user.id, inv.workspace_id);
    if (!current) {
      await tx`insert into memberships (workspace_id, user_id, role) values (${inv.workspace_id}, ${user.id}, ${inv.role})`;
      await tx`update invitations set uses = uses + 1 where id = ${inv.id}`;
      await wsEvent(tx, inv.workspace_id, user.id, "member.joined", undefined, { role: inv.role });
    }
    return { workspaceId: inv.workspace_id, role: current ?? inv.role };
  });
}

export async function setMemberRole(deps: Deps, user: UserRow, workspaceId: string, memberId: string, role: "owner" | "editor" | "viewer" | null) {
  await requireWorkspaceRole(deps.sql, user, workspaceId, "owner");
  return deps.sql.begin(async (tx) => {
    const owners = await tx<{ user_id: string }[]>`select user_id from memberships where workspace_id = ${workspaceId} and role = 'owner' for update`;
    if (owners.length === 1 && owners[0]!.user_id === memberId && role !== "owner") throw new AppError("last_owner", 409);
    if (role === null) await tx`delete from memberships where workspace_id = ${workspaceId} and user_id = ${memberId}`;
    else await tx`update memberships set role = ${role} where workspace_id = ${workspaceId} and user_id = ${memberId}`;
    await wsEvent(tx, workspaceId, user.id, role ? "member.role" : "member.removed", { type: "user", id: memberId }, { role });
  });
}

export const TaskInput = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  status: z.enum(["todo", "in_progress", "done", "skipped"]).optional(),
});

export async function createTask(deps: Deps, user: UserRow, workspaceId: string, raw: unknown) {
  const p = TaskInput.parse(raw);
  await requireWorkspaceRole(deps.sql, user, workspaceId, "editor");
  if (p.assigneeId && !(await workspaceRole(deps.sql, p.assigneeId, workspaceId))) throw new AppError("assignee_not_member", 400);
  const [t] = await deps.sql<{ id: string }[]>`insert into tasks (workspace_id, title, description, assignee_id, due_at, created_by)
    values (${workspaceId}, ${p.title}, ${p.description ?? null}, ${p.assigneeId ?? null}, ${p.dueAt ? new Date(p.dueAt) : null}, ${user.id}) returning id`;
  await wsEvent(deps.sql, workspaceId, user.id, "task.created", { type: "task", id: t!.id }, { title: p.title });
  return { taskId: t!.id };
}

export async function updateTask(deps: Deps, user: UserRow, taskId: string, raw: unknown) {
  const p = TaskInput.partial().parse(raw);
  const [t] = await deps.sql<{ workspace_id: string; assignee_id: string | null }[]>`select workspace_id, assignee_id from tasks where id = ${taskId}`;
  if (!t) throw notFound("task");
  const role = await requireWorkspaceRole(deps.sql, user, t.workspace_id, "viewer");
  // viewers can't edit; an assignee may update the status of their own task
  if (role === "viewer" && !(t.assignee_id === user.id && Object.keys(p).every((k) => k === "status"))) throw forbidden("viewer");
  await deps.sql`update tasks set
    title = coalesce(${p.title ?? null}::text, title), description = ${p.description === undefined ? deps.sql`description` : p.description},
    assignee_id = ${p.assigneeId === undefined ? deps.sql`assignee_id` : p.assigneeId}, due_at = ${p.dueAt === undefined ? deps.sql`due_at` : p.dueAt ? new Date(p.dueAt) : null},
    status = coalesce(${p.status ?? null}::text, status), completed_at = case when ${p.status ?? null}::text = 'done' then now() when ${p.status ?? null}::text is not null then null else completed_at end,
    updated_at = now() where id = ${taskId}`;
  await wsEvent(deps.sql, t.workspace_id, user.id, "task.updated", { type: "task", id: taskId }, p as Record<string, unknown>);
}

const TARGETS = ["slide", "question", "document", "task", "deck", "quiz"] as const;

async function targetWorkspace(deps: Deps, targetType: (typeof TARGETS)[number], targetId: string): Promise<string | null> {
  const q: Record<(typeof TARGETS)[number], string> = {
    document: "select workspace_id from documents where id = $1",
    quiz: "select workspace_id from quizzes where id = $1",
    deck: "select workspace_id from decks where id = $1",
    task: "select workspace_id from tasks where id = $1",
    slide: "select d.workspace_id from slides s join decks d on d.id = s.deck_id where s.id = $1",
    question: "select z.workspace_id from questions q join quiz_versions v on v.id = q.quiz_version_id join quizzes z on z.id = v.quiz_id where q.id = $1",
  };
  const rows = await deps.sql.unsafe<{ workspace_id: string }[]>(q[targetType], [targetId]);
  return rows[0]?.workspace_id ?? null;
}

/** Comments: any member (including a read-only teacher) may comment; deleting is limited to the author. */
export async function addComment(deps: Deps, user: UserRow, p: { targetType: (typeof TARGETS)[number]; targetId: string; body: string }) {
  const ws = await targetWorkspace(deps, p.targetType, p.targetId);
  if (!ws) throw notFound(p.targetType);
  await requireWorkspaceRole(deps.sql, user, ws, "viewer");
  const [c] = await deps.sql<{ id: string }[]>`insert into comments (workspace_id, target_type, target_id, author_id, body) values (${ws}, ${p.targetType}, ${p.targetId}, ${user.id}, ${p.body.slice(0, 4000)}) returning id`;
  await wsEvent(deps.sql, ws, user.id, "comment.added", { type: p.targetType, id: p.targetId });
  return { commentId: c!.id };
}

export async function listComments(deps: Deps, user: UserRow, targetType: (typeof TARGETS)[number], targetId: string) {
  const ws = await targetWorkspace(deps, targetType, targetId);
  if (!ws) throw notFound(targetType);
  await requireWorkspaceRole(deps.sql, user, ws, "viewer");
  return deps.sql`select c.id, c.body, c.created_at, c.author_id, trim(u.first_name || ' ' || coalesce(u.last_name, '')) as author
    from comments c join users u on u.id = c.author_id where c.target_type = ${targetType} and c.target_id = ${targetId} and c.deleted_at is null order by c.created_at limit 200`;
}

export async function deleteComment(deps: Deps, user: UserRow, commentId: string) {
  const r = await deps.sql`update comments set deleted_at = now() where id = ${commentId} and author_id = ${user.id} returning id`;
  if (!r.length) throw notFound("comment");
}

/** Moves a document/quiz/deck between workspaces the user can edit (sharing is explicit; default is private). */
export async function moveToWorkspace(deps: Deps, user: UserRow, kind: OwnedKind, id: string, workspaceId: string) {
  const { workspaceId: from, ownerId } = await requireObjectRole(deps.sql, user, kind, id, "editor");
  if (ownerId !== user.id) throw forbidden("only the owner can move");
  await requireWorkspaceRole(deps.sql, user, workspaceId, "editor");
  const table = kind === "document" ? "documents" : kind === "quiz" ? "quizzes" : "decks";
  await deps.sql.unsafe(`update ${table} set workspace_id = $1, updated_at = now() where id = $2`, [workspaceId, id]);
  await wsEvent(deps.sql, workspaceId, user.id, `${kind}.shared`, { type: kind, id }, { from });
  return { moved: true };
}

export { TARGETS };
