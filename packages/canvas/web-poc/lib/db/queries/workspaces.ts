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

/** Get a workspace row by id with NO access check — edge-internal resolution only
 *  (repo-connection lookups keyed off an already-authorized artifact, e.g. a
 *  Conversation the caller owns). Never expose through a user-facing route. */
export async function getWorkspaceRecord(db: Database, workspaceId: string): Promise<WorkspaceRecord | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row ? toRecord(row) : null;
}

/** Stamp the shared inbox read mark (read-for-all): any member opening the Inbox
 *  clears the whole workspace's badge. Caller must have verified membership. */
export async function setInboxReadAt(db: Database, workspaceId: string, at: Date): Promise<void> {
  await db.update(workspaces).set({ inboxReadAt: at }).where(eq(workspaces.id, workspaceId));
}

/** Add a GitHub App installation to the workspace (repository connection, ADR-0015).
 *  A workspace can hold one installation per GitHub account (org or user); reinstalling
 *  an account replaces its entry (GitHub mints a new installation id). The legacy
 *  single-id column is folded into the list here and nulled. */
export async function addWorkspaceGithubInstallation(
  db: Database,
  input: { workspaceId: string; installationId: string; accountLogin: string | null },
): Promise<void> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (!row) return;
  const current =
    row.githubInstallations ??
    (row.githubInstallationId ? [{ installationId: row.githubInstallationId, accountLogin: null }] : []);
  const next = [
    ...current.filter(
      (i) =>
        i.installationId !== input.installationId &&
        !(input.accountLogin !== null && i.accountLogin === input.accountLogin),
    ),
    { installationId: input.installationId, accountLogin: input.accountLogin },
  ];
  await db
    .update(workspaces)
    .set({ githubInstallations: next, githubInstallationId: null })
    .where(eq(workspaces.id, input.workspaceId));
}

/** Replace the workspace's selected-repo set (validated against the grant by the caller). */
export async function setWorkspaceSelectedRepos(
  db: Database,
  input: { workspaceId: string; repos: string[] },
): Promise<void> {
  await db.update(workspaces).set({ selectedRepos: input.repos }).where(eq(workspaces.id, input.workspaceId));
}

/** Disconnect: clear all installations and the selection. */
export async function clearWorkspaceGithubConnection(db: Database, workspaceId: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ githubInstallationId: null, githubInstallations: null, selectedRepos: null })
    .where(eq(workspaces.id, workspaceId));
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

/** Transfer ownership: there is a single owner (`workspaces.owner_user_id`), so
 *  "changing someone's role" IS a transfer, not an enum edit. The target must
 *  already be a member; on success it becomes owner and the OLD owner becomes a
 *  member. Returns false (no-op) if the target isn't currently a member. */
export async function transferWorkspaceOwnership(
  db: Database,
  input: { workspaceId: string; toUserId: string },
): Promise<boolean> {
  // Member check first, then the writes — sequential (not db.transaction: the libsql
  // driver opens transactions on a separate connection, which the in-memory test
  // client can't share across, and this handful of single-row writes needs no
  // cross-statement isolation beyond "member first").
  const [existing] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.toUserId)))
    .limit(1);
  if (!existing) return false;

  const [ws] = await db
    .select({ ownerUserId: workspaces.ownerUserId })
    .from(workspaces)
    .where(eq(workspaces.id, input.workspaceId))
    .limit(1);
  if (!ws) return false;
  const oldOwnerUserId = ws.ownerUserId;

  await db.update(workspaces).set({ ownerUserId: input.toUserId }).where(eq(workspaces.id, input.workspaceId));
  await db
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, input.toUserId)));
  await db
    .insert(workspaceMembers)
    .values({ id: `wm_${crypto.randomUUID()}`, workspaceId: input.workspaceId, userId: oldOwnerUserId, role: "member" })
    .onConflictDoNothing();
  return true;
}
