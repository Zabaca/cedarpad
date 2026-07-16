import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { type ShareLinkRow, shareLinks } from "../schema.js";

/**
 * Canvas share links (canvas ADR-0015, PRD #220). A link is a member-minted,
 * revocable capability for exactly one canvas. `getActiveShareLink` is what the
 * `/share/<id>` door AND the gate's per-request revocation recheck read — a
 * revoked or unknown id resolves to null, indistinguishable on purpose.
 */

export async function createShareLink(
  db: Database,
  input: { canvasId: string; workspaceId: string; createdBy: string; guestChat: boolean },
): Promise<ShareLinkRow> {
  const rows = await db
    .insert(shareLinks)
    // Explicit ms timestamp: the column's SQL default (`unixepoch() * 1000`) is
    // second-resolution, which lets two same-second links tie in newest-first sort.
    .values({ id: `sl_${crypto.randomUUID()}`, createdAt: new Date(), ...input })
    .returning();
  return rows[0] as ShareLinkRow;
}

/** The link if it exists AND is not revoked; null otherwise. */
export async function getActiveShareLink(db: Database, id: string): Promise<ShareLinkRow | null> {
  const rows = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)));
  return rows[0] ?? null;
}

/** All links ever minted for a canvas, newest first (revoked ones included, tombstoned). */
export async function listShareLinks(db: Database, canvasId: string): Promise<ShareLinkRow[]> {
  return db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.canvasId, canvasId))
    .orderBy(desc(shareLinks.createdAt));
}

/** Tombstone a link. Idempotent: revoking twice keeps the first timestamp. */
export async function revokeShareLink(db: Database, id: string): Promise<void> {
  await db
    .update(shareLinks)
    .set({ revokedAt: new Date() })
    .where(and(eq(shareLinks.id, id), isNull(shareLinks.revokedAt)));
}
