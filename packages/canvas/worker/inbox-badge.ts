import type { Database } from '../web-poc/lib/db/index.ts';
import { inboxWatermark } from '../web-poc/lib/db/queries/inbox-watermark.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { listVisibleConversations } from './access.ts';
import { orderInbox, unseenCount, viewToListOpts } from './inbox-view.ts';

// What ONE connected tab's nav badge costs (#383), kept free of the edge runtime and of
// timers so the cost is measurable in a unit test (`inbox-badge.test.ts`) rather than
// argued about. `inbox.ts` owns the SSE plumbing around it; this owns the decision of when
// to touch D1 at all.
//
// The stream this backs used to recompute the badge unconditionally every 10s per tab —
// 1.6M rows a day in production to answer a question whose answer changed a few hundred
// times. The fix is not a cache (ADR-0022: a second copy of the truth diverges); it is
// asking a CHEAPER question first. Nothing about the count is stored anywhere but in this
// one connection's memory, next to the stream that already holds it.

/** The SSE frame's payload — the nav badge and the shared read mark it is counted against. */
export interface InboxBadge {
  count: number;
  readAt: number;
}

export interface InboxBadgeSource {
  /**
   * The quiet path. Read the watermark; only if it moved, re-read the inbox. Answers the
   * frame to send, or null when there is nothing new to say — which is almost always.
   */
  poll(): Promise<InboxBadge | null>;
  /**
   * The notified path (#383 part 2): something changed and the hub said so, so skip the
   * probe and recompute. Still answers null when the number did not actually move — the
   * hub reports that the INBOX changed, which is a broader thing than the badge changing.
   */
  push(): Promise<InboxBadge | null>;
}

/**
 * One connection's badge source. `userId` is fixed because the badge is per-viewer:
 * ADR-0016 visibility means two members of one workspace can legitimately see different
 * counts, so the filtering cannot be shared or hoisted anywhere.
 */
export function inboxBadgeSource(database: Database, workspaceId: string, userId: string): InboxBadgeSource {
  // The two things this connection remembers. Neither is inbox state: `mark` is a
  // change detector and `count` is what this socket last SAID, kept only so the stream
  // does not repeat itself.
  let mark: string | null = null;
  let count = -1;

  const recompute = async (): Promise<InboxBadge | null> => {
    const items = orderInbox(await listVisibleConversations(database, workspaceId, userId, viewToListOpts(null)));
    const ws = await getWorkspace(database, workspaceId, userId);
    const readAt = ws?.inboxReadAt ? ws.inboxReadAt.getTime() : 0;
    const next = unseenCount(items, readAt);
    if (next === count) return null;
    count = next;
    return { count: next, readAt };
  };

  return {
    async poll() {
      const now = await inboxWatermark(database, workspaceId);
      if (now === mark) return null;
      mark = now;
      return recompute();
    },
    async push() {
      // The watermark is refreshed even though it was not consulted: a poll that ran right
      // after this must not re-read rows this call already read.
      mark = await inboxWatermark(database, workspaceId);
      return recompute();
    },
  };
}
