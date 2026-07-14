import { and, asc, eq, exists, or } from "drizzle-orm";
import type { Database } from "../client.js";
import { type WorkspaceRow, user, workspaceMembers, workspaces } from "../schema.js";

/**
 * Workspace registry (ADR-0007). The single source of truth for which
 * workspaces exist and their DERIVED runtime coordinates. `sandboxId` and
 * `r2Prefix` are derived here from the workspace id — never stored — so routing
 * is never based on ad-hoc string juggling (PRD #42, story 21).
 */

/** Deterministic container id for a workspace. */
export const sandboxId = (workspaceId: string): string => `workspace-${workspaceId}`;

/** Deterministic R2 key prefix for a workspace (matches ADR-0001's keying). */
export const r2Prefix = (workspaceId: string): string => `workspaces/${workspaceId}/`;

/** A workspace record: its stored row plus its derived runtime coordinates. */
export type WorkspaceRecord = WorkspaceRow & {
  sandboxId: string;
  r2Prefix: string;
};

const toRecord = (row: WorkspaceRow): WorkspaceRecord => ({
  ...row,
  sandboxId: sandboxId(row.id),
  r2Prefix: r2Prefix(row.id),
});

const newWorkspaceId = () => `ws_${crypto.randomUUID()}`;

/** Create a workspace owned by the given user. Returns the new record. */
export async function createWorkspace(
  db: Database,
  input: { name: string; ownerUserId: string; repo?: string },
): Promise<WorkspaceRecord> {
  const [row] = await db
    .insert(workspaces)
    .values({
      id: newWorkspaceId(),
      name: input.name,
      repo: input.repo ?? null,
      ownerUserId: input.ownerUserId,
    })
    .returning();
  if (!row) throw new Error("createWorkspace: insert returned no row");
  return toRecord(row);
}

/** A membership subquery: the caller has a `workspace_members` row for this workspace. */
const isMember = (db: Database, userId: string) =>
  exists(
    db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaces.id), eq(workspaceMembers.userId, userId))),
  );

/** List the caller's workspaces — owned OR member-of (#179) — oldest first. */
export async function listWorkspaces(db: Database, userId: string): Promise<WorkspaceRecord[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(or(eq(workspaces.ownerUserId, userId), isMember(db, userId)))
    .orderBy(asc(workspaces.createdAt));
  return rows.map(toRecord);
}

/**
 * Get a workspace by id, enforcing access: returns null unless the caller is the
 * owner or an accepted member (#179; ownership PRD #42, story 22).
 */
export async function getWorkspace(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), or(eq(workspaces.ownerUserId, userId), isMember(db, userId))))
    .limit(1);
  return row ? toRecord(row) : null;
}

/** One roster row: the owner (from the workspace row) or an accepted member. */
export type WorkspaceMemberView = { userId: string; name: string; email: string; role: "owner" | "member" };

/** The workspace roster, owner first then members by join date. No access check —
 *  callers gate with getWorkspace first. */
export async function listWorkspaceMembers(db: Database, workspaceId: string): Promise<WorkspaceMemberView[]> {
  const [ownerRow] = await db
    .select({ userId: user.id, name: user.name, email: user.email })
    .from(workspaces)
    .innerJoin(user, eq(user.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const memberRows = await db
    .select({ userId: user.id, name: user.name, email: user.email })
    .from(workspaceMembers)
    .innerJoin(user, eq(user.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(workspaceMembers.createdAt));
  return [
    ...(ownerRow ? [{ ...ownerRow, role: "owner" as const }] : []),
    ...memberRows.map((m) => ({ ...m, role: "member" as const })),
  ];
}

/** Remove a member row. Returns false when no such membership existed. */
export async function removeWorkspaceMember(
  db: Database,
  input: { workspaceId: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.userId)))
    .returning({ id: workspaceMembers.id });
  return rows.length > 0;
}

/** Add (idempotently) a non-owner member. Role vocabulary: owner (on the workspace row) /
 *  member (here) — full use, no admin. */
export async function addWorkspaceMember(
  db: Database,
  input: { workspaceId: string; userId: string; role?: string },
): Promise<void> {
  await db
    .insert(workspaceMembers)
    .values({
      id: `wm_${crypto.randomUUID()}`,
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role ?? "member",
    })
    .onConflictDoNothing();
}
