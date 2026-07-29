// The /api/chat/:id/send subscribe-before-send wire contract (425 Too Early).
//
// Importing bridge.ts does NOT bind a port (Bun.serve is guarded behind
// `import.meta.main`), so we drive the exported `handleRequest` directly with a
// Request and assert the response. `setChatTurnDispatcher` swaps in a spy so the
// 2xx path never invokes the real agent SDK and we can assert dispatch happened (or,
// on the 425 path, did NOT). `chatHub` owns the shared subscriber set the guard
// consults — one connected stream carries every chat, so a single fake controller
// represents "a subscriber exists".

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';

import { type CanvasImage, parseCanvasImages, runChat } from './agent.ts';
import { chatHub, handleRequest, indexSessionStart, prepareDevAgentTurn, setCanvasRoomOpener, setChatTurnDispatcher, turnFlavor } from './bridge.ts';
import { createStore } from '../src/store.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';

// #305: canvas writes go to the canvas's Durable-Object-hosted room, so a test that drives
// a canvas route needs a room to drive it against. This is an in-memory stand-in for one —
// per-canvas, persisting for the file's lifetime, exactly as the real room does per canvas.
const fakeRooms = new Map<string, RemoteCanvasStore>();
setCanvasRoomOpener(async (canvasId) => {
  let store = fakeRooms.get(canvasId);
  if (!store) {
    const inner = createStore([]);
    store = { ...inner, flush: async () => {} };
    fakeRooms.set(canvasId, store);
  }
  return store;
});
import type { PlatformRpc } from './platform-rpc-client.ts';
import type { ConversationStartInput } from '../shared/platform-rpc.ts';
import { DEV_AGENT_KIND } from './dev-agent-workflow.ts';
import { INBOX_CONVERSATION_HEADER } from '../shared/bridge-wire.ts';
import { branchName, createRepoWorktreeManager } from './repo-worktree.ts';

