import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "../client.js";
import { type ConversationRow, conversations } from "../schema.js";

/**
 * Conversation store (PRD #50, Inbox). The WORKSPACE-SHARED session index: each
 * row couples a Claude Agent SDK Session (`sessionId`) to its inbox state. This
 * module owns the STATE TRANSITIONS of the two-axis model (status × waiting_on
 * + unread), not just CRUD — the inbox coordinates sessions, it doesn't hold
 * transcripts (those live in the SDK JSONL / R2, #60). Backend only.
 */

const newConversationId = () => `conv_${crypto.randomUUID()}`;
const now = () => new Date();

/** Create a Conversation for a session, owned by a user in a workspace. */
export async function create(
  db: Database,
  input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
    kind?: (typeof conversations.kind.enumValues)[number];
    ownerRef?: string | null;
    canvasId?: string | null;
    repo?: string | null;
    summary?: string | null;
    lastMessagePreview?: string | null;
    /** The assignee at birth: a human initiator claims their session; unattended
     *  (cron) starts stay unassigned. */
    assignedTo?: string | null;
    /** ADR-0016: the human initiator (immutable). Null = unattended start. */
    createdBy?: string | null;
  },
): Promise<ConversationRow> {
  const [row] = await db
    .insert(conversations)
    .values({
      id: newConversationId(),
      sessionId: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      assignedTo: input.assignedTo ?? null,
      createdBy: input.createdBy ?? null,
      kind: input.kind ?? "chat",
      ownerRef: input.ownerRef ?? null,
      canvasId: input.canvasId ?? null,
      repo: input.repo ?? null,
      summary: input.summary ?? null,
      lastMessagePreview: input.lastMessagePreview ?? null,
      // Stamped rather than left to the column default (#383). That default is
      // `unixepoch() * 1000` — seconds scaled up — and the inbox watermark compares
      // `max(updated_at)` for equality, so a chat born in the same second as the previous
      // change would leave the watermark untouched and never reach the badge.
      updatedAt: now(),
    })
    .returning();
  if (!row) throw new Error("create: insert returned no row");
  return row;
}

/** Get a Conversation by id, or null if it does not exist. */
export async function get(db: Database, id: string): Promise<ConversationRow | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

/**
 * Get the Conversation coupled to a Session, or null if none exists yet. Newest
 * activity first (a sessionId maps to one Conversation, but ordering keeps the
 * find-or-create in `ask_human` deterministic). This is how the promote protocol
 * upserts by `sessionId` instead of by our own id.
 */
export async function getBySessionId(db: Database, sessionId: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.sessionId, sessionId))
    .orderBy(desc(conversations.lastActivity))
    .limit(1);
  return row ?? null;
}

/**
 * List Conversations, newest activity first. The Inbox is WORKSPACE-SHARED (never
 * user-scoped — CONTEXT.md): callers scope by `workspaceId` (access-checked upstream),
 * and optionally filter by `status`, `waitingOn`, or `assigned` (a user id, or the
 * literal 'unassigned' for the unclaimed queue).
 */
export async function list(
  db: Database,
  opts: {
    status?: (typeof conversations.status.enumValues)[number];
    workspaceId?: string;
    waitingOn?: (typeof conversations.waitingOn.enumValues)[number];
    assigned?: string | "unassigned";
  } = {},
): Promise<ConversationRow[]> {
  const filters = [];
  if (opts.status) filters.push(eq(conversations.status, opts.status));
  if (opts.workspaceId) filters.push(eq(conversations.workspaceId, opts.workspaceId));
  // waiting_on:human is the attention subset; "All" omits it so every session — canvas
  // chats, dev-agent runs — shows in the unified index (#unified-index).
  if (opts.waitingOn) filters.push(eq(conversations.waitingOn, opts.waitingOn));
  if (opts.assigned) {
    filters.push(opts.assigned === "unassigned" ? isNull(conversations.assignedTo) : eq(conversations.assignedTo, opts.assigned));
  }
  return db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(conversations.lastActivity));
}

/**
 * Update helper: apply a patch to one row and return it (null if missing).
 *
 * Every patch stamps `updated_at`. That column is what the inbox WATERMARK
 * (`queries/inbox-watermark.ts`, #383) reads, so a transition that leaves
 * `last_activity` alone — close, reopen, assign, a visibility flip — still has to be
 * visible to a badge stream that is only allowed one cheap query per tick. Left
 * unstamped it would read as "nothing changed" and the badge would go stale.
 */
async function patch(
  db: Database,
  id: string,
  values: Partial<typeof conversations.$inferInsert>,
): Promise<ConversationRow | null> {
  const [row] = await db
    .update(conversations)
    .set({ ...values, updatedAt: now() })
    .where(eq(conversations.id, id))
    .returning();
  return row ?? null;
}

/**
 * Promote: an agent asks for the human. → open, waiting_on:human, unread, and
 * touch last_activity so it sorts to the top of the inbox.
 */
export async function promote(db: Database, id: string, preview?: string): Promise<ConversationRow | null> {
  return patch(db, id, {
    status: "open",
    waitingOn: "human",
    unread: true,
    lastActivity: now(),
    ...(preview !== undefined ? { lastMessagePreview: preview } : {}),
  });
}

