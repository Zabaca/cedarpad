// The turn: one chat turn's lifecycle, made a module (extracted from bridge.ts's inline
// runChatTurn). A turn is the one thing in this system that sequences the others — it wakes the
// active canvas session, prepares the dev-agent worktree, drives the agent (runChat), streams
// its events, and on settle stamps the resume pointer, persists, indexes the Inbox Conversation,
// and backs up the transcript. Every collaborator it touches is already a module (canvas
// session, inbox transition, dev-agent prep, persist batch); this makes the SEQUENCE that calls
// them a module too, so the settle path is testable under fakes instead of only through a live
// SDK turn.
//
// bridge.ts composes the deps from its singletons; this file owns only the "when" (phase order),
// never the "what" (each collaborator). All imports are type-only — a turn is pure orchestration
// parameterized by injected functions.

import type { CanvasImage, ChatEvent, OpenPr, runChat } from './agent.ts';
import type { CanvasSession } from './canvas-sessions.ts';
import type { EndTurnDeps } from './inbox.ts';

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
}

/** The stable collaborators a turn sequences. bridge.ts binds each to its singleton; every one
 *  is already its own module, so this bag IS the turn's honest test surface. */
export interface TurnDeps {
  /** Live-turn registry, keyed by chatId — set at start, cleared at settle (drives /interrupt +
   *  the one-turn-per-chat 409 guard at the wire). */
  aborters: Map<string, AbortController>;
  /** The edge-minted token is the COMPLETE definition of a dev-agent turn: it decides the
   *  Inbox workspace tag + the skill allowlist (bridge.turnFlavor). */
  flavor: (token: string | undefined) => { workspaceId: string; skills: string[] };
  /** Resolve the request's active canvas session (#79) — the agent reads/draws on THAT store. */
  getSession: (canvasId: string) => Promise<CanvasSession>;
  /** Where an UNADDRESSED turn routes (the bridge's default canvas id). */
  defaultCanvasId: string;
  /** Prepare the dev-agent worktree + open_pr for this turn (undefined for a product turn). */
  prepareDevAgent: (
    token: string | undefined,
    chatId: string,
    sessionId: string | null,
  ) => Promise<{ openPr: OpenPr; cwd: string } | undefined>;
  /** The agent SDK turn (an async generator of ChatEvents). Injected so tests fake it. */
  runChat: typeof runChat;
  /** Fan a shared-library rev-bump out to every open canvas (#55). */
  bumpSharedModuleAcrossCanvases: (module: string) => number;
  /** Tag each ChatEvent with its chatId and push it to every SSE subscriber. */
  broadcast: (chatId: string, ev: ChatEvent) => void;
  /** The inbox context base for the end_turn tool — workspaceId + ownerRef are per-turn. */
  inbox: Omit<EndTurnDeps, 'getSessionId' | 'workspaceId' | 'ownerRef'>;
  /** Row-at-start (ADR-0011): index this session's Conversation the moment its id is known. The
   *  returned promise is AWAITED before the settle upsert, so the create-at-init and the
   *  settle-time find-or-create can never race into two rows for one chat (ownerRef has no
   *  unique index). Best-effort — never throws into the turn. */
  indexSession: (chatId: string, sessionId: string, message: string, workspaceId: string, canvasId?: string) => Promise<void>;
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
  }) => Promise<void>;
  /** Mirror this session's transcript to R2 (resume-restore substrate). Best-effort. */
  backupTranscript: (sessionId: string) => Promise<unknown>;
}

/**
 * Run one turn and stream its events — awaitable so tests can assert the settle SEQUENCE (the
 * bug-prone part that was previously reachable only through a live SDK turn). Production uses the
 * fire-and-forget `runTurn` wrapper; the AbortController is registered synchronously (before the
 * first await) so a concurrent /send sees the in-flight turn.
 */
export async function runTurnAsync(input: TurnInput, deps: TurnDeps): Promise<void> {
  const { chatId, message, sessionId, images, model, forkSession, effort, canvasId, devAgentGitToken } = input;
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
    const session = await deps.getSession(canvasId ?? deps.defaultCanvasId);
    const inbox = { ...deps.inbox, workspaceId: flavor.workspaceId, ownerRef: chatId };
    // A dev-agent send runs in its prepared worktree with open_pr armed; a prepare failure
    // (clone/auth) surfaces through the catch below as the turn's error — better a visible
    // failure than an agent silently editing the live app tree.
    const devAgent = await deps.prepareDevAgent(devAgentGitToken, chatId, sessionId);
    for await (const ev of deps.runChat(
      session.store,
      message,
      sessionId,
      session.requestScreenshot,
      images,
      chatId,
      model,
      forkSession,
      ac,
      effort,
      session.canvasId,
      deps.bumpSharedModuleAcrossCanvases,
      inbox,
      devAgent?.openPr,
      devAgent?.cwd,
      flavor.skills,
    )) {
      if (ev.kind === 'done' && ev.sessionId) finalSessionId = ev.sessionId;
      // Row-at-start: index the session the moment its id lands (the init event). Tracked (not
      // fire-and-forget) so the finally-block settle awaits it — the ordering IS the race fix.
      if (ev.kind === 'init') {
        finalSessionId = ev.sessionId;
        // The EXPLICIT canvas (never the routing default) is the chat→canvas edge claim.
        indexed = deps.indexSession(chatId, ev.sessionId, message, flavor.workspaceId, canvasId);
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
      await deps.settleConversation({ chatId, sessionId: finalSessionId, message, workspaceId: flavor.workspaceId, canvasId });
      await deps.backupTranscript(finalSessionId);
    }
  }
}

/** Fire-and-forget entry point (production): the turn's output is the SSE stream, not a return
 *  value. The AbortController is set synchronously inside runTurnAsync before its first await. */
export function runTurn(input: TurnInput, deps: TurnDeps): void {
  void runTurnAsync(input, deps);
}