const sendReq = (chatId: string, body: unknown = { message: 'hi' }): Request =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('/api/chat/:id/send: subscribe-before-send (425)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; message: string; images: CanvasImage[] }> = [];

  beforeEach(() => {
    chatHub.resetForTests(); // no subscribers by default
    dispatched = [];
    restore = setChatTurnDispatcher((chatId, message, _sessionId, images) => {
      dispatched.push({ chatId, message, images });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('no subscriber → 425 Too Early with {error,chatId}, and no turn is dispatched', async () => {
    const res = await handleRequest(sendReq('chat_no_sub'));

    expect(res.status).toBe(425);
    expect(await res.json()).toEqual({ error: 'no_subscribers', chatId: 'chat_no_sub' });
    expect(dispatched).toEqual([]); // dispatched nothing
  });

  test('425 fires before the body is even inspected (an otherwise-valid send is still rejected)', async () => {
    const res = await handleRequest(sendReq('chat_valid_body', { message: 'a real, non-empty message' }));

    expect(res.status).toBe(425);
    expect(dispatched).toEqual([]);
  });

  test('x-headless-send bypasses the guard: no subscriber, still 202 and dispatched (#177 MCP sends)', async () => {
    const req = new Request('http://localhost/api/chat/mcp_headless/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-headless-send': '1' },
      body: JSON.stringify({ message: 'from mcp' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'mcp_headless', message: 'from mcp', images: [] }]);
  });

  test('with an active subscription → 202 Accepted and the turn IS dispatched', async () => {
    const sub = fakeSubscriber();
    chatHub.subscribe(sub);

    const res = await handleRequest(sendReq('chat_subbed', { message: 'go' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatched).toEqual([{ chatId: 'chat_subbed', message: 'go', images: [] }]);
  });

  test('pasted images ride the send through to the dispatch (same contract a reply reuses)', async () => {
    chatHub.subscribe(fakeSubscriber());
    const images = [{ media_type: 'image/png', data: 'AAAA' }];

    const res = await handleRequest(sendReq('chat_img', { message: 'see this', images }));

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_img', message: 'see this', images }]);
  });
});

// The per-conversation open_pr gate (ADR-0010): "dev-agent-ness" is a property of the
// Conversation, not the container. The edge mints a short-lived repo-scoped token per
// dev-agent send and attaches it as a request header; the bridge threads it into the turn
// so ONLY that turn gets the open_pr tool. No header ⇒ no token ⇒ no open_pr — the exact
// per-container IS_DEV_AGENT_BRIDGE gate this replaces.
describe('/api/chat/:id/send: the x-dev-agent-git-token header reaches the dispatched turn', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; devAgentGitToken?: string; devAgentRepo?: string }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, devAgentGitToken, _mcpTokens, devAgentRepo) => {
      dispatched.push({ chatId, devAgentGitToken, devAgentRepo });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a send WITH the header dispatches the turn carrying the token', async () => {
    const req = new Request('http://localhost/api/chat/chat_da/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dev-agent-git-token': 'ghs_minted', 'x-dev-agent-repo': 'Zabaca/ledgerbot' },
      body: JSON.stringify({ message: 'grill me' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    // The repo rides beside the token (ADR-0015): the turn worktrees + PRs against exactly it.
    expect(dispatched).toEqual([{ chatId: 'chat_da', devAgentGitToken: 'ghs_minted', devAgentRepo: 'Zabaca/ledgerbot' }]);
  });

  test('a send WITHOUT the header dispatches with undefined (product sends never see a token)', async () => {
    const res = await handleRequest(sendReq('chat_plain'));

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_plain', devAgentGitToken: undefined, devAgentRepo: undefined }]);
  });
});

// Shared-inbox assignment (CONTEXT.md): the edge stamps the human initiator on a send as
// x-inbox-assign; the bridge threads it into the turn so the Conversation is assigned at
// birth / claimed-if-unassigned on a reply. No header (a cron kick) ⇒ undefined ⇒ unassigned.
describe('/api/chat/:id/send: the x-inbox-assign header reaches the dispatched turn', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; assignTo?: string }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, _tok, _mcp, _repo, assignTo) => {
      dispatched.push({ chatId, assignTo });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a send WITH the header dispatches the turn carrying its initiator', async () => {
    const req = new Request('http://localhost/api/chat/chat_as/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-inbox-assign': 'user_james' },
      body: JSON.stringify({ message: 'hi' }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_as', assignTo: 'user_james' }]);
  });

  test('a send WITHOUT the header dispatches with undefined (unattended starts stay unassigned)', async () => {
    const res = await handleRequest(sendReq('chat_noassign'));
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_noassign', assignTo: undefined }]);
  });

  test('a dev-agent /run kick forwards its initiator too (manual trigger = a human act)', async () => {
    const req = new Request('http://localhost/api/dev-agent/run', {
      method: 'POST',
      headers: { 'x-inbox-assign': 'user_james', 'content-type': 'application/json' },
      body: JSON.stringify({ job: { name: 'deps-audit', prompt: 'Audit the dependencies.' } }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(202);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.assignTo).toBe('user_james');
  });
});

// ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens ride the send as the
// x-mcp-tokens header (server/mcp-registry.ts's shared contract); the bridge decodes it and
// hands it to the dispatched turn. `server/turn.ts` is what drops this for a dev-agent turn
// (pinned in server/turn.test.ts) — here we only pin the header → decode → dispatch wiring.
describe('/api/chat/:id/send: the x-mcp-tokens header reaches the dispatched turn (decoded)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; mcpTokens?: Record<string, string>; mcpDisallowed?: string[] }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, _devAgentGitToken, mcpTokens, _repo, _assign, mcpDisallowed) => {
      dispatched.push({ chatId, mcpTokens, ...(mcpDisallowed && mcpDisallowed.length > 0 ? { mcpDisallowed } : {}) });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a send WITH the header dispatches the turn carrying the decoded tokens', async () => {
    const req = new Request('http://localhost/api/chat/chat_mcp/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-tokens': JSON.stringify({ ledgerbot: 'tok_a' }) },
      body: JSON.stringify({ message: 'ping ledgerbot' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_mcp', mcpTokens: { ledgerbot: 'tok_a' } }]);
  });

  test('a send WITHOUT the header dispatches with an empty object (no tokens connected)', async () => {
    const res = await handleRequest(sendReq('chat_plain_mcp'));

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_plain_mcp', mcpTokens: {} }]);
  });

  test('a malformed header decodes to empty — never fails the send', async () => {
    const req = new Request('http://localhost/api/chat/chat_bad_mcp/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-tokens': 'not json' },
      body: JSON.stringify({ message: 'hi' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_bad_mcp', mcpTokens: {} }]);
  });

  test('the chat’s stored MCP selection opts out: disabled servers dropped at the send, disabled tools ride as disallowed names', async () => {
    const cfg = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: { disabledServers: ['ledgerbot'], disabledTools: { fredrin: ['deploy'] } } }),
      }),
    );
    expect(cfg.status).toBe(200);

    const res = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcp-tokens': JSON.stringify({ ledgerbot: 'tok_a', fredrin: 'tok_f' }) },
        body: JSON.stringify({ message: 'go' }),
      }),
    );
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_sel', mcpTokens: { fredrin: 'tok_f' }, mcpDisallowed: ['mcp__fredrin__deploy'] }]);
  });

  test('a garbage MCP selection on /config is a 400 — nothing stored', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel2/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: { disabledServers: 'ledgerbot' } }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ADR-0011 / 6a: the token header is the COMPLETE definition of a dev-agent turn — it also
// drives the workspace tag (so the row + ask_human file under 'dev-agent', which is what the
// edge's routing and per-send token mint key on) and the skill policy (ADR-0013).
describe('turnFlavor: the token decides the turn’s Conversation kind + skill policy', () => {
  test('a token-armed turn is dev-agent KIND — pinned skills, exactly the curated three (ADR-0013: a workspace skill must never ride a name into a token-bearing turn)', () => {
    const f = turnFlavor('ghs_minted');
    expect(f.kind).toBe(DEV_AGENT_KIND);
    expect(f.workspaceId).toBe('default'); // the workspace it RUNS in — dev-agent is a type, not a workspace
    expect(f.skills).toEqual(['impeccable', 'tdd', 'improve-codebase-architecture']);
  });

  test('a product turn is chat kind with NO skill allowlist — all discovered skills enabled (ADR-0013)', () => {
    const f = turnFlavor(undefined);
    expect(f.kind).toBe('chat');
    expect(f.workspaceId).toBe('default');
    expect(f.skills).toBeUndefined();
  });
});