/**
 * Done: the agent declares the turn's work complete (end_turn outcome:done, ADR-0012).
 * Nothing pending → waiting_on:none; unread + preview so "All" shows what finished.
 */
export async function markDone(db: Database, id: string, preview: string): Promise<ConversationRow | null> {
  return patch(db, id, {
    waitingOn: "none",
    unread: true,
    lastMessagePreview: preview,
    lastActivity: now(),
  });
}

/**
 * Reply: the human answers → hand the turn back to the agent (waiting_on:agent),
 * clear unread, touch last_activity.
 */
export async function reply(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, {
    waitingOn: "agent",
    unread: false,
    lastActivity: now(),
  });
}

/** Assign (advisory claim, never a lock): set the assignee, or clear with null.
 *  Returns the row, or null if missing. No last_activity touch — a triage act,
 *  not session activity. */
export async function assign(db: Database, id: string, userId: string | null): Promise<ConversationRow | null> {
  return patch(db, id, { assignedTo: userId });
}

/** ADR-0016: flip a chat's own visibility flag (authorization is the caller's job).
 *  No last_activity touch — a triage act, like assign. */
export async function setVisibility(
  db: Database,
  id: string,
  visibility: "shared" | "private",
): Promise<ConversationRow | null> {
  return patch(db, id, { visibility });
}

/** Get the Conversation owned by a chat (`owner_ref` = the bridge chatId), or null. */
export async function getByOwnerRef(db: Database, ownerRef: string): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.ownerRef, ownerRef))
    .limit(1);
  return row ?? null;
}

/** Re-point a Conversation at its chat's newest SDK session — resume mints a NEW sessionId
 * every turn, so the chat (owner_ref) is the identity and session_id is just the current
 * resume pointer. Touches last_activity (a rebind only happens because a turn ran). */
export async function rebindSession(db: Database, id: string, sessionId: string): Promise<ConversationRow | null> {
  return patch(db, id, { sessionId, lastActivity: now() });
}

/** Backfill the owning-chat pointer on a legacy row (pre-owner_ref rows). */
export async function setOwnerRef(db: Database, id: string, ownerRef: string): Promise<ConversationRow | null> {
  return patch(db, id, { ownerRef });
}

/** Set the chat→canvas edge, first-wins: only when the row has no canvas yet (a chat
 * lives on at most one canvas; there is no detach in v1). Returns the row, or null
 * if the conversation is missing. */
export async function attachCanvas(db: Database, id: string, canvasId: string): Promise<ConversationRow | null> {
  await db
    .update(conversations)
    .set({ canvasId, updatedAt: now() })
    .where(and(eq(conversations.id, id), isNull(conversations.canvasId)));
  return get(db, id);
}

/** Set the run→repo edge, first-wins (mirrors attachCanvas): only when the row has no
 * repo yet — a dev-agent conversation operates on exactly one repo for its lifetime
 * (ADR-0015: one run = one repo). */
export async function attachRepo(db: Database, id: string, repo: string): Promise<ConversationRow | null> {
  await db
    .update(conversations)
    .set({ repo, updatedAt: now() })
    .where(and(eq(conversations.id, id), isNull(conversations.repo)));
  return get(db, id);
}

/** Record the PR this dev-agent run opened (CONTEXT.md "Open PR"). Last-wins, unlike the
 * first-wins edges above: a run may open a second PR after the first is merged or closed,
 * and the row names the one currently in play. Stamping a new PR clears any merge mark. */
export async function recordPr(db: Database, id: string, prUrl: string): Promise<ConversationRow | null> {
  return patch(db, id, { prUrl, prMergedAt: null });
}

/** Land the recorded PR: stamp the merge and CLOSE the conversation in one act — landing
 * the PR is what ends a dev-agent run (grill 2026-07-29). */
export async function markPrMerged(db: Database, id: string, at: Date = now()): Promise<ConversationRow | null> {
  return patch(db, id, { prMergedAt: at, status: "closed", waitingOn: "none" });
}

/** Hard-delete a Conversation row (legacy-duplicate cleanup only — product flows archive
 * via close(), they never delete). */
export async function remove(db: Database, id: string): Promise<void> {
  await db.delete(conversations).where(eq(conversations.id, id));
}

/** Touch last_activity only (axes + unread unchanged) — a turn ran, sort it to the top. */
export async function touch(db: Database, id: string, at: Date = now()): Promise<ConversationRow | null> {
  return patch(db, id, { lastActivity: at });
}

/** Mark new agent activity: unread + touch last_activity (axes unchanged). */
export async function markActivity(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { unread: true, lastActivity: now() });
}

/** Mark read: clears unread only. No last_activity touch — reading isn't activity, and
 * touching it would resort the list under the human's own click. */
export async function markRead(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { unread: false });
}

/** Close (archive): filtered out of the default inbox view. Also clears waiting_on — archiving
 * resolves the ask, so a closed Conversation never needs to pin for attention. */
export async function close(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { status: "closed", waitingOn: "none" });
}

/** Reopen a closed Conversation. */
export async function reopen(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { status: "open" });
}
