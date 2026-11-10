import { asc, count, isNull, max } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  canvases,
  componentRecords,
  session,
  shareLinks,
  skillFiles,
  user,
  workspaceMcpTokens,
  workspaceMembers,
  workspaces,
} from "../schema.js";

/**
 * The admin host's one read (ADR-0026): who is on the platform and what they own.
 *
 * Every select names its columns. That is the point of this module rather than a
 * convenience: `session.token`, `workspace_mcp_tokens.token`, the OAuth tables and
 * a session's ip/user agent never leave the database through it, so the page that
 * renders this cannot show them by accident. Read-only, no transcripts (ADR-0014).
 */

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  banned: boolean;
  createdAt: Date;
  /** The newest session's `updated_at` — Better Auth bumps it as the session is used. */
  lastSeen: Date | null;
}

export interface AdminWorkspace {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: Date;
  memberUserIds: string[];
  canvases: number;
  /** Live (not deleted) component and data records. */
  components: number;
  /** Live skill files. */
  skillFiles: number;
}

export interface AdminShareLink {
  id: string;
  canvasId: string;
  workspaceId: string;
  createdBy: string;
  guestChat: boolean;
  guestHuddle: boolean;
  guestInteract: boolean;
  guestEdit: boolean;
  guestEditSource: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface AdminMcpToken {
  workspaceId: string;
  mcpName: string;
  createdAt: Date;
}

export interface AdminOverview {
  users: AdminUser[];
  workspaces: AdminWorkspace[];
  shareLinks: AdminShareLink[];
  mcpTokens: AdminMcpToken[];
}

/** Count rows per workspace id. */
const byWorkspace = (rows: Array<{ workspaceId: string; n: number }>) =>
  new Map(rows.map((r) => [r.workspaceId, r.n]));

export async function adminOverview(db: Database): Promise<AdminOverview> {
  const [userRows, lastSeenRows, workspaceRows, memberRows, canvasRows, componentRows, skillRows, linkRows, tokenRows] =
    await Promise.all([
      db
        .select({
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          banned: user.banned,
          createdAt: user.createdAt,
        })
        .from(user)
        .orderBy(asc(user.createdAt)),
      db.select({ userId: session.userId, lastSeen: max(session.updatedAt) }).from(session).groupBy(session.userId),
      db
        .select({
          id: workspaces.id,
          name: workspaces.name,
          ownerUserId: workspaces.ownerUserId,
          createdAt: workspaces.createdAt,
        })
        .from(workspaces)
        .orderBy(asc(workspaces.createdAt)),
      db.select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId }).from(workspaceMembers),
      db.select({ workspaceId: canvases.workspaceId, n: count() }).from(canvases).groupBy(canvases.workspaceId),
      db
        .select({ workspaceId: componentRecords.workspaceId, n: count() })
        .from(componentRecords)
        .where(isNull(componentRecords.deletedAt))
        .groupBy(componentRecords.workspaceId),
      db
        .select({ workspaceId: skillFiles.workspaceId, n: count() })
        .from(skillFiles)
        .where(isNull(skillFiles.deletedAt))
        .groupBy(skillFiles.workspaceId),
      db
        .select({
          id: shareLinks.id,
          canvasId: shareLinks.canvasId,
          workspaceId: shareLinks.workspaceId,
          createdBy: shareLinks.createdBy,
          guestChat: shareLinks.guestChat,
          guestHuddle: shareLinks.guestHuddle,
          guestInteract: shareLinks.guestInteract,
          guestEdit: shareLinks.guestEdit,
          guestEditSource: shareLinks.guestEditSource,
          createdAt: shareLinks.createdAt,
          revokedAt: shareLinks.revokedAt,
        })
        .from(shareLinks)
        .orderBy(asc(shareLinks.createdAt)),
      db
        .select({
          workspaceId: workspaceMcpTokens.workspaceId,
          mcpName: workspaceMcpTokens.mcpName,
          createdAt: workspaceMcpTokens.createdAt,
        })
        .from(workspaceMcpTokens)
        .orderBy(asc(workspaceMcpTokens.createdAt)),
    ]);

  // `max()` over a timestamp column comes back as the raw stored integer, not a Date.
  const lastSeen = new Map(
    lastSeenRows.map((r) => [r.userId, r.lastSeen === null ? null : new Date(Number(r.lastSeen))]),
  );
  const members = new Map<string, string[]>();
  for (const m of memberRows) members.set(m.workspaceId, [...(members.get(m.workspaceId) ?? []), m.userId]);
  const canvasCount = byWorkspace(canvasRows);
  const componentCount = byWorkspace(componentRows);
  const skillCount = byWorkspace(skillRows);

  return {
    users: userRows.map((u) => ({ ...u, banned: u.banned ?? false, lastSeen: lastSeen.get(u.id) ?? null })),
    workspaces: workspaceRows.map((w) => ({
      ...w,
      memberUserIds: members.get(w.id) ?? [],
      canvases: canvasCount.get(w.id) ?? 0,
      components: componentCount.get(w.id) ?? 0,
      skillFiles: skillCount.get(w.id) ?? 0,
    })),
    shareLinks: linkRows,
    mcpTokens: tokenRows,
  };
}
