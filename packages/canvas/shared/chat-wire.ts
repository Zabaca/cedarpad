// The multiplexed chat SSE wire shape: the ONE module that owns the typed
// contract spoken across the chat seam. All three sides import from here so a new
// kind is added in exactly one place:
//   - PRODUCER: server/bridge.ts wraps each event as a ChatFrame and broadcasts it.
//   - SOURCE OF TRUTH: server/agent.ts's runChat() yields the ChatEvent stream.
//   - CONSUMER / ROUTER: src/chat-store.ts parses, guards, and routes frames by chatId.
//
// No upward dependency: the kind literals are inlined below, so both server/ and
// src/ depend on this module and never the reverse. One place to read, one to grep.

/** Background-task lifecycle status (the jobs tray): shell | subagent | monitor | workflow. */
export type TaskStatus = 'running' | 'pending' | 'paused' | 'completed' | 'failed' | 'stopped' | 'killed';

/** A plan/todo item's status. `deleted` is a tombstone the router applies then drops. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/**
 * The typed event stream one chat turn emits, discriminated on `kind`. The 9 kinds:
 * `init` | `delta` | `tool_start` | `tool` | `thinking` | `tool_progress` | `task` | `todo` | `done`.
 *
 * `parentId` (= the spawning Task tool_use id) is set on events that came from a
 * subagent, so the UI nests them under that Task chip. Absent = the main agent.
 */
export type ChatEvent =
  // A turn started and the SDK assigned/confirmed its session id (the system/init message).
  // Emitted once per LIVE turn (suppressed in replay): the bridge indexes the session in the
  // Inbox the moment it starts (ADR-0011 row-at-start), and other tabs learn a turn began
  // for a chat they didn't send on (the foreign-busy signal).
  | { kind: 'init'; sessionId: string }
  // incremental assistant text (token-by-token). `role:'user'` is set ONLY by the JSONL
  // replay projection (ADR 0004) to render the human's own messages on rehydration; the
  // live stream never sets it (the client adds user bubbles locally), so absent = agent.
  | { kind: 'delta'; text: string; parentId?: string; role?: 'user' }
  | { kind: 'tool_start'; name: string; parentId?: string } // a tool call is beginning (input not yet known)
  | { kind: 'tool'; name: string; input: unknown; id?: string; parentId?: string } // tool call complete; `id` is its tool_use id
  // Live thinking progress: Opus redacts its chain-of-thought, so the only movement during a
  // long think is this running token estimate (digested by the SDK from thinking_delta pings).
  | { kind: 'thinking'; thinkingTokens: number; parentId?: string }
  // A still-running tool's elapsed seconds (e.g. a long Bash) so "running X" stops looking hung.
  | { kind: 'tool_progress'; name: string; elapsed: number; parentId?: string }
  // Background-task lifecycle (shell | subagent | monitor | workflow), keyed by task_id for
  // the jobs tray; `toolUseId` (when present) also decorates the matching chip inline.
  | { kind: 'task'; taskId: string; status?: TaskStatus; taskType?: string; title?: string; detail?: string; summary?: string; toolUseId?: string }
  // The agent's TODO list (TaskCreate/TaskUpdate tools), a plan/checklist distinct from
  // background tasks. Surfaced in its own panel; the chips are suppressed from the transcript.
  | { kind: 'todo'; todoId: string; subject?: string; todoStatus?: TodoStatus }
  | { kind: 'done'; sessionId: string | null; costUsd: number; error?: string; contextPct?: number }
  // Server-owned per-chat config (ADR 0004): broadcast when a tab POSTs a model/effort/fork
  // change, so every open tab converges. Also carried in the rehydration GET's `config`.
  | { kind: 'config'; model?: string; effort?: string; forkNext?: boolean };

/**
 * The on-wire shape: a {@link ChatEvent} tagged with the chat it belongs to. The
 * single SSE stream multiplexes every chat's events, so each frame carries `chatId`
 * and the client routes it to the right session.
 */
export type ChatFrame = { chatId: string } & ChatEvent;

/**
 * Runtime guard: a value parsed off the SSE channel is a {@link ChatFrame}. Checks
 * only the routing-critical fields (a string `chatId` and a string `kind`), so the
 * router can drop non-frame messages before narrowing on `kind`. A malformed/foreign
 * message fails here and is silently ignored.
 */
export function isChatFrame(x: unknown): x is ChatFrame {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.chatId === 'string' && typeof o.kind === 'string';
}
