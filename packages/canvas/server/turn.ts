// The turn: one chat turn's lifecycle, made a module (extracted from bridge.ts's inline
// runChatTurn). A turn is the one thing in this system that sequences the others — it opens a
// store on the active canvas's room, prepares the dev-agent worktree, drives the agent
// (runChat), streams its events, and on settle stamps the resume pointer, persists, indexes the
// Inbox Conversation, and backs up the transcript. Every collaborator it touches is already a
// module (the room store, inbox transition, dev-agent prep, persist batch); this makes the
// SEQUENCE that calls them a module too, so the settle path is testable under fakes instead of
// only through a live SDK turn.
//
// bridge.ts composes the deps from its singletons; this file owns only the "when" (phase order),
// never the "what" (each collaborator). Imports are type-only but for one: opening the turn's
// room-backed canvas store (#310) is part of the phase order, not a collaborator that varies.

import type { CanvasImage, CaptureView, ChatEvent, ListMarts, OpenPr, SendToChat, runChat } from './agent.ts';
import type { FetchAsset } from '../src/canvas-ops.ts';
import type { EndTurnDeps } from './inbox.ts';
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
  /** The EXPLICITLY addressed canvas (the pad's x-canvas-id / ?canvas, or an edge-stamped
   * linked send). Absent ⇒ the turn routes to `deps.defaultCanvasId` but claims NO chat→canvas
   * edge for the Conversation — an inbox reply must never link a chat to the default canvas. */
  canvasId?: string;
  /** Edge-minted, per dev-agent send: arms open_pr + the worktree cwd for THIS turn only. */
  devAgentGitToken?: string;
  /** The repo this dev-agent turn operates on (ADR-0015: one run = one repo), from the
   * edge's x-dev-agent-repo header. Without it a token cannot arm open_pr (no target). */
  devAgentRepo?: string;
  /** ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens, decoded from the
   * proxied `x-mcp-tokens` header. Dropped below unless `flavor.kind === 'chat'` — dev-agent
   * turns get no external MCP servers no matter what rode the request. */
  mcpTokens?: Record<string, string>;
  /** The turn's HUMAN INITIATOR (shared inbox, CONTEXT.md), from the edge-stamped
   * x-inbox-assign header: assigns the Conversation at birth / claims-if-unassigned on a
   * reply. Absent on unattended (cron) kicks ⇒ the row stays in the unassigned queue. */
  assignTo?: string;
  /** Per-chat MCP tool opt-outs (`mcp__<server>__<tool>` names) from the chat's ChatMeta
   * selection — appended to the SDK disallowedTools for chat turns. Wholly-disabled servers
   * never appear here; their tokens were already dropped at the send. */
  mcpDisallowedTools?: string[];
}

/** The stable collaborators a turn sequences. bridge.ts binds each to its singleton; every one
 *  is already its own module, so this bag IS the turn's honest test surface. */
