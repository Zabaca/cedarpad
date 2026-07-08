// The wire shapes the Inbox stage reads from the edge Inbox API (worker/inbox.ts), reused
// from their source of truth rather than re-declared (CLAUDE.md §7): the list projects a
// Conversation to `InboxItem` (worker/inbox-view.ts) and the transcript is a `ChatEvent[]`
// (shared/chat-wire.ts). Both are TYPE-only imports, so the shell bundle never pulls the
// edge/container code in — they exist purely to keep sender and receiver in lockstep.
import type { ChatEvent } from '../../../shared/chat-wire';
import type { InboxItem } from '../../../worker/inbox-view';

export type { ChatEvent, InboxItem };

/** `GET /api/inbox?status=&workspace=` → the ordered list (waiting_on:human pinned). */
export type InboxListResponse = { items: InboxItem[] };

/** The thread head reads only these fields off the detail's Conversation row. */
export type InboxConversation = {
  sessionId: string;
  status: 'open' | 'closed';
  summary: string | null;
};

/** `GET /api/inbox/:id` → the Conversation + its transcript, read from R2 (runner may sleep). */
export type InboxDetailResponse = { conversation: InboxConversation; events: ChatEvent[] };

/** The status filter: the two store statuses, or '' for "All". */
export type StatusFilter = 'open' | 'closed' | '';
