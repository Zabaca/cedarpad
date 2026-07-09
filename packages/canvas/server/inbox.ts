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
import type { Database } from '../web-poc/lib/db/index.ts';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { CanvasImage } from './agent.ts';
import { type BlobGetter, restore as restoreTranscript } from './transcript-r2.ts';

/** Best-effort attention signal fired when a Conversation flips to waiting_on:human. A stub/log
 * this slice; wire a real PushNotification later. Never throws into the tool path. */
export type Notify = (conversation: ConversationRow, question: string) => void | Promise<void>;

/**
 * Find-or-create the Conversation for a Session, idempotent by `sessionId`: a second `ask_human`
 * on the same session returns the existing row (it is then re-promoted, not duplicated).
 */
export async function findOrCreateConversation(
  db: Database,
  input: { sessionId: string; userId: string; workspaceId: string; summary?: string | null },
): Promise<ConversationRow> {
  const existing = await conversations.getBySessionId(db, input.sessionId);
  if (existing) return existing;
  return conversations.create(db, {
    sessionId: input.sessionId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    summary: input.summary ?? null,
    lastMessagePreview: input.summary ?? null,
  });
}

export interface AskHumanDeps {
  db: Database;
  /** The running session's id. Read lazily: a NEW session is only assigned an id mid-turn (the
   *  SDK init message), so the tool reads it at call time, not at factory time. */
  getSessionId: () => string | null;
  userId: string;
  workspaceId: string;
  notify?: Notify;
}

/**
 * The `ask_human` tool body. Upserts + promotes this session's Conversation, fires notify, and
 * returns agent-facing text. Returns WITHOUT waiting for a reply — the agent commits its work and
 * ends its turn; the human's later reply resumes the session (see resumeConversation).
 */
export async function askHuman(deps: AskHumanDeps, input: { summary: string; question: string }): Promise<string> {
  const sessionId = deps.getSessionId();
  if (!sessionId) {
    return 'ask_human is unavailable right now (this session has no id yet). Answer as best you can, or try again next turn.';
  }
  const conv = await findOrCreateConversation(deps.db, {
    sessionId,
    userId: deps.userId,
    workspaceId: deps.workspaceId,
    summary: input.summary,
  });
  const promoted = await conversations.promote(deps.db, conv.id);
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