describe('prepareDevAgentTurn: the per-conversation open_pr gate + prepared-worktree cwd (ADR-0010 slice 6)', () => {
  test('no token ⇒ undefined — the turn gets NO open_pr tool and keeps the default cwd', async () => {
    expect(await prepareDevAgentTurn(undefined, 'Zabaca/cedarpad', 'chat_1', 'sess_1')).toBeUndefined();
  });

  test('a token WITHOUT a repo ⇒ undefined — a token cannot arm open_pr with no target (ADR-0015)', async () => {
    expect(await prepareDevAgentTurn('ghs_minted', undefined, 'chat_1', 'sess_1')).toBeUndefined();
  });

  test('a token ⇒ the per-chat worktree is ensured, the session JSONL adopted to it, and cwd = the worktree', async () => {
    const ensured: string[] = [];
    const adopted: Array<{ sessionId: string; cwd: string }> = [];
    const worktree = { path: '/wt/dev-agent-chat-1', branch: branchName(DEV_AGENT_KIND, 'chat_1'), hub: '/wt/hub' };
    const configs: Array<{ repo: string; workspaceRoot: string }> = [];
    const fakeManager = ((config: { repo: string; workspaceRoot: string }) => {
      configs.push({ repo: config.repo, workspaceRoot: config.workspaceRoot });
      return {
        ensureWorktree: async (branch: string) => {
          ensured.push(branch);
          return worktree;
        },
      };
    }) as unknown as typeof createRepoWorktreeManager;

    const turn = await prepareDevAgentTurn('ghs_minted', 'Zabaca/cedarpad', 'chat_1', 'sess_1', {
      manager: fakeManager,
      adopt: async (_dir, sessionId, cwd) => {
        adopted.push({ sessionId, cwd });
        return null;
      },
    });

    // The worktree is keyed by the dev-agent tag + chatId — deterministic per conversation,
    // so every turn of one grill flow lands in the same tree.
    expect(ensured).toEqual([branchName(DEV_AGENT_KIND, 'chat_1')]);
    // The manager targets the TURN'S repo (ADR-0015), with a per-repo hub dir so multi-repo
    // workspaces' clones never collide.
    expect(configs[0]?.repo).toBe('Zabaca/cedarpad');
    expect(configs[0]?.workspaceRoot.endsWith('/.dev-agent/Zabaca__cedarpad')).toBe(true);
    // The SDK resume is cwd-scoped (#133): the session JSONL must move to the worktree's dir.
    expect(adopted).toEqual([{ sessionId: 'sess_1', cwd: worktree.path }]);
    // The SDK turn runs IN the worktree — edits land there, never in the live app tree.
    expect(turn!.cwd).toBe(worktree.path);
    expect(typeof turn!.openPr).toBe('function');
  });

  test('a fresh session (null) adopts nothing — there is no JSONL yet', async () => {
    const adopted: string[] = [];
    const fakeManager = (() => ({
      ensureWorktree: async (branch: string) => ({ path: '/wt/x', branch, hub: '/wt/hub' }),
    })) as unknown as typeof createRepoWorktreeManager;

    const turn = await prepareDevAgentTurn('ghs_minted', 'Zabaca/cedarpad', 'chat_2', null, {
      manager: fakeManager,
      adopt: async (_dir, sessionId) => {
        adopted.push(sessionId);
        return null;
      },
    });

    expect(adopted).toEqual([]);
    expect(turn!.cwd).toBe('/wt/x');
  });

  // CONTEXT.md "Open PR": the tool's url is the run's durable artifact. Reporting it edge-ward
  // is what gives the Conversation its PR state — and therefore the Inbox its Merge action.
  test('a successful open_pr reports the PR edge-ward, naming the chat (never the row)', async () => {
    const reported: Array<{ ownerRef?: string; prUrl: string; kind?: string; repo?: string }> = [];
    const fakeManager = (() => ({
      ensureWorktree: async (branch: string) => ({ path: '/wt/pr', branch, hub: '/wt/hub' }),
      commit: async () => true,
      pushAndOpenPR: async () => 'https://github.com/Zabaca/cedarpad/pull/283',
    })) as unknown as typeof createRepoWorktreeManager;

    const turn = await prepareDevAgentTurn('ghs_minted', 'Zabaca/cedarpad', 'chat_pr', 'sess_pr', {
      manager: fakeManager,
      adopt: async () => null,
      rpc: { conversationPrOpened: async (input: (typeof reported)[number]) => void reported.push(input) } as never,
    });
    const said = await turn!.openPr({ title: 't', body: 'b', commitMessage: 'c' });

    expect(said).toContain('https://github.com/Zabaca/cedarpad/pull/283');
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      ownerRef: 'chat_pr',
      prUrl: 'https://github.com/Zabaca/cedarpad/pull/283',
      kind: DEV_AGENT_KIND,
      repo: 'Zabaca/cedarpad',
    });
  });

  test('a clean worktree opens no PR, so nothing is reported', async () => {
    const reported: unknown[] = [];
    const fakeManager = (() => ({
      ensureWorktree: async (branch: string) => ({ path: '/wt/clean', branch, hub: '/wt/hub' }),
      commit: async () => false,
      pushAndOpenPR: async () => 'https://github.com/Zabaca/cedarpad/pull/999',
    })) as unknown as typeof createRepoWorktreeManager;

    const turn = await prepareDevAgentTurn('ghs_minted', 'Zabaca/cedarpad', 'chat_clean', null, {
      manager: fakeManager,
      adopt: async () => null,
      rpc: { conversationPrOpened: async (i: unknown) => void reported.push(i) } as never,
    });
    await turn!.openPr({ title: 't', body: 'b', commitMessage: 'c' });

    expect(reported).toEqual([]);
  });
});

// ADR-0011: one turn per chat, enforced at the wire. The client queue only protects the tab
// that started the turn; a headless dev-agent run (or another tab) needs the server to say no.
describe('/api/chat/:id/send: 409 turn_in_flight while the chat’s turn runs', () => {
  let restore: () => void = () => {};
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId) => {
      dispatched.push(chatId);
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
    chatHub.aborters.delete('chat_busy');
    chatHub.aborters.delete('chat_running');
  });

  test('a send while a turn is in flight → 409 {turn_in_flight}, nothing dispatched', async () => {
    chatHub.aborters.set('chat_busy', new AbortController()); // a live turn holds the chat

    const res = await handleRequest(sendReq('chat_busy'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'turn_in_flight', chatId: 'chat_busy' });
    expect(dispatched).toEqual([]);
  });

  test('the transcript GET reports in-flight state, so a mid-run opener rehydrates busy', async () => {
    chatHub.aborters.set('chat_running', new AbortController());

    const running = await handleRequest(new Request('http://localhost/api/chat/chat_running/transcript'));
    const idle = await handleRequest(new Request('http://localhost/api/chat/chat_idle/transcript'));

    expect(((await running.json()) as { busy?: boolean }).busy).toBe(true);
    expect(((await idle.json()) as { busy?: boolean }).busy).toBe(false);
  });
});

