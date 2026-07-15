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
  /** Session type: 'dev-agent' rows get a badge; they live in their real workspace now. */
  kind: 'chat' | 'dev-agent';
  unread: boolean;
  summary: string | null;
  lastMessagePreview: string | null;
  workspaceId: string;
  /** The chat→canvas edge (canvas pairing): the canvas this chat's card lives on, or null. */
  canvasId: string | null;
  /** The ASSIGNEE (advisory claim — shared inbox); null = unassigned. */
  assignedTo: string | null;
  lastActivity: number;
}

/** Pure: project a row to its list view (last_activity normalized to epoch ms). */
const toItem = (r: ConversationRow): InboxItem => ({
  id: r.id,
  status: r.status,
  waitingOn: r.waitingOn,
  kind: r.kind,
  unread: r.unread,
  summary: r.summary,
  lastMessagePreview: r.lastMessagePreview,
  workspaceId: r.workspaceId,
  canvasId: r.canvasId,
  assignedTo: r.assignedTo,
  lastActivity: r.lastActivity instanceof Date ? r.lastActivity.getTime() : Number(r.lastActivity),
});

/**
 * Pure inbox ordering: `waiting_on:human` items pinned to the top (they need attention),
 * everything else after, each group newest-activity first. Independent of the input order
 * so it is deterministic regardless of how the store returned the rows.
 */
export function orderInbox(rows: ConversationRow[]): InboxItem[] {
  const items = rows.map(toItem);
  const rank = (i: InboxItem) => (i.status === 'open' && i.waitingOn === 'human' ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity);
}

/** The three Inbox views the Shell can request. `open` (default) is every open session; `all` is
 *  the unified session index with no status filter (open and closed); `closed` is the archive.
 *  The waiting_on:human pinning in `orderInbox` still surfaces attention at the top of Open. */
export type InboxView = 'open' | 'all' | 'closed';

/** Pure: map a requested view to a `conversations.list` filter. Unknown/absent → `open` (also a
 *  legacy `?view=needs-me`, the retired view), so the default (and any caller that omits the
 *  param) never gets the full firehose by accident. */
export function viewToListOpts(view: string | null): {
  status?: 'open' | 'closed';
  waitingOn?: 'human' | 'agent' | 'none';
} {
  if (view === 'closed') return { status: 'closed' };
  if (view === 'all') return {};
  return { status: 'open' };
}

/** Pure, stable R2 object URL for a session's transcript blob (S3 path-style). */
export function transcriptObjectUrl(endpoint: string, bucket: string, sessionId: string): string {
  return `${endpoint.replace(/\/$/, '')}/${bucket}/${transcriptKey(sessionId)}`;
}
