import * as conversations from './queries/conversations.js';
import type { Database } from './client.js';
import type { ConversationRow } from './schema.js';

// Lives in the platform data layer (root CONTEXT.md) rather than in `server/` because BOTH
// runtimes now run it: the container calls it directly (endTurn, settleConversation) and the
// edge runs it for the `conversation.start` operation of the platform RPC (ADR-0018). Worker
// code cannot import `server/inbox.ts`, its previous home — that module reaches node:fs
// through the transcript seam, which the worker TS program (tsconfig.worker.json) does not
// carry. `server/inbox.ts` re-exports it, so its call sites and tests are unchanged.

/**
 * Find-or-create the Conversation for a chat turn. Identity is the CHAT (`ownerRef` =
 * bridge chatId), not the SDK session: resume mints a NEW sessionId every turn, so keying
 * rows by sessionId created one duplicate row per turn. A repeat call for the same chat
 * reuses its row and re-points `sessionId` at the newest session (the resume pointer);
 * legacy rows found by sessionId get their ownerRef backfilled. Every repeat touches
 * last_activity so the Inbox sorts active conversations to the top.
 */
export async function findOrCreateConversation(
  db: Database,
  input: { sessionId: string; userId: string; workspaceId: string; summary?: string | null; ownerRef?: string; canvasId?: string; assignTo?: string },
): Promise<ConversationRow> {
  // Assignment (CONTEXT.md, shared inbox): `assignTo` is the HUMAN INITIATOR of this turn
  // (edge-stamped x-inbox-assign; absent on unattended cron starts). Claim-if-unassigned:
  // a birth claims the row for its initiator, a reply into an unassigned row claims it for
  // the replier — but an already-assigned row is never silently re-targeted (advisory,
  // explicit reassignment goes through the assign endpoint).
  const claim = async (row: ConversationRow): Promise<void> => {
    if (input.assignTo && !row.assignedTo) await conversations.assign(db, row.id, input.assignTo);
  };
  // The chat→canvas edge is first-wins (attachCanvas only fills a null edge): a turn that
  // carries a canvas backfills chats born before capture, but never re-homes a linked chat.
  if (input.ownerRef) {
    const byChat = await conversations.getByOwnerRef(db, input.ownerRef);
    if (byChat) {
      if (input.canvasId && !byChat.canvasId) await conversations.attachCanvas(db, byChat.id, input.canvasId);
      await claim(byChat);
      if (byChat.sessionId !== input.sessionId) {
        return (await conversations.rebindSession(db, byChat.id, input.sessionId)) ?? byChat;
      }
      return (await conversations.touch(db, byChat.id)) ?? byChat;
    }
  }
  const existing = await conversations.getBySessionId(db, input.sessionId);
  if (existing) {
    if (input.ownerRef && !existing.ownerRef) await conversations.setOwnerRef(db, existing.id, input.ownerRef);
    if (input.canvasId && !existing.canvasId) await conversations.attachCanvas(db, existing.id, input.canvasId);
    await claim(existing);
    return (await conversations.touch(db, existing.id)) ?? existing;
  }
  return conversations.create(db, {
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    ownerRef: input.ownerRef ?? null,
    canvasId: input.canvasId ?? null,
    summary: input.summary ?? null,
    lastMessagePreview: input.summary ?? null,
    assignedTo: input.assignTo ?? null,
    // ADR-0016: the birth initiator is also the immutable creator (createdBy). Unlike
    // assignment there is no claim-on-reply — a later replier never becomes the creator.
    createdBy: input.assignTo ?? null,
  });
}