// ADR-0011: the dev-agent run IS a chat turn, kicked headlessly by the edge (Jobs / cron).
// Deliberately NOT behind the 425 subscribe-before-send guard (no subscriber exists by
// design — the Inbox attaches mid-stream later), single-flighted with JOIN semantics.
describe('POST /api/dev-agent/run — a headless dev-agent chat turn', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; message: string; sessionId: string | null; model?: string; devAgentGitToken?: string; devAgentRepo?: string }> = [];
  const kicked: string[] = [];

  // Every kick carries a repo-defined job (#100): the bridge has no built-in task.
  const JOB = { name: 'improve-codebase-architecture', prompt: 'Architecture explore: survey this repo for deepening opportunities.' };

  const kick = async (token = 'ghs_run') => {
    const res = await handleRequest(
      new Request('http://localhost/api/dev-agent/run', {
        method: 'POST',
        headers: { 'x-dev-agent-git-token': token, 'x-dev-agent-repo': 'Zabaca/cedarpad', 'content-type': 'application/json' },
        body: JSON.stringify({ job: JOB }),
      }),
    );
    const body = (await res.json()) as { chatId: string; joined: boolean };
    kicked.push(body.chatId);
    return { status: res.status, body };
  };

  beforeEach(() => {
    dispatched = [];
    // NO chat subscriber — the kick is headless by design.
    chatHub.resetForTests();
    restore = setChatTurnDispatcher((chatId, message, sessionId, _images, model, _fork, _effort, _canvasId, devAgentGitToken, _mcpTokens, devAgentRepo) => {
      dispatched.push({ chatId, message, sessionId, model, devAgentGitToken, devAgentRepo });
    });
  });

  afterEach(() => {
    restore();
    for (const id of kicked) chatHub.aborters.delete(id);
    kicked.length = 0;
  });

  test('kicks a fresh turn: 202, no subscriber needed, token forwarded, prompt titled first', async () => {
    const { status, body } = await kick();

    expect(status).toBe(202);
    expect(body.joined).toBe(false);
    expect(body.chatId).toMatch(/^dev-agent-run-/);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.chatId).toBe(body.chatId);
    expect(dispatched[0]!.sessionId).toBeNull(); // every run is a fresh session
    // First sentence = the Conversation row's title (row-at-start slices the message): the
    // JOB's body leads (#100 — the task is always a job's).
    expect(dispatched[0]!.message.startsWith(JOB.prompt)).toBe(true);
    // The prompt carries the workflow the harness used to enforce in code (ADR-0011 2a).
    expect(dispatched[0]!.message).toContain('docs/adr/declined/');
    expect(dispatched[0]!.message).toContain('end_turn');
    expect(dispatched[0]!.devAgentGitToken).toBe('ghs_run');
    // The edge-stamped repo header binds the run to its target (ADR-0015: one run = one repo).
    expect(dispatched[0]!.devAgentRepo).toBe('Zabaca/cedarpad');
  });

  // Issue #184: the run turn judges (triage + implementation), so it's pinned to Opus;
  // exploration fans out to Sonnet `explorer` subagents (repo .claude/agents, PR-reviewed).
  test('the run turn is pinned to opus (#184 §4)', async () => {
    await kick();
    expect(dispatched[0]!.model).toBe('opus');
  });

  // Issue #184 §1–§3: the prompt IS the policy (prompt-law, no harness). Pin the
  // load-bearing sentences so a prompt edit that drops one is a visible test change.
  test('the prompt carries the execute/grill/drop triage law (#184)', async () => {
    await kick();
    const p = dispatched[0]!.message;
    expect(p).toContain('EXECUTE');
    expect(p).toContain('GRILL');
    expect(p).toContain('DROP');
    // The anti-manufacture guard — the single most load-bearing sentence.
    expect(p).toContain('Executing zero is a fully successful run');
    expect(p).toContain('no schema, auth, deploy, or public-contract changes');
    // Decline markers: the human-decline dedup loop.
    expect(p).toContain('docs/adr/declined/');
    // Decision record in the closing end_turn.
    expect(p).toContain('decision record');
  });

  // ADR-0015 (#195): a repo-defined job is PR-gated content; its body becomes the run's TASK,
  // wrapped by the platform's non-negotiable triage law. A job can steer WHAT, never the rules.
  test('a job-carrying kick runs the job body inside the platform wrapper', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/dev-agent/run', {
        method: 'POST',
        headers: {
          'x-dev-agent-git-token': 'ghs_run',
          'x-dev-agent-repo': 'Zabaca/cedarpad',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ job: { name: 'deps-audit', prompt: 'Audit the dependencies. Report stale ones.' } }),
      }),
    );
    const body = (await res.json()) as { chatId: string };
    kicked.push(body.chatId);

    const p = dispatched[0]!.message;
    // The job body LEADS (its first sentence titles the Conversation row)…
    expect(p.startsWith('Audit the dependencies.')).toBe(true);
    // …and the platform wrapper is still around it — not opt-out-able.
    expect(p).toContain('Executing zero is a fully successful run');
    expect(p).toContain('end_turn');
    // Nothing but the job supplies the task — no built-in explore text (#100).
    expect(p).not.toContain('Architecture explore:');
  });

  // #100: one mechanism. A jobless kick used to fall back to a built-in prompt; it is now a
  // 400 that names where a job comes from, and nothing is dispatched.
  test('a jobless kick is a 400 naming .claude/jobs/ — no run dispatched', async () => {
    for (const init of [
      { method: 'POST', headers: { 'x-dev-agent-repo': 'Zabaca/cedarpad' } },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job: { name: 'blank', prompt: '   ' } }),
      },
    ] as RequestInit[]) {
      const res = await handleRequest(new Request('http://localhost/api/dev-agent/run', init));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('.claude/jobs/');
    }
    expect(dispatched).toEqual([]);
  });

  test('join semantics: a kick during a running run returns THAT run, dispatching nothing new', async () => {
    const first = await kick();
    chatHub.aborters.set(first.body.chatId, new AbortController()); // the spy doesn't run a real turn — simulate in-flight

    const second = await kick();

    expect(second.status).toBe(202);
    expect(second.body).toEqual({ chatId: first.body.chatId, joined: true });
    expect(dispatched).toHaveLength(1); // no pile-up
  });

  test('after the run settles, the next kick starts a fresh run', async () => {
    const first = await kick();
    // No aborter registered ⇒ the run has settled.
    const second = await kick();

    expect(second.body.joined).toBe(false);
    expect(second.body.chatId).not.toBe(first.body.chatId);
    expect(dispatched).toHaveLength(2);
  });
});

