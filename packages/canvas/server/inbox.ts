// The container's half of the Inbox (PRD #50 — slice #61), kept pure and seam-driven so it
// tests under a fake SDK:
//   endTurn(...)           — the `end_turn` tool's logic: declare this turn's ending over the
//                            platform RPC, ask for the notification, and return text telling
//                            the agent to STOP. It NEVER blocks.
//   openConversation(...)  — prepare a Conversation to be opened live: restore its session
//                            JSONL from R2 onto the runner and resolve its chatId.
//   placeChatCard(...)     — canvas pairing's container half (#264).
// ADR-0018 / #266: none of these hold a platform-data-layer client. Every row-shaped step
// happens at the edge — either pushed down through the proxy or asked for over the RPC — so
// this module's only injected collaborators are that RPC, the R2 seam, and a notify seam.

import { findOrCreateConversation } from '../web-poc/lib/db/find-or-create-conversation.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { ForwardedPairing } from '../shared/bridge-wire.ts';
import type { PlatformRpc } from './platform-rpc-client.ts';
import { type BlobGetter, readRawTranscript, restore as restoreTranscript } from './transcript-r2.ts';

/** Best-effort attention signal fired when a Conversation flips to waiting_on:human. Named by
 * ID, not by row: since #266 the container never holds a Conversation, and delivery (who is
 * watching, which devices they hold) is resolved entirely at the edge. Never throws into the
 * tool path. */
export type Notify = (conversationId: string, question: string) => void | Promise<void>;

// `findOrCreateConversation` now lives in the platform data layer (ADR-0018): the edge runs it
// too, for the platform RPC's `conversation.start` operation, and worker code cannot import this
// module (it reaches node:fs through the transcript seam). Re-exported so call sites are unchanged.
export { findOrCreateConversation };

/** The seam card placement needs from a canvas session: current shapes (for free-space
 * placement) and an upsert (to place the card). The bridge adapts a room store to
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

export interface EndTurnDeps {
  /** The container's only path into the platform data layer (ADR-0018 / #266). Null when there
   *  is no edge in front of this bridge — the tool then only answers the agent. */
  rpc: PlatformRpc | null;
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
 *
 * ADR-0018 / #266: the row transition happens at the EDGE, over the platform RPC's `turn.end`
 * operation — the container has no platform-data-layer client to make it with. The id that
 * comes back is the handle the `notify` ping then names, so this tool still orchestrates the
 * two steps; it just no longer touches a row. Best-effort throughout: an unreachable edge
 * still answers the agent, exactly as a failed write did.
 */
export async function endTurn(deps: EndTurnDeps, input: EndTurnInput): Promise<string> {
  const sessionId = deps.getSessionId();
  if (!sessionId) {
    return 'end_turn is unavailable right now (this session has no id yet). Finish your message and stop.';
  }
  const filed = await deps.rpc?.turnEnd({
    sessionId,
    userId: deps.userId,
    workspaceId: deps.workspaceId,
    kind: deps.kind,
    ownerRef: deps.ownerRef,
    summary: input.summary,
    outcome: input.outcome,
    ...(input.outcome === 'needs_human' ? { question: input.question } : {}),
  });
  if (input.outcome === 'done') {
    return 'Turn ending recorded (done). Stop here — do not continue working.';
  }
  try {
    if (filed) await deps.notify?.(filed.conversationId, input.question);
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
