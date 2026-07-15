// The /api/chat/:id/send subscribe-before-send wire contract (425 Too Early).
//
// Importing bridge.ts does NOT bind a port (Bun.serve is guarded behind
// `import.meta.main`), so we drive the exported `handleRequest` directly with a
// Request and assert the response. `setChatTurnDispatcher` swaps in a spy so the
// 2xx path never invokes the real agent SDK and we can assert dispatch happened (or,
// on the 425 path, did NOT). `chatClients` is the shared subscriber set the guard
// consults — one connected stream carries every chat, so a single fake controller
// represents "a subscriber exists".

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';

import { type CanvasImage, parseCanvasImages, runChat } from './agent.ts';
import { aborters, chatClients, handleRequest, indexSessionStart, prepareDevAgentTurn, setChatTurnDispatcher, turnFlavor, webPocDb } from './bridge.ts';
import { resumeConversation } from './inbox.ts';
import { conversations } from '../web-poc/lib/db/index.ts';
import { DEV_AGENT_KIND } from './dev-agent-workflow.ts';
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
    for (const c of [...chatClients]) chatClients.delete(c); // no subscribers by default
    dispatched = [];
    restore = setChatTurnDispatcher((chatId, message, _sessionId, images) => {
      dispatched.push({ chatId, message, images });
    });
  });

  afterEach(() => {
    restore();
    for (const c of [...chatClients]) chatClients.delete(c);
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
    chatClients.add(sub);

    const res = await handleRequest(sendReq('chat_subbed', { message: 'go' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatched).toEqual([{ chatId: 'chat_subbed', message: 'go', images: [] }]);
  });

  test('pasted images ride the send through to the dispatch (same contract a reply reuses)', async () => {
    chatClients.add(fakeSubscriber());
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
    chatClients.add(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, devAgentGitToken, _mcpTokens, devAgentRepo) => {
      dispatched.push({ chatId, devAgentGitToken, devAgentRepo });
    });
  });

  afterEach(() => {
    restore();
    for (const c of [...chatClients]) chatClients.delete(c);
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

// ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens ride the send as the
// x-mcp-tokens header (server/mcp-registry.ts's shared contract); the bridge decodes it and
// hands it to the dispatched turn. `server/turn.ts` is what drops this for a dev-agent turn
// (pinned in server/turn.test.ts) — here we only pin the header → decode → dispatch wiring.
describe('/api/chat/:id/send: the x-mcp-tokens header reaches the dispatched turn (decoded)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; mcpTokens?: Record<string, string> }> = [];

  beforeEach(() => {
    dispatched = [];
    chatClients.add(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, _devAgentGitToken, mcpTokens) => {
      dispatched.push({ chatId, mcpTokens });
    });
  });

  afterEach(() => {
    restore();
    for (const c of [...chatClients]) chatClients.delete(c);
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
});

// ADR-0011: one turn per chat, enforced at the wire. The client queue only protects the tab
// that started the turn; a headless dev-agent run (or another tab) needs the server to say no.
describe('/api/chat/:id/send: 409 turn_in_flight while the chat’s turn runs', () => {
  let restore: () => void = () => {};
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    chatClients.add(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId) => {
      dispatched.push(chatId);
    });
  });

  afterEach(() => {
    restore();
    for (const c of [...chatClients]) chatClients.delete(c);
    aborters.delete('chat_busy');
    aborters.delete('chat_running');
  });

  test('a send while a turn is in flight → 409 {turn_in_flight}, nothing dispatched', async () => {
    aborters.set('chat_busy', new AbortController()); // a live turn holds the chat

    const res = await handleRequest(sendReq('chat_busy'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'turn_in_flight', chatId: 'chat_busy' });
    expect(dispatched).toEqual([]);
  });

  test('the transcript GET reports in-flight state, so a mid-run opener rehydrates busy', async () => {
    aborters.set('chat_running', new AbortController());

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

  const kick = async (token = 'ghs_run') => {
    const res = await handleRequest(
      new Request('http://localhost/api/dev-agent/run', {
        method: 'POST',
        headers: { 'x-dev-agent-git-token': token, 'x-dev-agent-repo': 'Zabaca/cedarpad' },
      }),
    );
    const body = (await res.json()) as { chatId: string; joined: boolean };
    kicked.push(body.chatId);
    return { status: res.status, body };
  };

  beforeEach(() => {
    dispatched = [];
    // NO chatClients subscriber — the kick is headless by design.
    for (const c of [...chatClients]) chatClients.delete(c);
    restore = setChatTurnDispatcher((chatId, message, sessionId, _images, model, _fork, _effort, _canvasId, devAgentGitToken, _mcpTokens, devAgentRepo) => {
      dispatched.push({ chatId, message, sessionId, model, devAgentGitToken, devAgentRepo });
    });
  });

  afterEach(() => {
    restore();
    for (const id of kicked) aborters.delete(id);
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
    // First sentence = the Conversation row's title (row-at-start slices the message).
    expect(dispatched[0]!.message.startsWith('Architecture explore:')).toBe(true);
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
    // Exploration fans out to the repo-defined Sonnet subagent — gracefully degrading on
    // repos that define none (ADR-0015: arbitrary connected repos must not break the run).
    expect(p).toContain('explorer');
    expect(p).toContain('If it defines none, do the reading yourself without fan-out');
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
    // The default explore task is NOT included when a job supplies the task.
    expect(p).not.toContain('Architecture explore:');
  });

  test('join semantics: a kick during a running run returns THAT run, dispatching nothing new', async () => {
    const first = await kick();
    aborters.set(first.body.chatId, new AbortController()); // the spy doesn't run a real turn — simulate in-flight

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
describe('indexSessionStart: a session enters the index when it starts (ADR-0011)', () => {
  test('creates the Conversation row at init — waiting_on none, titled from the message', async () => {
    const sessionId = `sess_start_${crypto.randomUUID()}`;

    await indexSessionStart('chat_start', sessionId, 'Architecture explore: survey this repo for deepening opportunities. (long instructions follow)');

    const row = await conversations.getBySessionId(webPocDb, sessionId);
    expect(row).not.toBeNull();
    expect(row!.waitingOn).toBe('none'); // visible in "All", never clutters "Needs me"
    expect(row!.summary).toContain('Architecture explore');
  });

  test('idempotent: a resumed turn re-inits the same session without duplicating or retitling', async () => {
    const sessionId = `sess_reinit_${crypto.randomUUID()}`;

    await indexSessionStart('chat_a', sessionId, 'the original first message');
    const first = await conversations.getBySessionId(webPocDb, sessionId);
    await indexSessionStart('chat_a', sessionId, 'a later reply that must not retitle');
    const second = await conversations.getBySessionId(webPocDb, sessionId);

    expect(second!.id).toBe(first!.id); // one row per session
    expect(second!.summary).toBe('the original first message');
  });
});

describe('reply/send share ONE image contract (#123)', () => {
  test('the same parse feeds both the canvas send and the inbox reply', () => {
    // A messy body: one valid image + two malformed entries the shared parse must drop.
    const body = { images: [{ media_type: 'image/png', data: 'AAAA' }, { media_type: 'image/png' }, null] };
    const parsed = parseCanvasImages(body);
    expect(parsed).toEqual([{ media_type: 'image/png', data: 'AAAA' }]);

    // Type-level: the parse output is exactly what BOTH sinks accept — runChat's `images`
    // param (the canvas /send turn) and resumeConversation's runTurn `images` param (the
    // inbox reply). If either narrowed to a second schema, these assignments would not compile.
    const toSend: Parameters<typeof runChat>[4] = parsed;
    const runTurn: Parameters<typeof resumeConversation>[3] = parsed;
    expect(toSend).toBe(parsed);
    expect(runTurn).toBe(parsed);
  });
});

describe('POST /api/inbox/:id/reply routes EVERY conversation through the chat turn (#126)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; message: string; sessionId: string | null }> = [];

  beforeEach(() => {
    dispatched = [];
    // The chat-turn dispatcher is the SIGNAL: resumeConversation → runTurn → dispatchChatTurn.
    // Before #126 a dev-agent reply bypassed this entirely (it ran runDevAgentApproval → a fresh
    // worktree + PR), so `dispatched` would stay empty — this test is the mutation check.
    restore = setChatTurnDispatcher((chatId, message, sessionId) => {
      dispatched.push({ chatId, message, sessionId });
    });
  });

  afterEach(() => restore());

  const replyReq = (id: string, message: string): Request =>
    new Request(`http://localhost/api/inbox/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });

  test('a dev-agent Conversation reply resumes as a chat turn (NOT the old approval→PR path)', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_devagent_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'default',
      kind: DEV_AGENT_KIND,
      summary: 'architecture deepening candidates',
    });

    const res = await handleRequest(replyReq(conv.id, 'go with candidate #1'));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    // The reply drove a chat turn — the same machinery every conversation uses.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.message).toBe('go with candidate #1');
    expect(dispatched[0]!.sessionId).toBe(conv.sessionId);
  });

  test('a product Conversation reply resumes as a chat turn too (regression: unaffected)', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_product_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'cs_workspace_abc',
      summary: 'a normal product session',
    });

    const res = await handleRequest(replyReq(conv.id, 'here is my answer'));

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.message).toBe('here is my answer');
    expect(dispatched[0]!.sessionId).toBe(conv.sessionId);
  });
});

describe('GET /api/inbox/:id/chat: opening a thread marks it read', () => {
  test('clears unread on the Conversation it opens', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_open_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'cs_workspace_abc',
      summary: 'a session with an unread reply',
    });
    await conversations.markActivity(webPocDb, conv.id); // unread:true

    const res = await handleRequest(new Request(`http://localhost/api/inbox/${conv.id}/chat`));

    expect(res.status).toBe(200);
    // markRead is fire-and-forget; give its microtask a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    const after = await conversations.get(webPocDb, conv.id);
    expect(after?.unread).toBe(false);
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
    chatClients.add(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, canvasId) => {
      dispatched.push({ chatId, canvasId });
    });
  });

  afterEach(() => {
    restore();
    for (const c of [...chatClients]) chatClients.delete(c);
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

describe('indexSessionStart: records the chat→canvas edge when the turn carries one', () => {
  test('a canvas-born session lands with its canvas edge; an unaddressed one stays null', async () => {
    const withCanvas = `sess_cv_${crypto.randomUUID()}`;
    await indexSessionStart('chat_cv', withCanvas, 'born on a canvas', undefined, 'cv_9');
    expect((await conversations.getBySessionId(webPocDb, withCanvas))!.canvasId).toBe('cv_9');

    const without = `sess_nocv_${crypto.randomUUID()}`;
    await indexSessionStart('chat_nocv', without, 'born in the inbox');
    expect((await conversations.getBySessionId(webPocDb, without))!.canvasId).toBeNull();
  });
});

describe('POST /api/inbox/:id/reply routes the resumed turn to the conversation’s canvas', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ canvasId?: string }> = [];

  beforeEach(() => {
    dispatched = [];
    restore = setChatTurnDispatcher((_chatId, _message, _sessionId, _images, _model, _fork, _effort, canvasId) => {
      dispatched.push({ canvasId });
    });
  });

  afterEach(() => restore());

  test('a linked conversation resumes on ITS canvas store, not the default', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_linked_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'cs_workspace_abc',
      canvasId: 'cv_linked',
      summary: 'a canvas-born chat',
    });
    const res = await handleRequest(
      new Request(`http://localhost/api/inbox/${encodeURIComponent(conv.id)}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'continue' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(dispatched).toEqual([{ canvasId: 'cv_linked' }]);
  });
});

// Canvas pairing slice 3: POST /api/inbox/:id/attach-canvas links a canvas-less Conversation
// to a canvas (creating one when none is named) and places a live chat card on it. The route
// wires the REAL attach core (inbox.ts) to the bridge's canvas-session registry + registry db.
describe('POST /api/inbox/:id/attach-canvas', () => {
  const attachReq = (id: string, body: Record<string, unknown> = {}): Request =>
    new Request(`http://localhost/api/inbox/${encodeURIComponent(id)}/attach-canvas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('create-and-attach: 200, a new canvas in the conversation’s workspace, edge written', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_attach_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'ws_attach_test',
      ownerRef: `chat_attach_${crypto.randomUUID()}`,
      summary: 'Pick a pricing model',
    });

    const res = await handleRequest(attachReq(conv.id));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; canvasId: string };
    expect(body.ok).toBe(true);
    expect(body.canvasId).toStartWith('cv_');
    expect((await conversations.get(webPocDb, conv.id))?.canvasId).toBe(body.canvasId);
  });

  test('an already-linked conversation is refused with 409 (first-wins, no detach)', async () => {
    const conv = await conversations.create(webPocDb, {
      sessionId: `sess_linked_${crypto.randomUUID()}`,
      userId: 'default',
      workspaceId: 'ws_attach_test',
      canvasId: 'cv_already',
      summary: 'linked',
    });

    const res = await handleRequest(attachReq(conv.id));
    expect(res.status).toBe(409);
  });

  test('unknown conversation → 404', async () => {
    const res = await handleRequest(attachReq('conv_ghost'));
    expect(res.status).toBe(404);
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

// #212: the presence heartbeat route + throttled fan-out over the existing canvas SSE.
describe('POST /api/canvas/presence — ephemeral presence over the canvas stream', () => {
  const CANVAS = `cv_presence_${crypto.randomUUID().slice(0, 8)}`;
  const beat = (body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/canvas/presence?canvas=${CANVAS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('a heartbeat lands and is broadcast as an `event: presence` frame on the stream', async () => {
    const stream = await handleRequest(new Request(`http://localhost/api/canvas/stream?canvas=${CANVAS}`));
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();

    const ok = await beat({ userId: 'u_1', name: 'James', color: 'hsl(210 65% 52%)', cursor: { x: 5, y: 6 }, camera: { x: 0, y: 0, z: 1 } });
    expect(ok.status).toBe(200);

    // Read frames until the (throttled ~100ms) presence event arrives.
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 2000;
    while (!buf.includes('event: presence') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    await reader.cancel();
    expect(buf).toContain('event: presence');
    const frame = buf.split('event: presence\n')[1]?.split('\n\n')[0] ?? '';
    const parsed = JSON.parse(frame.replace(/^data: /, '')) as { entries: unknown[] };
    expect(parsed.entries).toEqual([
      { userId: 'u_1', name: 'James', color: 'hsl(210 65% 52%)', cursor: { x: 5, y: 6 }, camera: { x: 0, y: 0, z: 1 } },
    ]);
  });

  test('a malformed heartbeat is a 400 and lands nowhere', async () => {
    expect((await beat({ color: 'red' })).status).toBe(400);
    expect((await beat({ userId: 'u_1' })).status).toBe(400);
  });
});