export interface TurnDeps {
  /** Live-turn registry, keyed by chatId — set at start, cleared at settle (drives /interrupt +
   *  the one-turn-per-chat 409 guard at the wire). */
  aborters: Map<string, AbortController>;
  /** The edge-minted token is the COMPLETE definition of a dev-agent turn: it decides the
   *  Inbox workspace tag + the skill policy (bridge.turnFlavor; skills absent = all discovered). */
  flavor: (token: string | undefined) => { workspaceId: string; kind: 'chat' | 'dev-agent'; skills?: string[] };
  /** The active canvas's screenshot round-trip (`view_canvas`) — the one rider left on the
   *  bridge's SSE stream after #297 (server/screenshot-channel.ts). */
  requestScreenshot: (canvasId: string) => CaptureView;
  /** Open a store on the canvas's Durable-Object-hosted ROOM (ADR-0019, #310). Since #297
   *  there is no in-process store to fall back to: this is where canvas state lives. */
  openCanvasRoom: (canvasId: string) => Promise<RemoteCanvasStore>;
  /** Where an UNADDRESSED turn routes (the bridge's default canvas id). */
  defaultCanvasId: string;
  /** Prepare the dev-agent worktree + open_pr for this turn (undefined for a product turn). */
  prepareDevAgent: (
    token: string | undefined,
    repo: string | undefined,
    chatId: string,
    sessionId: string | null,
  ) => Promise<{ openPr: OpenPr; cwd: string } | undefined>;
  /** The agent SDK turn (an async generator of ChatEvents). Injected so tests fake it. */
  runChat: typeof runChat;
  /** Tag each ChatEvent with its chatId and push it to every SSE subscriber. */
  broadcast: (chatId: string, ev: ChatEvent) => void;
  /** The inbox context base for the end_turn tool — workspaceId + ownerRef are per-turn. */
  inbox: Omit<EndTurnDeps, 'getSessionId' | 'workspaceId' | 'ownerRef'>;
  /** Row-at-start (ADR-0011): index this session's Conversation the moment its id is known. The
   *  returned promise is AWAITED before the settle upsert, so the create-at-init and the
   *  settle-time find-or-create can never race into two rows for one chat (ownerRef has no
   *  unique index). Best-effort — never throws into the turn. */
  indexSession: (chatId: string, sessionId: string, message: string, workspaceId: string, canvasId?: string, kind?: 'chat' | 'dev-agent', repo?: string, assignTo?: string) => Promise<void>;
  /** Persist the (possibly new/forked) resume pointer for this chat (ADR 0004). */
  stampSession: (chatId: string, sessionId: string) => void;
  /** ADR 0003 turn-completion persistence batch. */
  onTurnComplete: () => Promise<void>;
  /** Settle-time Conversation upsert: touch/rebind by chat + mark activity so the session shows
   *  in "All" even when the end_turn gate was bypassed. Runs AFTER indexSession settles. */
  settleConversation: (input: {
    chatId: string;
    sessionId: string;
    message: string;
    workspaceId: string;
    canvasId?: string;
    kind?: 'chat' | 'dev-agent';
    repo?: string;
  }) => Promise<void>;
  /** Mirror this session's transcript to R2 (resume-restore substrate). Best-effort. */
  backupTranscript: (sessionId: string) => Promise<unknown>;
  /** Cross-chat messaging seam (the bridge holds ChatMeta + the dispatcher): the agent's
   *  `send_message` tool posts into another chat card and kicks its turn. Optional — absent
   *  in contexts without a dispatcher (tests) ⇒ the tool is omitted. */
  sendToChat?: SendToChat;
  /** Mart discovery seam (the bridge holds the workspace's BlobStore): the agent's
   *  `list_marts` tool. Optional — absent in tests ⇒ the tool is omitted. */
  listMarts?: ListMarts;
  /** Asset-fetch seam (the bridge holds the edge origin + service secret): how `read_image`
   *  gets at pixels that live behind the edge's asset route since #290. Optional — absent in
   *  tests ⇒ only legacy inline data URLs are readable. */
  fetchAsset?: FetchAsset;
}

/**
 * Run one turn and stream its events — awaitable so tests can assert the settle SEQUENCE (the
 * bug-prone part that was previously reachable only through a live SDK turn). Production uses the
 * fire-and-forget `runTurn` wrapper; the AbortController is registered synchronously (before the
 * first await) so a concurrent /send sees the in-flight turn.
 */
