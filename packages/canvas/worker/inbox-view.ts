import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import { transcriptKey } from '../server/transcript-r2.ts';

// The PURE half of the edge Inbox (PRD #50 slice #62): list-ordering + the R2 object-URL
// derivation. Kept free of any `@cloudflare/sandbox` / edge-runtime import so it unit-tests
// off the edge runtime (the DB/R2/proxy handlers live in `inbox.ts`).

/** The list view a Conversation projects into the Inbox (only what the list renders). */
export interface InboxItem {
  id: string;
  status: 'open' | 'closed';
  waitingOn: 'human' | 'agent' | 'none';
  unread: boolean;
  summary: string | null;
  lastMessagePreview: string | null;
  workspaceId: string;
  lastActivity: number;
}

/** Pure: project a row to its list view (last_activity normalized to epoch ms). */
const toItem = (r: ConversationRow): InboxItem => ({
  id: r.id,
  status: r.status,
  waitingOn: r.waitingOn,
  unread: r.unread,
  summary: r.summary,
  lastMessagePreview: r.lastMessagePreview,
  workspaceId: r.workspaceId,
  lastActivity: r.lastActivity instanceof Date ? r.lastActivity.getTime() : Number(r.lastActivity),
});

/**
 * Pure inbox ordering: `waiting_on:human` items pinned to the top (they need attention),
 * everything else after, each group newest-activity first. Independent of the input order
 * so it is deterministic regardless of how the store returned the rows.
 */
export function orderInbox(rows: ConversationRow[]): InboxItem[] {
  const items = rows.map(toItem);
  const rank = (i: InboxItem) => (i.waitingOn === 'human' ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
}

/** Pure, stable R2 object URL for a session's transcript blob (S3 path-style). */
export function transcriptObjectUrl(endpoint: string, bucket: string, sessionId: string): string {
  return `${endpoint.replace(/\/$/, '')}/${bucket}/${transcriptKey(sessionId)}`;
}
