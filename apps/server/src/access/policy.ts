import type { Sql, Tx } from "../db/index";
import type { UserRow } from "../auth/users";
import { forbidden, notFound } from "../lib/errors";

export type Role = "owner" | "editor" | "viewer";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export async function workspaceRole(sql: Sql | Tx, userId: string, workspaceId: string): Promise<Role | null> {
  const [m] = await sql<{ role: Role }[]>`
    select m.role from memberships m join workspaces w on w.id = m.workspace_id
    where m.workspace_id = ${workspaceId} and m.user_id = ${userId} and w.deleted_at is null`;
  return m?.role ?? null;
}

export async function requireWorkspaceRole(sql: Sql | Tx, user: Pick<UserRow, "id">, workspaceId: string, min: Role): Promise<Role> {
  const role = await workspaceRole(sql, user.id, workspaceId);
  // Do not reveal whether a foreign workspace exists.
  if (!role) throw notFound("workspace");
  if (RANK[role] < RANK[min]) throw forbidden(`requires ${min}`);
  return role;
}

const OWNED_TABLES = {
  document: "documents",
  quiz: "quizzes",
  deck: "decks",
} as const;
export type OwnedKind = keyof typeof OWNED_TABLES;

/**
 * Loads the workspace of an owned object and checks the caller's role there.
 * Unknown or inaccessible ids both surface as 404 to avoid id probing.
 */
export async function requireObjectRole(sql: Sql | Tx, user: Pick<UserRow, "id">, kind: OwnedKind, id: string, min: Role) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(kind);
  const table = OWNED_TABLES[kind];
  const rows = await sql.unsafe<{ workspace_id: string; owner_id: string }[]>(
    `select workspace_id, owner_id from ${table} where id = $1 and deleted_at is null`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound(kind);
  const role = await workspaceRole(sql, user.id, row.workspace_id);
  if (!role) throw notFound(kind);
  if (RANK[role] < RANK[min]) throw forbidden(`requires ${min}`);
  return { workspaceId: row.workspace_id, ownerId: row.owner_id, role };
}

/** Workspaces visible to the user (for list queries and retrieval filtering). */
export async function visibleWorkspaceIds(sql: Sql | Tx, userId: string): Promise<string[]> {
  const rows = await sql<{ workspace_id: string }[]>`
    select m.workspace_id from memberships m join workspaces w on w.id = m.workspace_id
    where m.user_id = ${userId} and w.deleted_at is null`;
  return rows.map((r) => r.workspace_id);
}

export function requirePlatformAdmin(user: Pick<UserRow, "platform_role">) {
  if (user.platform_role !== "admin") throw forbidden("admin only");
}
