import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type WorkspaceRow, workspaces } from "../schema.js";

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

/** List the caller's workspaces (owner-scoped), oldest first. */
export async function listWorkspaces(db: Database, userId: string): Promise<WorkspaceRecord[]> {
  const rows = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.ownerUserId, userId))
    .orderBy(asc(workspaces.createdAt));
  return rows.map(toRecord);
}

/**
 * Get a workspace by id, enforcing ownership: returns null if it does not exist
 * or is owned by another user (PRD #42, story 22).
 */
export async function getWorkspace(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRecord | null> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, userId)))
    .limit(1);
  return row ? toRecord(row) : null;
}
