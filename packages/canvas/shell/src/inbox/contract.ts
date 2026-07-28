// The wire shapes the Inbox stage reads from the edge Inbox API (worker/inbox.ts), reused
// from their source of truth rather than re-declared (CLAUDE.md §7): the list projects a
// Conversation to `InboxItem` (worker/inbox-view.ts). A TYPE-only import, so the shell bundle
// never pulls the edge/container code in — it exists purely to keep sender and receiver in
// lockstep. The transcript is NO LONGER an edge shape: the thread is a live <ChatView> over the
// owning bridge (ADR-0009 / #124), so the runner streams it, not an R2 photograph.
import type { InboxItem, InboxView } from '../../../worker/inbox-view';

export type { InboxItem, InboxView };

/** `GET /api/inbox?view=&workspace=` → the ordered list (waiting_on:human pinned),
 *  ADR-0016-filtered server-side; `me` = the caller's user id (drives the Private
 *  toggle's creator check client-side). */
export type InboxListResponse = { items: InboxItem[]; me?: string; readAt?: number };

/** The thread head reads only these fields off the detail's Conversation row. */
export type InboxConversation = {
  sessionId: string;
  status: 'open' | 'closed';
  summary: string | null;
};

/** `GET /api/inbox/:id` → the Conversation metadata only (D1; no transcript, no wake). */
export type InboxDetailResponse = { conversation: InboxConversation };

/** `GET /inbox/:id/bridge/api/inbox/:id/chat` (through the edge proxy) → the chatId the Shell
 *  subscribes to. The bridge wakes, restores the JSONL if cold, and resolves
 *  `chatIdForSession(sessionId) ?? conv.id` — so a double-homed canvas chat shares its id. */
export type InboxChatResponse = { chatId: string };