export async function runTurnAsync(input: TurnInput, deps: TurnDeps): Promise<void> {
  const { chatId, message, sessionId, images, model, forkSession, effort, canvasId, devAgentGitToken, devAgentRepo, mcpTokens, assignTo, mcpDisallowedTools } = input;
  const ac = new AbortController();
  deps.aborters.set(chatId, ac);
  const flavor = deps.flavor(devAgentGitToken);
  let finalSessionId = sessionId;
  // Held so the settle upsert can await it — the create-at-init and the settle-time upsert both
  // go through find-or-create-by-chat, so awaiting here is what stops them racing into two rows.
  let indexed: Promise<void> = Promise.resolve();
  try {
    // The request's active canvas (#79): the agent's reads, writes, tools, and screenshot
    // round-trip all use THIS store, so shapes land on the human's canvas and broadcast there.
    const activeCanvasId = canvasId ?? deps.defaultCanvasId;
    // #310: the agent draws into the ROOM. Opening REJECTS rather than degrading — a turn
    // that cannot reach the room has nowhere else to draw (#297 deleted the in-process
    // store), and reporting success over an unchanged canvas is the bug this closes.
    const store = await openTurnCanvasStore(() => deps.openCanvasRoom(activeCanvasId));
    const inbox = { ...deps.inbox, workspaceId: flavor.workspaceId, kind: flavor.kind, ownerRef: chatId };
    // A dev-agent send runs in its prepared worktree with open_pr armed; a prepare failure
    // (clone/auth) surfaces through the catch below as the turn's error — better a visible
    // failure than an agent silently editing the live app tree.
    const devAgent = await deps.prepareDevAgent(devAgentGitToken, devAgentRepo, chatId, sessionId);
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
      inbox,
      devAgent?.openPr,
      devAgent?.cwd,
      flavor.skills,
      // Chat flavor only (ADR-0013 train 2): a dev-agent turn is `flavor.kind === 'dev-agent'`
      // (the edge-minted git token decides that), so it never sees mcpTokens even if a stray
      // header somehow rode the request.
      flavor.kind === 'chat' ? mcpTokens : undefined,
      // Chat turns drop the generic Write/Edit tools (component/data authoring goes through
      // the registered canvas tools); dev-agent turns keep the full preset for worktree edits.
      flavor.kind,
      // Cross-chat messaging is a CANVAS capability — chat turns only (a dev-agent turn has no
      // chat cards to address).
      flavor.kind === 'chat' ? deps.sendToChat : undefined,
      // Per-chat MCP tool opt-outs — meaningful for chat turns only (dev-agent has no MCP).
      flavor.kind === 'chat' ? mcpDisallowedTools : undefined,
      // Mart discovery is a CANVAS capability — chat turns only (a dev-agent turn places no
      // components, so it has nothing to point at a mart).
      flavor.kind === 'chat' ? deps.listMarts : undefined,
      // Reading a pasted screenshot is a CANVAS capability — chat turns only.
      flavor.kind === 'chat' ? deps.fetchAsset : undefined,
    )) {
      if (ev.kind === 'done' && ev.sessionId) finalSessionId = ev.sessionId;
      // Row-at-start: index the session the moment its id lands (the init event). Tracked (not
      // fire-and-forget) so the finally-block settle awaits it — the ordering IS the race fix.
      if (ev.kind === 'init') {
        finalSessionId = ev.sessionId;
        // The EXPLICIT canvas (never the routing default) is the chat→canvas edge claim.
        indexed = deps.indexSession(chatId, ev.sessionId, message, flavor.workspaceId, canvasId, flavor.kind, devAgentRepo, assignTo);
      }
      deps.broadcast(chatId, ev satisfies ChatEvent);
    }
  } catch (e) {
    deps.broadcast(chatId, { kind: 'done', sessionId, costUsd: 0, error: (e as Error).message } satisfies ChatEvent);
  } finally {
    deps.aborters.delete(chatId);
    // ADR 0004: stamp the (possibly new/forked) sessionId so resume + rehydrate find the JSONL.
    if (finalSessionId && finalSessionId !== sessionId) deps.stampSession(chatId, finalSessionId);
    // ADR 0003: persist sessions/components/custom now that the turn settled.
    await deps.onTurnComplete();
    if (finalSessionId) {
      // The race fix: let the row-at-start create settle before the settle-time upsert reads
      // it, so find-or-create-by-chat finds the one row instead of inserting a second.
      await indexed.catch(() => {});
      await deps.settleConversation({ chatId, sessionId: finalSessionId, message, workspaceId: flavor.workspaceId, canvasId, kind: flavor.kind, repo: devAgentRepo });
      await deps.backupTranscript(finalSessionId);
    }
  }
}

/** Fire-and-forget entry point (production): the turn's output is the SSE stream, not a return
 *  value. The AbortController is set synchronously inside runTurnAsync before its first await. */
export function runTurn(input: TurnInput, deps: TurnDeps): void {
  void runTurnAsync(input, deps);
}