// ADR-0011 row-at-start: a session enters the Inbox index the moment the SDK assigns its id
// (the init event), not when the first turn settles — that's what makes a headless dev-agent
// run (and any long first turn) visible live in the "All" view.
//
// ADR-0018 / #266: the bridge has NO platform-data-layer client, so what it can be asserted to
// do is exactly what it asks the edge for. The row semantics behind `conversation.start`
// (idempotence, re-pointing the session, the canvas edge) are the edge's, and are asserted
// against a real database in worker/platform-rpc.test.ts and web-poc's find-or-create tests.
describe('indexSessionStart: a session enters the index when it starts (ADR-0011)', () => {
  const recordingRpc = () => {
    const started: ConversationStartInput[] = [];
    const rpc: PlatformRpc = {
      conversationStart: async (input) => void started.push(input),
      conversationSettle: async () => {},
      conversationPrOpened: async () => {},
      turnEnd: async () => null,
      notify: async () => {},
      componentWrite: async () => ({ rev: 1 }),
      componentRead: async () => null,
    };
    return { rpc, started };
  };

  test('files the session over the platform RPC at init — titled from the message', async () => {
    const { rpc, started } = recordingRpc();
    const sessionId = `sess_start_${crypto.randomUUID()}`;

    await indexSessionStart('chat_start', sessionId, 'Architecture explore: survey this repo for deepening opportunities. (long instructions follow)', undefined, undefined, undefined, undefined, undefined, { rpc });

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ sessionId, ownerRef: 'chat_start' });
    expect(started[0]!.summary).toContain('Architecture explore');
  });

  test('records the chat→canvas edge when the turn carries one, and claims nothing when it does not', async () => {
    const { rpc, started } = recordingRpc();

    await indexSessionStart('chat_cv', 'sess_cv', 'born on a canvas', undefined, 'cv_9', undefined, undefined, undefined, { rpc });
    await indexSessionStart('chat_nocv', 'sess_nocv', 'born in the inbox', undefined, undefined, undefined, undefined, undefined, { rpc });

    expect(started.map((s) => s.canvasId)).toEqual(['cv_9', undefined]);
  });

  // The best-effort contract (ADR-0018): "an index failure never fails the turn" must survive
  // the hop exactly as it survived a failed platform-data-layer write.
  test('an unreachable edge is logged and the turn continues', async () => {
    const logged: unknown[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await indexSessionStart('chat_down', `sess_down_${crypto.randomUUID()}`, 'edge is down', undefined, undefined, undefined, undefined, undefined, {
        rpc: {
          conversationStart: async () => {
            throw new Error('connect ECONNREFUSED');
          },
          conversationSettle: async () => {},
        conversationPrOpened: async () => {},
          turnEnd: async () => null,
          notify: async () => {},
          componentWrite: async () => ({ rev: 1 }),
          componentRead: async () => null,
        },
      });
    } finally {
      console.error = realError;
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0])).toContain('session-start');
  });

  // With no edge in front of it the bridge is DEGRADED, not locally-backed: #266 removed the
  // fallback client, so the index is simply skipped — never a throw into the turn.
  test('with no platform RPC at all, indexing is skipped rather than failing the turn', async () => {
    await expect(
      indexSessionStart('chat_no_edge', 'sess_no_edge', 'no edge', undefined, undefined, undefined, undefined, undefined, { rpc: null }),
    ).resolves.toBeUndefined();
  });
});

describe('reply/send share ONE image contract (#123)', () => {
  test('one parse feeds the turn, whether the message came from a canvas send or an Inbox reply', () => {
    // A messy body: one valid image + two malformed entries the shared parse must drop.
    const body = { images: [{ media_type: 'image/png', data: 'AAAA' }, { media_type: 'image/png' }, null] };
    const parsed = parseCanvasImages(body);
    expect(parsed).toEqual([{ media_type: 'image/png', data: 'AAAA' }]);

    // Type-level: the parse output is exactly what the turn accepts. There is only ONE sink to
    // check now — an Inbox reply IS a chat send since ADR-0009 / #124, and #266 removed the
    // retired /api/inbox/:id/reply route that was the second one.
    const toSend: Parameters<typeof runChat>[4] = parsed;
    expect(toSend).toBe(parsed);
  });
});

