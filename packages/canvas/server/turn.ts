// The turn: one chat turn's lifecycle, made a module (extracted from bridge.ts's inline
// runChatTurn). A turn is the one thing in this system that sequences the others — it opens a
// store on the active canvas's room, drives the agent (runChat), streams its events, and on
// settle stamps the resume pointer, persists, and backs up the transcript. Every collaborator
// it touches is already a module (the room store, persist batch); this makes the
// SEQUENCE that calls them a module too, so the settle path is testable under fakes instead of
// only through a live SDK turn.
//
// bridge.ts composes the deps from its singletons; this file owns only the "when" (phase order),
// never the "what" (each collaborator). Imports are type-only but for one: opening the turn's
// room-backed canvas store (#310) is part of the phase order, not a collaborator that varies.

import type { CanvasImage, CaptureView, ChatEvent, SendToChat, runChat } from './agent.ts';
import type { FetchAsset } from '../src/canvas-ops.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';
import { openTurnCanvasStore } from './turn-canvas-store.ts';

/** What varies per turn — the request's parameters. */
export interface TurnInput {
  chatId: string;
  message: string;
  sessionId: string | null;
  images: CanvasImage[];
  model?: string;
  forkSession?: boolean;
  effort?: string;
  /** The EXPLICITLY addressed canvas (the pad's x-canvas-id / ?canvas). Absent ⇒ the turn
   * routes to `deps.defaultCanvasId`, which only the `default` workspace has. */
  canvasId?: string;
  /** ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens, decoded from the
   * proxied `x-mcp-tokens` header. */
  mcpTokens?: Record<string, string>;
  /** Per-chat MCP tool opt-outs (`mcp__<server>__<tool>` names) from the chat's ChatMeta
   * selection — appended to the SDK disallowedTools for chat turns. Wholly-disabled servers
   * never appear here; their tokens were already dropped at the send. */
  mcpDisallowedTools?: string[];
  /** WHOSE SCREEN this turn may move, from the edge-stamped x-canvas-viewer header — the
   * human who sent the message. PRESENTATION ONLY: it arms `select_page` and nothing else,
   * and must never gate a capability (see CANVAS_VIEWER_HEADER). Absent on a guest send or a
   * headless send ⇒ `select_page` is not offered at all. */
  viewer?: string;
  /** WHO THIS TURN IS BY, from the edge-stamped x-canvas-author — the Records its tools land
   *  are attributed to them. ATTRIBUTION ONLY. Absent (a guest send) ⇒ unattributed writes. */
  author?: string | null;
}

/** The stable collaborators a turn sequences. bridge.ts binds each to its singleton; every one
 *  is already its own module, so this bag IS the turn's honest test surface. */
export interface TurnDeps {
  /** Live-turn registry, keyed by chatId — set at start, cleared at settle (drives /interrupt +
   *  the one-turn-per-chat 409 guard at the wire). */
  aborters: Map<string, AbortController>;
  /** The active canvas's screenshot round-trip (`view_canvas`) — the one rider left on the
   *  bridge's SSE stream after #297 (server/screenshot-channel.ts). */
  requestScreenshot: (canvasId: string) => CaptureView;
  /** Move ONE viewer's open editors to a page on this canvas, returning how many streams it
   *  reached (server/screenshot-channel.ts). The turn partially applies its own `viewer`
   *  before handing it down, so nothing below this line ever holds an identity. */
  selectPage: (canvasId: string) => (pageId: string, viewer: string | null) => number;
  /** Open a store on the canvas's Durable-Object-hosted ROOM (ADR-0019, #310). Since #297
   *  there is no in-process store to fall back to: this is where canvas state lives. */
  openCanvasRoom: (canvasId: string) => Promise<RemoteCanvasStore>;
  /** Where an UNADDRESSED turn routes (the bridge's default canvas id). */
  /** Null outside the `default` workspace: a turn there must name its canvas. */
  defaultCanvasId: string | null;
  /** Render the workspace's skill tree from its Records (ADR-0022, #361). Called FIRST, before
   *  anything else in the turn: the agent SDK discovers skills by SCANNING `workspace-skills/skills/`
   *  while `runChat` builds the turn's options, so unlike a Component — which vite requests
   *  lazily, and whose 404-then-retry the client already handles — there is no later moment
   *  at which a missing skill file can be fetched. Best-effort: a store failure costs this
   *  turn its workspace skills, never the turn. */
  materializeSkills: () => Promise<void>;
  /** The agent SDK turn (an async generator of ChatEvents). Injected so tests fake it. */
  runChat: typeof runChat;
  /** Tag each ChatEvent with its chatId and push it to every SSE subscriber. */
  broadcast: (chatId: string, ev: ChatEvent) => void;
  /** The moment the session's id is known (the turn's `init` event): seed the chat's resume
   *  pointer and bind the chat to its canvas, so both hold mid-turn rather than only at settle. */
  onSessionStart: (chatId: string, sessionId: string, canvasId?: string) => void;
  /** Persist the (possibly new/forked) resume pointer for this chat (ADR 0004). */
  stampSession: (chatId: string, sessionId: string) => void;
  /** ADR 0003 turn-completion persistence batch. */
  onTurnComplete: () => Promise<void>;
  /** Mirror this session's transcript to R2 (resume-restore substrate). Best-effort. */
  backupTranscript: (sessionId: string) => Promise<unknown>;
  /** #356: fetch THIS session's transcript onto the runner before resuming it. Boot downloads
   *  no transcripts any more, so a cold container has nothing on disk until this runs. NOT
   *  best-effort: a failure must abort the turn rather than resume with no history. Optional —
   *  absent in contexts with no store (tests). */
  materializeTranscript?: (sessionId: string) => Promise<unknown>;
  /** Cross-chat messaging seam (the bridge holds ChatMeta + the dispatcher): the agent's
   *  `send_message` tool posts into another chat card and kicks its turn. Optional — absent
   *  in contexts without a dispatcher (tests) ⇒ the tool is omitted. */
  sendToChat?: SendToChat;
  /** Asset-fetch seam (the bridge holds the edge origin + service secret): how `read_image`
   *  gets at pixels that live behind the edge's asset route since #290. Bound per canvas —
   *  the container's credential opens ANY canvas's assets, so the turn's canvas is what
   *  narrows it (#333 made the `src` guest-writable). Optional — absent in tests ⇒ only
   *  legacy inline data URLs are readable. */
  fetchAsset?: (canvasId: string) => FetchAsset;
}

