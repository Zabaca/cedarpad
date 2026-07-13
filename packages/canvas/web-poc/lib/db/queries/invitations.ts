import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../client.js";
import { type WorkspaceInvitationRow, workspaceInvitations } from "../schema.js";
import { addWorkspaceMember } from "./workspaces.js";

/**
 * Workspace invitations (#179). Email-bound, single-use, expiring. The row id IS
 * the invite-link token (crypto-random). Time is always injected (`nowMs`) — the
 * edge passes Date.now(); tests pass a fixed clock. Statuses: pending → accepted
 * | revoked (expiry is judged against `expiresAt`, not stored as a status).
 */

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000; // matches the design's ~48h window

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createWorkspaceInvitation(
  db: Database,
  input: { workspaceId: string; email: string; inviterUserId: string; nowMs: number; ttlMs?: number },
): Promise<WorkspaceInvitationRow> {
  const [row] = await db
    .insert(workspaceInvitations)
    .values({
      id: `wi_${crypto.randomUUID()}`,
      workspaceId: input.workspaceId,
      email: normalizeEmail(input.email),
      inviterUserId: input.inviterUserId,
      expiresAt: new Date(input.nowMs + (input.ttlMs ?? DEFAULT_TTL_MS)),
    })
    .returning();
  if (!row) throw new Error("createWorkspaceInvitation: insert returned no row");
  return row;
}

export type AcceptResult =
  | { ok: true; workspaceId: string }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" | "email_mismatch" };

/** Validate a token WITHOUT consuming it (drives the accept page's branching). */
export async function getAcceptableInvitation(
  db: Database,
  token: string,
  nowMs: number,
): Promise<{ row: WorkspaceInvitationRow } | { error: Exclude<AcceptResult, { ok: true }>["reason"] }> {
  const [row] = await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.id, token)).limit(1);
  if (!row) return { error: "not_found" };
  if (row.status !== "pending") return { error: "not_pending" };
  if (row.expiresAt.getTime() < nowMs) return { error: "expired" };
  return { row };
}

/** Consume a pending invitation: verifies binding + freshness, adds membership,
 *  marks accepted. The status flip is guarded on `pending` so a raced double
 *  accept can't run twice. */
export async function acceptWorkspaceInvitation(
  db: Database,
  input: { token: string; userId: string; email: string; nowMs: number },
): Promise<AcceptResult> {
  const found = await getAcceptableInvitation(db, input.token, input.nowMs);
  if ("error" in found) return { ok: false, reason: found.error };
  if (found.row.email !== normalizeEmail(input.email)) return { ok: false, reason: "email_mismatch" };

  const flipped = await db
    .update(workspaceInvitations)
    .set({ status: "accepted" })
    .where(and(eq(workspaceInvitations.id, input.token), eq(workspaceInvitations.status, "pending")))
    .returning({ id: workspaceInvitations.id });
  if (flipped.length === 0) return { ok: false, reason: "not_pending" };

  await addWorkspaceMember(db, { workspaceId: found.row.workspaceId, userId: input.userId, role: found.row.role });
  return { ok: true, workspaceId: found.row.workspaceId };
}

/** Owner-side revoke of a pending invitation. Returns false if nothing was pending. */
export async function revokeWorkspaceInvitation(
  db: Database,
  input: { token: string; workspaceId: string },
): Promise<boolean> {
  const rows = await db
    .update(workspaceInvitations)
    .set({ status: "revoked" })
    .where(
      and(
        eq(workspaceInvitations.id, input.token),
        eq(workspaceInvitations.workspaceId, input.workspaceId),
        eq(workspaceInvitations.status, "pending"),
      ),
    )
    .returning({ id: workspaceInvitations.id });
  return rows.length > 0;
}

/** Pending (unexpired) invitations for a workspace — the owner's revoke list. */
export async function listPendingInvitations(
  db: Database,
  workspaceId: string,
  nowMs: number,
): Promise<WorkspaceInvitationRow[]> {
  return db
    .select()
    .from(workspaceInvitations)
    .where(
      and(
        eq(workspaceInvitations.workspaceId, workspaceId),
        eq(workspaceInvitations.status, "pending"),
        gt(workspaceInvitations.expiresAt, new Date(nowMs)),
      ),
    );
}