// ADR-0018 / #261: the edge resolved and ownership-checked the Conversation already, so it
// forwards it on the header instead of the bridge re-reading the platform data layer. The
// bridge PARSES the forwarded shape (guideline 7) — it never trusts the raw header.
describe('GET /api/inbox/:id/chat: served from the forwarded Conversation, no row read (#261)', () => {
  const openReq = (id: string, forwarded: unknown) =>
    new Request(`http://localhost/api/inbox/${id}/chat`, {
      headers: forwarded === undefined ? {} : { [INBOX_CONVERSATION_HEADER]: JSON.stringify(forwarded) },
    });

  test('resolves the chatId from the forwarded row — no Conversation row exists in the database', async () => {
    const id = `conv_forwarded_${crypto.randomUUID()}`;
    const res = await handleRequest(openReq(id, { id, sessionId: `sess_${id}`, ownerRef: 'chat_owner' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chatId: 'chat_owner' });
    // Nothing was read: since #266 this bridge has no platform-data-layer client at all, so the
    // forwarded header is not merely preferred over a row read — it is the only source there is.
  });

  test('an absent, off-contract, or id-mismatched payload is a 404 — never acted on', async () => {
    const id = 'conv_guard';
    const absent = await handleRequest(openReq(id, undefined));
    const offContract = await handleRequest(openReq(id, { id, ownerRef: null })); // no sessionId
    const mismatched = await handleRequest(openReq(id, { id: 'conv_other', sessionId: 's', ownerRef: null }));

    expect([absent.status, offContract.status, mismatched.status]).toEqual([404, 404, 404]);
  });
});

describe('/api/buildrev: public build stamp (#74)', () => {
  test('returns ONLY buildRev — none of /api/status persistence/client fields', async () => {
    const res = await handleRequest(new Request('http://localhost/api/buildrev'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Exactly one field: the SHA stamp. No backend/degraded/save/clients/etc.
    expect(Object.keys(body)).toEqual(['buildRev']);
    expect(typeof body.buildRev).toBe('string');
  });
});

// Chat→canvas pairing (slice 1): a send that EXPLICITLY addresses a canvas (x-canvas-id /
// ?canvas — the pad stamps it) dispatches that id; an unaddressed send (inbox thread,
// dev-agent kick) dispatches undefined so the turn routes to the default store WITHOUT
// claiming a canvas edge for the conversation.
describe('/api/chat/:id/send: the explicit canvas reaches the dispatch; absence claims nothing', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; canvasId?: string }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, canvasId) => {
      dispatched.push({ chatId, canvasId });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a pad send (x-canvas-id) dispatches that canvas', async () => {
    const req = new Request('http://localhost/api/chat/chat_pad/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-id': 'cv_123' },
      body: JSON.stringify({ message: 'draw a box' }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_pad', canvasId: 'cv_123' }]);
  });

  test('an unaddressed send dispatches undefined — never a defaulted claim', async () => {
    const res = await handleRequest(sendReq('chat_inbox'));
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_inbox', canvasId: undefined }]);
  });
});

// Canvas pairing slice 3, container half (ADR-0018 / #264): POST /api/inbox/:id/attach-canvas
// places a live chat card on the canvas the EDGE already paired and wrote the row edge for,
// reading that pairing off x-inbox-canvas-pairing. The route makes NO database write — it wires
// the placement core (inbox.ts) to the bridge's canvas-session registry.
describe('POST /api/inbox/:id/attach-canvas', () => {
  const attachReq = (id: string, pairing?: Record<string, unknown>): Request =>
    new Request(`http://localhost/api/inbox/${encodeURIComponent(id)}/attach-canvas`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(pairing ? { 'x-inbox-canvas-pairing': JSON.stringify(pairing) } : {}),
      },
      body: JSON.stringify({}),
    });

  test('the forwarded pairing places the chat card on that canvas, and 200s with it', async () => {
    const canvasId = `cv_pair_${crypto.randomUUID().slice(0, 8)}`;
    const ownerRef = `chat_attach_${crypto.randomUUID()}`;

    const res = await handleRequest(
      attachReq('conv_paired', { id: 'conv_paired', sessionId: 'sess_paired', ownerRef, canvasId, summary: 'Pick a pricing model' }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, canvasId });
    const read = await handleRequest(new Request(`http://localhost/api/canvas?canvas=${canvasId}`));
    const { shapes } = (await read.json()) as { shapes: Array<Record<string, unknown>> };
    const card = shapes.find((s) => s.type === 'chat');
    expect(card?.chatId).toBe(ownerRef);
  });

  test('a missing or id-mismatched pairing header → 404, and no card is placed', async () => {
    const canvasId = `cv_nopair_${crypto.randomUUID().slice(0, 8)}`;

    expect((await handleRequest(attachReq('conv_paired'))).status).toBe(404);
    const mismatched = await handleRequest(
      attachReq('conv_paired', { id: 'conv_OTHER', sessionId: 's', ownerRef: null, canvasId, summary: null }),
    );
    expect(mismatched.status).toBe(404);

    const read = await handleRequest(new Request(`http://localhost/api/canvas?canvas=${canvasId}`));
    const { shapes } = (await read.json()) as { shapes: Array<Record<string, unknown>> };
    expect(shapes.filter((s) => s.type === 'chat')).toHaveLength(0);
  });
});

