import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../client.js";
import { type ConversationRow, conversations } from "../schema.js";

/**
 * Conversation store (PRD #50, Inbox). The user-scoped attention inbox: each
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
    ownerRef?: string | null;
    summary?: string | null;
    lastMessagePreview?: string | null;
  },
): Promise<ConversationRow> {
  const [row] = await db
    .insert(conversations)
    .values({
      id: newConversationId(),
      sessionId: input.sessionId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      ownerRef: input.ownerRef ?? null,
      summary: input.summary ?? null,
      lastMessagePreview: input.lastMessagePreview ?? null,
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
 * List a user's Conversations, newest activity first. The Inbox is user-scoped:
 * only the caller's rows, aggregated across their workspaces. Optionally filter
 * by `status` and/or platform `workspaceId`.
 */
export async function list(
  db: Database,
  userId: string,
  opts: {
    status?: (typeof conversations.status.enumValues)[number];
    workspaceId?: string;
    waitingOn?: (typeof conversations.waitingOn.enumValues)[number];
  } = {},
): Promise<ConversationRow[]> {
  const filters = [eq(conversations.userId, userId)];
  if (opts.status) filters.push(eq(conversations.status, opts.status));
  if (opts.workspaceId) filters.push(eq(conversations.workspaceId, opts.workspaceId));
  // The "needs me" view filters to waiting_on:human (the attention subset); "All" omits it so
  // every session — canvas chats, dev-agent runs — shows in the unified index (#unified-index).
  if (opts.waitingOn) filters.push(eq(conversations.waitingOn, opts.waitingOn));
  return db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(conversations.lastActivity));
}

/** Update helper: apply a patch to one row and return it (null if missing). */
async function patch(
  db: Database,
  id: string,
  values: Partial<typeof conversations.$inferInsert>,
): Promise<ConversationRow | null> {
  const [row] = await db
    .update(conversations)
    .set(values)
    .where(eq(conversations.id, id))
    .returning();
  return row ?? null;
}

/**
 * Promote: an agent asks for the human. → open, waiting_on:human, unread, and
 * touch last_activity so it sorts to the top of the inbox.
 */
export async function promote(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, {
    status: "open",
    waitingOn: "human",
    unread: true,
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

/** Touch last_activity only (axes + unread unchanged) — a turn ran, sort it to the top. */
export async function touch(db: Database, id: string, at: Date = now()): Promise<ConversationRow | null> {
  return patch(db, id, { lastActivity: at });
}

/** Mark new agent activity: unread + touch last_activity (axes unchanged). */
export async function markActivity(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { unread: true, lastActivity: now() });
}

/** Close (archive): filtered out of the default inbox view. */
export async function close(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { status: "closed" });
}

/** Reopen a closed Conversation. */
export async function reopen(db: Database, id: string): Promise<ConversationRow | null> {
  return patch(db, id, { status: "open" });
}
