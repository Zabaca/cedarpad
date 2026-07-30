import { sql } from "drizzle-orm";
import type { Database } from "../client.js";

/**
 * The inbox WATERMARK (#383): one cheap scalar that changes whenever anything the nav
 * badge is derived from changes, so a badge stream can ask "did anything move?" without
 * re-reading the inbox.
 *
 * The badge is a function of three things — the workspace's conversation rows, the
 * workspace's shared read mark, and (via the canvas join) the canvas registry. The first
 * two are covered here, in ONE statement with two correlated scalar sub-selects; both
 * sub-selects are point lookups against an index, so the probe reads a row or two rather
 * than the ~16 a full `visibleInbox` + read-mark pair does.
 *
 * It is a CHANGE DETECTOR, not a cached answer (ADR-0022): nothing about the count is
 * stored, so the watermark can only ever be late, never wrong. When it moves, the caller
 * still recomputes from the rows.
 *
 * Three things it deliberately does not see, all of which are recovered by the events hub
 * notifying (#383 part 2), by the next conversation change, or by a page load:
 *   - a HARD-DELETED conversation (`conversations.remove`) — a MAX cannot see a row that is
 *     gone, and covering it would need a COUNT, i.e. a scan of every row in the workspace,
 *     which is the cost this exists to avoid. `remove` is legacy-duplicate cleanup only;
 *     product flows archive with `close`.
 *   - a CANVAS registry change (create / rename / visibility / delete). The canvas table
 *     carries no `updated_at`, and a chat's visibility can be dominated by its canvas's.
 *   - two changes inside the same millisecond that cancel out (close then reopen).
 */
export async function inboxWatermark(db: Database, workspaceId: string): Promise<string> {
  const row = await db.get<{ conversations_at: number | null; read_at: number | null }>(sql`
    select
      (select max(updated_at) from conversations where workspace_id = ${workspaceId}) as conversations_at,
      (select inbox_read_at from workspaces where id = ${workspaceId}) as read_at
  `);
  // A string, not a number: it composes two independent clocks, and the caller only ever
  // compares it for equality with the previous one.
  return `${row?.conversations_at ?? 0}.${row?.read_at ?? 0}`;
}