// MCP full access: the component library over the wire. The edge MCP tools proxy here —
// the bridge owns the container filesystem (single writer), exactly like the skills route
// below. GET list / GET source / PUT write, canvas-scoped via x-canvas-id (default here).
describe('GET/PUT /api/components — the component library over the wire', () => {
  const MOD = `ZzTestComp${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const componentsRoot = new URL('../src/canvas-default/components/', import.meta.url).pathname; // ADR-0014: default canvas own dir
  afterAll(() => {
    rmSync(`${componentsRoot}${MOD}.tsx`, { force: true });
  });

  const putComponent = (module: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/components/${encodeURIComponent(module)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('PUT writes the module file; list and read then see it', async () => {
    const source = 'export default function T() { return null; }';
    const res = await putComponent(MOD, { source });
    expect(res.status).toBe(200);
    expect(readFileSync(`${componentsRoot}${MOD}.tsx`, 'utf8')).toBe(source);

    const list = await handleRequest(new Request('http://localhost/api/components'));
    expect(((await list.json()) as { components: string[] }).components).toContain(MOD);

    const read = await handleRequest(new Request(`http://localhost/api/components/${MOD}`));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { source: string }).source).toBe(source);
  });

  test('an invalid module name and an empty source are refused — nothing written', async () => {
    expect((await putComponent('../evil', { source: 'x' })).status).toBe(400);
    expect((await putComponent(MOD, { source: '' })).status).toBe(400);
    expect((await putComponent(MOD, {})).status).toBe(400);
  });

  test('reading a module that does not exist is a 404', async () => {
    const res = await handleRequest(new Request('http://localhost/api/components/ZzNoSuchModule'));
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/components/data/:name — data files over the wire (write_data parity)', () => {
  const DF = `zz_test_data_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}.json`;
  const componentsRoot = new URL('../src/canvas-default/components/', import.meta.url).pathname; // ADR-0014: default canvas own dir
  afterAll(() => {
    rmSync(`${componentsRoot}${DF}`, { force: true });
  });

  const putData = (name: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/components/data/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('PUT writes the data file next to the components', async () => {
    const res = await putData(DF, { source: '{"rows": [1]}' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(`${componentsRoot}${DF}`, 'utf8')).toBe('{"rows": [1]}');
  });

  test('an executable extension, bad JSON, and a missing source are refused', async () => {
    expect((await putData('evil.tsx', { source: 'x' })).status).toBe(400);
    expect((await putData(DF, { source: '{nope' })).status).toBe(400);
    expect((await putData(DF, {})).status).toBe(400);
  });
});

// MCP full access: direct canvas mutation over the wire — the same ops the in-canvas
// agent uses (create merges defaults, update merges patches, place stamps the component
// rev), minus the chat-card linking (an external client has no chat card). Isolated on
// a throwaway canvas via ?canvas= so no other test's store is touched.
describe('POST /api/canvas/shapes/{create,update} + /api/components/place — direct mutation', () => {
  const CANVAS = `cv_mcp_ops_${crypto.randomUUID().slice(0, 8)}`;
  const post = (path: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost${path}?canvas=${CANVAS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const readShapes = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await handleRequest(new Request(`http://localhost/api/canvas?canvas=${CANVAS}`));
    return ((await res.json()) as { shapes: Array<Record<string, unknown>> }).shapes;
  };

  test('create → update round-trip: defaults filled on create, update merges the patch', async () => {
    const created = await post('/api/canvas/shapes/create', {
      shapes: [{ type: 'rectangle', x: 10, y: 20, text: 'box' }],
    });
    expect(created.status).toBe(200);
    const shape = (await readShapes()).find((s) => s.text === 'box')!;
    expect(shape.type).toBe('rectangle');

    const updated = await post('/api/canvas/shapes/update', { shapes: [{ id: shape.id, text: 'renamed' }] });
    expect(updated.status).toBe(200);
    const after = (await readShapes()).find((s) => s.id === shape.id)!;
    expect(after.text).toBe('renamed');
    expect(after.x).toBe(10); // untouched fields survive the patch
  });

  test('place_component: a component instance lands with module, box, data, and a rev', async () => {
    const placed = await post('/api/components/place', { module: 'ZzTestMod', x: 5, y: 6, data: { n: 1 } });
    expect(placed.status).toBe(200);
    const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === 'ZzTestMod')!;
    expect(comp.data).toEqual({ n: 1 });
    expect(typeof comp.rev).toBe('number');
  });

  test('bad inputs are 400s: empty batch, unknown update id, missing module', async () => {
    expect((await post('/api/canvas/shapes/create', { shapes: [] })).status).toBe(400);
    expect((await post('/api/canvas/shapes/update', { shapes: [{ id: 'zz_ghost', text: 'x' }] })).status).toBe(400);
    expect((await post('/api/components/place', { x: 1, y: 2 })).status).toBe(400);
  });

  // #223: `module` now goes through the shared COMPONENT_NAME_RE (shared/bridge-wire.ts),
  // the same rule the edge and server/components.ts already enforce — a module name that
  // could never resolve to a file is rejected here instead of landing an unloadable card.
  // #239 / ADR-0017: a component names a mart, never a URL — the bridge's own
  // PlaceComponentBody accepts and stores it (the field the guest-scope resolver reads).
  test('place_component: a mart dataSource is accepted and stored on the shape', async () => {
    const placed = await post('/api/components/place', { module: 'ZzTestMod2', x: 5, y: 6, dataSource: { kind: 'mart', name: 'mart_runway' } });
    expect(placed.status).toBe(200);
    const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === 'ZzTestMod2')!;
    expect(comp.dataSource).toEqual({ kind: 'mart', name: 'mart_runway' });
  });

  test('place_component: a malformed dataSource is a 400', async () => {
    const placed = await post('/api/components/place', { module: 'ZzTestMod3', x: 5, y: 6, dataSource: { kind: 'url', url: 'https://evil.example' } });
    expect(placed.status).toBe(400);
  });

  // #250: `data` is arbitrary component props, agent- and author-supplied — a component
  // whose props legitimately include a field NAMED "dataSource" (a natural prop name for
  // a chart) must still be placeable. Traced end-to-end (PlaceComponentBody's `data` is
  // `z.record(z.unknown())`, buildShape's 'component' case only ever reads the sibling
  // `raw.dataSource`, never `raw.data.dataSource`) and reproduced against this exact
  // payload: no code path here reads `data.dataSource`, so it is already inert — passed
  // through to the component as an ordinary prop, byte-for-byte, and never promoted to
  // the shape-level mart reference. This test locks that contract in (CLAUDE.md §7: the
  // boundary's behavior on this key is a deliberate decision, not an accident) and is the
  // never-a-500 guarantee #250 asks for: same value, key named "dataSource" instead of
  // "nested", still 200.
  test('place_component: a `dataSource` key INSIDE `data` is just a prop, never a 500, never promoted to the shape-level mart ref', async () => {
    const value = { kind: 'mart', name: 'mart_session_events' };
    const placed = await post('/api/components/place', { module: 'ZzTestMod2b', x: 5, y: 6, data: { dataSource: value } });
    expect(placed.status).toBe(200);
    const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === 'ZzTestMod2b')!;
    expect(comp.data).toEqual({ dataSource: value }); // reaches the component as an ordinary prop, untouched
    expect(comp.dataSource).toBeUndefined(); // never promoted to the sibling mart reference
  });

  // A mart name is validated at PLACEMENT (MartName, mart-contract.ts), not just at
  // fetch time — otherwise an invalid name lands in persisted canvas state and only
  // fails later at render, far from the mistake (CLAUDE.md §7: parse at the boundary).
  test('place_component: a mart dataSource with a name that fails MartName is a 400, never stored', async () => {
    const placed = await post('/api/components/place', { module: 'ZzTestMod4', x: 5, y: 6, dataSource: { kind: 'mart', name: 'Not-Valid!' } });
    expect(placed.status).toBe(400);
    expect((await readShapes()).some((s) => s.type === 'component' && s.module === 'ZzTestMod4')).toBe(false);
  });

  test('place_component: a module name that fails the component-name rule is a 400', async () => {
    for (const module of ['../evil', 'Bad.Name', '9leading', 'has space', '']) {
      expect((await post('/api/components/place', { module, x: 1, y: 2 })).status).toBe(400);
    }
    expect((await readShapes()).some((s) => s.type === 'component' && typeof s.module === 'string' && s.module.includes('evil'))).toBe(false);
  });
});

