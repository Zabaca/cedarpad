// The human-in-the-loop promote protocol (PRD #50, Inbox — slice #61). Two halves of the
// checkpoint-and-resume dance, kept pure and seam-driven so they test under a fake SDK:
//   askHuman(...)           — the `ask_human` MCP tool's logic: find-or-create the Conversation
//                             for THIS session, promote it (→ open/human/unread), notify, and
//                             return text telling the agent to END ITS TURN. It NEVER blocks.
//   resumeConversation(...) — a human reply: restore the session JSONL from R2 onto the runner,
//                             resume the SDK Session with the reply, flip → waiting_on:agent.
// Neither imports the bridge or the SDK directly; the caller injects the db, the R2 seam, a
// notify seam, and a `runTurn` that actually drives `query({ resume })`.

import { conversations } from '../web-poc/lib/db/index.ts';
import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { ForwardedPairing } from '../shared/bridge-wire.ts';
import type { CanvasImage } from './agent.ts';
import { type BlobGetter, readRawTranscript, restore as restoreTranscript } from './transcript-r2.ts';

/** Best-effort attention signal fired when a Conversation flips to waiting_on:human. A stub/log
 * this slice; wire a real PushNotification later. Never throws into the tool path. */
export type Notify = (conversation: ConversationRow, question: string) => void | Promise<void>;

// `findOrCreateConversation` now lives in the platform data layer (ADR-0018): the edge runs it
// too, for the platform RPC's `conversation.start` operation, and worker code cannot import this
// module (it reaches node:fs through the transcript seam). Re-exported so call sites are unchanged.
export { findOrCreateConversation };

/**
 * Lazy backfill (canvas pairing): chats born before edge capture existed live as `chat`
 * shapes in canvas state, but their rows carry no canvas edge. When a canvas session builds,
 * the bridge hands its chat-shape ids here; each row found by ownerRef gets the edge.
 * First-wins (attachCanvas fills only a null edge) and unknown chat ids are ignored, so the
 * call is idempotent and safe to fire on every boot. Best-effort per row.
 */
export async function backfillCanvasEdges(db: Database, canvasId: string, chatIds: string[]): Promise<void> {
  for (const chatId of chatIds) {
    const row = await conversations.getByOwnerRef(db, chatId);
    if (row && !row.canvasId) await conversations.attachCanvas(db, row.id, canvasId);
  }
}

/** The seam card placement needs from a canvas session: current shapes (for free-space
 * placement) and an upsert (to place the card). The bridge adapts its CanvasSession registry to
 * this. No database: ADR-0018 / #264 left the row work at the edge. */
export interface PlaceChatCardDeps {
  getSession: (canvasId: string) => Promise<{
    // ReadonlyArray<unknown>: the real store yields the CanvasShape union, whose arrow member
    // has no x/y/w at all — placement coerces per-shape instead of demanding a common shape.
    shapes: () => ReadonlyArray<unknown>;
    upsert: (shapes: Array<Record<string, unknown>>) => void;
  }>;
  /** The live chatId for a session (bridge ChatMeta), when known — mirrors openConversation. */
  chatIdForSession: (sessionId: string) => string | null;
}

/**
 * Canvas pairing, container half (slice 3, split in ADR-0018 / #264): place a live `chat` card
 * shape on the canvas the EDGE already paired this Conversation with, so the pairing is visible
 * from both sides. Everything row-shaped — picking or creating the canvas, the same-workspace
 * check, writing the Conversation→canvas edge — happens at the edge now and arrives here as the
 * forwarded `pairing`. The card fronts the EXISTING chat via its `chatId` prop (the shape id must
 * be a fresh `shape:` id — tldraw owns that namespace).
 */
export async function placeChatCard(deps: PlaceChatCardDeps, pairing: ForwardedPairing): Promise<void> {
  // Place the card in free space: right of everything, level with the top of the layout.
  const session = await deps.getSession(pairing.canvasId);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const shapes = session.shapes().map((s) => s as { x?: unknown; y?: unknown; w?: unknown });
  const x = shapes.length ? Math.max(...shapes.map((s) => num(s.x) + num(s.w))) + 80 : 120;
  const y = shapes.length ? Math.min(...shapes.map((s) => num(s.y))) : 120;
  const chatId = deps.chatIdForSession(pairing.sessionId) ?? pairing.ownerRef ?? pairing.id;
  session.upsert([
    {
      id: `shape:pair-${crypto.randomUUID()}`,
      type: 'chat',
      x,
      y,
      w: 380,
      h: 460,
      title: (pairing.summary ?? '').trim().slice(0, 40) || 'Chat',
      chatId,
    },
  ]);
}