/**
 * Run one turn and stream its events — awaitable so tests can assert the settle SEQUENCE (the
 * bug-prone part that was previously reachable only through a live SDK turn). Production uses the
 * fire-and-forget `runTurn` wrapper; the AbortController is registered synchronously (before the
 * first await) so a concurrent /send sees the in-flight turn.
 */
export async function runTurnAsync(input: TurnInput, deps: TurnDeps): Promise<void> {
  const { chatId, message, sessionId, images, model, forkSession, effort, canvasId, mcpTokens, mcpDisallowedTools, viewer, author } = input;
  const ac = new AbortController();
  deps.aborters.set(chatId, ac);
  let finalSessionId = sessionId;
  try {
    // Workspace skills are Records (ADR-0022, #361), and this is the moment their tree has to
    // exist: skill discovery is a filesystem scan the SDK performs as it builds the turn's
    // options, so "before the turn starts" is the only point that is both AFTER a possible
    // container recycle and BEFORE discovery runs.
    await deps.materializeSkills();
    // The request's active canvas (#79): the agent's reads, writes, tools, and screenshot
    // round-trip all use THIS store, so shapes land on the human's canvas and broadcast there.
    const activeCanvasId = canvasId ?? deps.defaultCanvasId;
    if (!activeCanvasId) throw new Error('this turn names no canvas, and this workspace has no default canvas');
    // #310: the agent draws into the ROOM. Opening REJECTS rather than degrading — a turn
    // that cannot reach the room has nowhere else to draw (#297 deleted the in-process
    // store), and reporting success over an unchanged canvas is the bug this closes.
    const store = await openTurnCanvasStore(() => deps.openCanvasRoom(activeCanvasId));
    // #356: the session this turn resumes is fetched HERE, one object, and only when there is a
    // session to resume. A throw lands in the catch below — resuming with no history would look
    // like an ordinary reply.
    if (sessionId) await deps.materializeTranscript?.(sessionId);
    for await (const ev of deps.runChat(
      store,
      message,
      sessionId,
      deps.requestScreenshot(activeCanvasId),
      images,
      chatId,
      model,
      forkSession,
      ac,
      effort,
      activeCanvasId,
      // #297: the cross-canvas shared-library rev-bump fanned over the in-memory session
      // registry, which nothing has read since #290. Without it, `write_component` on a
      // shared module bumps the agent's OWN canvas (agent.ts's `reloadAfterAuthor` fallback).
      undefined,
      mcpTokens,
      deps.sendToChat,
      mcpDisallowedTools,
      // Reading a pasted screenshot is scoped to the SAME canvas the store was opened on just above.
      deps.fetchAsset?.(activeCanvasId),
      // Moving a view needs to know WHOSE view. The viewer is bound HERE and nowhere lower, so
      // the tool below cannot be pointed at anyone but this turn's initiator. No viewer (guest
      // send, headless send) ⇒ no tool: the capability disappears rather than degrading into
      // "move everybody".
      viewer ? (pageId: string) => deps.selectPage(activeCanvasId)(pageId, viewer) : undefined,
      author ?? null,
    )) {
      if (ev.kind === 'done' && ev.sessionId) finalSessionId = ev.sessionId;
      if (ev.kind === 'init') {
        finalSessionId = ev.sessionId;
        // The EXPLICIT canvas (never the routing default) is the chat→canvas binding.
        deps.onSessionStart(chatId, ev.sessionId, canvasId);
      }
      deps.broadcast(chatId, ev satisfies ChatEvent);
    }
  } catch (e) {
    deps.broadcast(chatId, { kind: 'done', sessionId, costUsd: 0, error: (e as Error).message } satisfies ChatEvent);
  } finally {
    deps.aborters.delete(chatId);
    // ADR 0004: stamp the (possibly new/forked) sessionId so resume + rehydrate find the JSONL.
    if (finalSessionId && finalSessionId !== sessionId) deps.stampSession(chatId, finalSessionId);
    // ADR 0003: persist sessions/components/skills now that the turn settled.
    await deps.onTurnComplete();
    if (finalSessionId) await deps.backupTranscript(finalSessionId);
  }
}

/** Fire-and-forget entry point (production): the turn's output is the SSE stream, not a return
 *  value. The AbortController is set synchronously inside runTurnAsync before its first await. */
export function runTurn(input: TurnInput, deps: TurnDeps): void {
  void runTurnAsync(input, deps);
}