// #177: the single writer of the workspace skills tree — the edge MCP `upload_skill`
// proxies here. Content only (ADR-0013): plain files under .claude/skills/<name>/,
// path rules enforced server-side, persisted by the skills sink at flush.
describe('PUT /api/skills/:name — workspace-skill upload (#177)', () => {
  const SKILL = `zz-test-skill-${crypto.randomUUID().slice(0, 8)}`;
  const skillsRoot = new URL('../.claude/skills/', import.meta.url).pathname;
  afterAll(() => {
    rmSync(`${skillsRoot}${SKILL}`, { recursive: true, force: true });
  });

  const putSkill = (name: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('writes the skill files under .claude/skills/<name>/ and reports them', async () => {
    const res = await putSkill(SKILL, {
      files: [
        { path: 'SKILL.md', content: '---\nname: t\n---\nbody' },
        { path: 'data/corpus.yaml', content: 'a: 1' },
      ],
    });
    expect(res.status).toBe(200);
    expect(readFileSync(`${skillsRoot}${SKILL}/SKILL.md`, 'utf8')).toContain('body');
    expect(readFileSync(`${skillsRoot}${SKILL}/data/corpus.yaml`, 'utf8')).toBe('a: 1');
  });

  test('rejects traversal in the skill name and in file paths — nothing written', async () => {
    expect((await putSkill('../evil', { files: [{ path: 'SKILL.md', content: 'x' }] })).status).toBe(400);
    expect((await putSkill(SKILL, { files: [{ path: '../outside.md', content: 'x' }] })).status).toBe(400);
    expect((await putSkill(SKILL, { files: [{ path: '/etc/absolute', content: 'x' }] })).status).toBe(400);
  });

  test('rejects an empty body', async () => {
    expect((await putSkill(SKILL, { files: [] })).status).toBe(400);
  });
});

// Cross-chat messaging: the bridge-bound seam behind the agent's send_message tool.
import { sendToChat } from './bridge.ts';

describe('sendToChat (agent cross-chat messaging)', () => {
  test('dispatches a turn for the target chat on the sender canvas', () => {
    const dispatched: Array<{ chatId: string; message: string; canvasId?: string }> = [];
    const restore = setChatTurnDispatcher((chatId, message, _sid, _img, _model, _fork, _effort, canvasId) => {
      dispatched.push({ chatId, message, canvasId });
    });
    try {
      const res = sendToChat('shape:other', '[from shape:me] hello', 'cv_route');
      expect(res).toEqual({ ok: true });
      expect(dispatched).toEqual([{ chatId: 'shape:other', message: '[from shape:me] hello', canvasId: 'cv_route' }]);
    } finally {
      restore();
    }
  });

  test('refuses while the target has a turn in flight (one turn per chat)', () => {
    const restore = setChatTurnDispatcher(() => {
      throw new Error('must not dispatch');
    });
    chatHub.aborters.set('shape:busy', new AbortController());
    try {
      const res = sendToChat('shape:busy', 'hi');
      expect(res.ok).toBe(false);
    } finally {
      chatHub.aborters.delete('shape:busy');
      restore();
    }
  });
});