/**
 * One-time cleanup for the pre-ownerRef era: sessionId-keyed rows piled up one duplicate per
 * turn (same chat, same first-message summary). For each (workspaceId, summary) group of
 * LEGACY rows (ownerRef null), keep the best row — waiting_on:human first, else newest
 * activity — and hard-delete the rest. Rows with an ownerRef are already correctly keyed and
 * are never touched. Idempotent; safe to run at every boot (post-cleanup groups have size 1).
 */
export async function dedupeLegacyConversations(db: Database, _userId: string): Promise<number> {
  // Post-shared-inbox: the cleanup sweeps ALL legacy rows (the list is no longer
  // user-scoped); the userId param is kept for call-site compatibility.
  const rows = await conversations.list(db);
  const legacy = rows.filter((r) => !r.ownerRef);
  const groups = new Map<string, ConversationRow[]>();
  for (const r of legacy) {
    const key = `${r.workspaceId}\n${r.summary ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const rank = (r: ConversationRow) => (r.waitingOn === 'human' ? 0 : 1);
    const at = (r: ConversationRow) => (r.lastActivity instanceof Date ? r.lastActivity.getTime() : Number(r.lastActivity));
    const [keep, ...rest] = [...group].sort((a, b) => rank(a) - rank(b) || at(b) - at(a));
    for (const r of rest) {
      await conversations.remove(db, r.id);
      removed += 1;
    }
    void keep;
  }
  return removed;
}

export interface EndTurnDeps {
  db: Database;
  /** The running session's id. Read lazily: a NEW session is only assigned an id mid-turn (the
   *  SDK init message), so the tool reads it at call time, not at factory time. */
  getSessionId: () => string | null;
  userId: string;
  workspaceId: string;
  /** Session type ('chat' default): dev-agent turns file their Conversation under this kind. */
  kind?: 'chat' | 'dev-agent';
  /** The bridge chatId owning this turn — the Conversation's identity key (ownerRef). */
  ownerRef?: string;
  notify?: Notify;
}

/** The `end_turn` tool's payload (ADR-0012): every turn declares its ending. */
export type EndTurnInput =
  | { outcome: 'needs_human'; summary: string; question: string }
  | { outcome: 'done'; summary: string };

/**
 * The `end_turn` tool body (ADR-0012: every turn ends by declaring its outcome).
 *   needs_human — promote this session's Conversation (open/human/unread, preview = the
 *                 question), fire notify. The human's reply later resumes the session.
 *   done        — the work is complete: waiting_on:none, unread, preview = the summary.
 * Returns agent-facing text. NEVER blocks for a reply.
 */
export async function endTurn(deps: EndTurnDeps, input: EndTurnInput): Promise<string> {
  const sessionId = deps.getSessionId();
  if (!sessionId) {
    return 'end_turn is unavailable right now (this session has no id yet). Finish your message and stop.';
  }
  const conv = await findOrCreateConversation(deps.db, {
    sessionId,
    userId: deps.userId,
    workspaceId: deps.workspaceId,
    kind: deps.kind,
    ownerRef: deps.ownerRef,
    summary: input.summary,
  });
  if (input.outcome === 'done') {
    await conversations.markDone(deps.db, conv.id, input.summary);
    return 'Turn ending recorded (done). Stop here — do not continue working.';
  }
  const promoted = await conversations.promote(deps.db, conv.id, input.question);
  try {
    await deps.notify?.(promoted ?? conv, input.question);
  } catch {
    // Notify is best-effort: a delivery failure must not fail the tool (the item is already
    // in the inbox, which is the durable signal).
  }
  return [
    'Your question was posted to the human\'s Inbox and they were notified (waiting_on: human).',
    'This tool does NOT wait for a reply. Commit any work in progress, briefly note that you are',
    'waiting on the human, and END YOUR TURN. Their reply will resume this session with full context.',
  ].join(' ');
}

export interface ResumeDeps {
  db: Database;
  /** R2 read seam — the runner's blob backend. */
  getter: BlobGetter;
  /** `~/.claude/projects` on the runner (where resume reads the JSONL). */
  projectsDir: string;
  /** The cwd the session ran under (so restore lands the JSONL at the exact resume path). */
  cwd: string;
  /** Drive one resumed turn: `query({ resume: sessionId, prompt: message })` + persist/stream.
   *  `images` are the human's pasted attachments — the SAME `CanvasImage[]` a canvas `/send`
   *  carries (one reply/send contract, ADR-0009 / #123), so a reply streams multimodal too. */
  runTurn: (sessionId: string, message: string, images: CanvasImage[]) => void | Promise<void>;
  /** Override for tests; defaults to transcript-r2 restore. */
  restore?: typeof restoreTranscript;
}

/**
 * Resume a Conversation on a human reply: pull the session JSONL from R2 back onto the runner FS
 * (so `query({ resume })` finds it after a sleep), drive the resumed turn with the reply, then flip
 * the Conversation to waiting_on:agent (clears unread). Reusable across runners — the caller
 * supplies `runTurn` (the product bridge dispatches its chat-turn machinery; #51's dev-agent runner
 * supplies its own).
 */
export async function resumeConversation(
  deps: ResumeDeps,
  conversation: ConversationRow,
  humanMessage: string,
  images: CanvasImage[] = [],
): Promise<ConversationRow | null> {
  await (deps.restore ?? restoreTranscript)(deps.getter, deps.projectsDir, deps.cwd, conversation.sessionId);
  await deps.runTurn(conversation.sessionId, humanMessage, images);
  return conversations.reply(deps.db, conversation.id);
}

export interface OpenConversationDeps {
  /** R2 read seam — the runner's blob backend. */
  getter: BlobGetter;
  /** `~/.claude/projects` on the runner (where resume reads the JSONL). */
  projectsDir: string;
  /** The cwd the session ran under (so a restore lands the JSONL at the exact resume path). */
  cwd: string;
  /** Reverse ChatMeta: the chatId homing this session as a live canvas chat, or undefined.
   *  A double-homed session returns its canvas chat id so the two surfaces share ONE stream. */
  chatIdForSession: (sessionId: string) => string | undefined;
  /** Bind the resolved chatId's ChatMeta to this session, so `/api/chat/:chatId/transcript`
   *  + `/send` resolve THIS session (a no-op when the chatId already homes it). */
  seedChatMeta: (chatId: string, sessionId: string) => void;
  /** Test seam: is the session's JSONL already on the runner FS? Default globs `projectsDir`. */
  hasLocalTranscript?: (sessionId: string) => Promise<boolean>;
  /** Override for tests; defaults to transcript-r2 restore. */
  restore?: typeof restoreTranscript;
}

/**
 * Prepare a Conversation to be OPENED as a live `<ChatView>` on its owning bridge (ADR-0009,
 * #124). Two steps, both idempotent:
 *   1. Ensure the session JSONL is on the runner FS. If the container cold-booted (no local
 *      copy), restore it from R2 — the durability/resume-restore substrate. A warm/live copy is
 *      left untouched (never clobber an in-flight canvas chat with a stale backup).
 *   2. Resolve the chatId the Shell subscribes to: `chatIdForSession(sessionId) ?? conv.id`. A
 *      session also homed as a canvas chat shares that chat's id (two live views, one stream); a
 *      headless session falls back to a stable per-conversation id. Seed that chatId's ChatMeta
 *      so the bridge's transcript + send resolve this session.
 * The R2 read here is a RESTORE (onto the runner), not the retired edge display read.
 */
export async function openConversation(
  deps: OpenConversationDeps,
  // #261: only these three fields were ever read — so the edge can forward them and the
  // bridge never needs the row itself.
  conversation: Pick<ConversationRow, 'id' | 'sessionId' | 'ownerRef'>,
): Promise<{ chatId: string }> {
  const present = await (deps.hasLocalTranscript ??
    (async (sid: string) => {
      // A missing projectsDir (fresh cold container) means "not present" — glob throws on it.
      try {
        return (await readRawTranscript(deps.projectsDir, sid)) !== null;
      } catch {
        return false;
      }
    }))(conversation.sessionId);
  if (!present) {
    await (deps.restore ?? restoreTranscript)(deps.getter, deps.projectsDir, deps.cwd, conversation.sessionId);
  }
  // Resolve the chat: a live ChatMeta homing wins; else the durable owner pointer (the chatId
  // the row was keyed by); else fall back to a stable per-conversation id (headless legacy).
  const chatId = deps.chatIdForSession(conversation.sessionId) ?? conversation.ownerRef ?? conversation.id;
  deps.seedChatMeta(chatId, conversation.sessionId);
  return { chatId };
}
