import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { GateUser } from './auth-gate.ts';
import { workspaceEventsName } from '../shared/workspace-events.ts';
import { DEV_AGENT_KIND } from '../server/dev-agent-workflow.ts';
import { LEGACY_SANDBOX_ID, type SandboxCoords } from './sandbox-resolver.ts';

// The edge chat proxy (`handleInboxBridge`) proxies a Conversation's chat traffic to its owning
// runner bridge, and — since a reply is now a chat SEND, not the retired /api/inbox/:id/reply —
// it owns the inbox TRIAGE FLIP (ADR-0009 / #124): a send flips waiting_on:human → agent so the
// answered Conversation un-pins from the attention list. We drive the real handler with its
// integration seams stubbed: the sandbox proxy (so no container is woken) and the Conversation
// store (`get` for ownership, `reply` as the flip we assert). `conversations.reply` is the exact
// helper prod used; recording its calls is the mutation-check — remove the flip and the send test
// fails.

let conv: ConversationRow | null = null;
// Membership seam (shared inbox): which users getWorkspace admits. u_1 is a member by default.
let workspaceMembers: string[] = [];
let served: SandboxCoords[] = [];
let servedAssigns: Array<string | null> = [];
let servedTokens: Array<string | null> = [];
let servedCanvasIds: Array<string | null> = [];
let servedRepos: Array<string | null> = [];
let servedMcpTokenHeaders: Array<string | null> = [];
let servedConversations: Array<string | null> = [];
let replyCalls: string[] = [];
let markReadCalls: string[] = [];
let attachCanvasCalls: Array<[string, string]> = [];
let servedPairings: Array<string | null> = [];
let mintCalls = 0;
let mintResult: string | null = 'ghs_minted';
let mcpTokensByWorkspace: Record<string, Record<string, string>> = {};

// #240: index.ts's `warehouseExec` statically imports `getSandbox` too — this factory
// replaces the WHOLE module, so any named import missing here fails "export not found"
// for every test file that transitively loads index.ts, this one included.
mock.module('@cloudflare/sandbox', () => ({
  Sandbox: class {},
  getSandbox: () => ({ exec: async () => ({ success: true, stdout: '', stderr: '' }) }),
}));
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
    servedTokens.push(req.headers.get('x-dev-agent-git-token'));
    servedCanvasIds.push(req.headers.get('x-canvas-id'));
    servedRepos.push(req.headers.get('x-dev-agent-repo'));
    servedMcpTokenHeaders.push(req.headers.get('x-mcp-tokens'));
    servedAssigns.push(req.headers.get('x-inbox-assign'));
    servedConversations.push(req.headers.get('x-inbox-conversation'));
    servedPairings.push(req.headers.get('x-inbox-canvas-pairing'));
    return new Response('proxied');
  },
  sandboxFor: () => ({}),
  // #248: index.ts now imports warehouseExec from here (moved from an inline definition)
  // — this file's full-module mock must supply it too, unused by these tests.
  warehouseExec: async () => ({ success: true, stdout: '', stderr: '' }),
}));
// Membership gate seam: the bridge proxy admits any workspace MEMBER (never creator-gated).
// Delegate + RESTORE (the index.test.ts pattern): bun's mock.module rebinds the module for
// every later test file in the process (#170's leak class), so a canned getWorkspace here
// would break the real-DB tests that run after this file in a full-suite pass.
const realWorkspaces = await import('../web-poc/lib/db/queries/workspaces.ts');
const realGetWorkspace = realWorkspaces.getWorkspace;
let getWorkspaceImpl: typeof realGetWorkspace = ((_db: unknown, workspaceId: string, userId: string) =>
  Promise.resolve(workspaceMembers.includes(userId) ? { id: workspaceId } : null)) as never;
mock.module('../web-poc/lib/db/queries/workspaces.ts', () => ({
  ...realWorkspaces,
  getWorkspace: (...args: Parameters<typeof realGetWorkspace>) => getWorkspaceImpl(...args),
}));
afterAll(() => {
  getWorkspaceImpl = realGetWorkspace;
});
// ADR-0016 canvas edge seam: the proxy derives conversation visibility through the linked
// canvas. Delegate + RESTORE, same leak-class reasoning as getWorkspace above.
let linkedCanvas: { visibility: 'workspace' | 'private'; createdBy: string | null } | null = null;
const realCanvases = await import('../web-poc/lib/db/queries/canvases.ts');
const realGetCanvas = realCanvases.get;
// #264 canvas pairing: the registry rows the edge now reads/writes itself, keyed by id so a
// pairing test can pose a same- vs other-workspace target while `linkedCanvas` keeps serving
// the visibility gate above.
let canvasesById: Record<string, { id: string; workspaceId: string }> = {};
let createdCanvases: Array<{ workspaceId: string; name: string }> = [];
let getCanvasImpl: typeof realGetCanvas = ((_db: unknown, canvasId: string) =>
  Promise.resolve((canvasesById[canvasId] ?? linkedCanvas) as never)) as never;
const realCreateCanvas = realCanvases.create;
let createCanvasImpl: typeof realCreateCanvas = ((_db: unknown, input: { workspaceId: string; name: string }) => {
  createdCanvases.push(input);
  return Promise.resolve({ id: `cv_new_${createdCanvases.length}`, ...input } as never);
}) as never;
mock.module('../web-poc/lib/db/queries/canvases.ts', () => ({
  ...realCanvases,
  get: (...args: Parameters<typeof realGetCanvas>) => getCanvasImpl(...args),
  create: (...args: Parameters<typeof realCreateCanvas>) => createCanvasImpl(...args),
}));
afterAll(() => {
  getCanvasImpl = realGetCanvas;
  createCanvasImpl = realCreateCanvas;
});
// Delegate + restore, like the canvases mock above: the canned impls hand back to the real
// module in afterAll so this file's stubs don't rebind conversations for every LATER test file.
// The real implementations are captured as VALUES up front — bun rebinds the namespace object
// itself, so reading them back off the namespace later would hand you this very wrapper.
const realConversations = await import('../web-poc/lib/db/queries/conversations.ts');
const realConvFns = {
  get: realConversations.get,
  reply: realConversations.reply,
  markRead: realConversations.markRead,
  attachCanvas: realConversations.attachCanvas,
};
let convImpls = {
  get: (() => Promise.resolve(conv)) as typeof realConvFns.get,
  reply: ((_db: unknown, id: string) => {
    replyCalls.push(id);
    return Promise.resolve(conv);
  }) as never as typeof realConvFns.reply,
  markRead: ((_db: unknown, id: string) => {
    markReadCalls.push(id);
    return Promise.resolve(conv);
  }) as never as typeof realConvFns.markRead,
  attachCanvas: ((_db: unknown, id: string, canvasId: string) => {
    attachCanvasCalls.push([id, canvasId]);
    return Promise.resolve(conv);
  }) as never as typeof realConvFns.attachCanvas,
};
mock.module('../web-poc/lib/db/queries/conversations.ts', () => ({
  ...realConversations,
  get: (...args: Parameters<typeof realConvFns.get>) => convImpls.get(...args),
  reply: (...args: Parameters<typeof realConvFns.reply>) => convImpls.reply(...args),
  markRead: (...args: Parameters<typeof realConvFns.markRead>) => convImpls.markRead(...args),
  attachCanvas: (...args: Parameters<typeof realConvFns.attachCanvas>) => convImpls.attachCanvas(...args),
}));
afterAll(() => {
  convImpls = { ...realConvFns };
});
// ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens (per-workspace, not
// per-conversation) — stubbed by workspaceId so a test can assert isolation between workspaces.
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  listTokens: (_db: unknown, workspaceId: string) => Promise.resolve(mcpTokensByWorkspace[workspaceId] ?? {}),
}));

const { handleInboxBridge } = await import('./inbox-bridge.ts');

const user: GateUser = { id: 'u_1' } as GateUser;

const row = (o: Partial<ConversationRow> = {}): ConversationRow =>
  ({
    id: 'conv_1',
    sessionId: 's',
    status: 'open',
    waitingOn: 'human',
    unread: true,
    lastActivity: new Date(0),
    ownerRef: null,
    canvasId: null,
    kind: 'chat',
    workspaceId: 'default',
    userId: 'u_1',
    summary: null,
    lastMessagePreview: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...o,
  }) as ConversationRow;

// Drive the proxy exactly as worker/index.ts does: the routing prefix already stripped to
// `subPath`. The token mint is a default-parameter seam (production binds the real
// `mintDevAgentGitToken`); the fake records calls so a test can assert mint-vs-no-mint.
const mint = () => {
  mintCalls += 1;
  return Promise.resolve(mintResult);
};
const proxy = (method: string, subPath: string, convId = 'conv_1') =>
  handleInboxBridge(
    new Request(`https://poc.cedarpad.com/inbox/${convId}/bridge${subPath}`, { method }),
    {} as never,
    user,
    convId,
    subPath,
    mint,
    // The repo resolver seam (ADR-0015): a fixed connection so the mint/no-mint assertions
    // stay about the SEND rules; conv.repo-vs-fallback precedence is pinned separately below.
    async (_env, _db, _ws, requested) => ({ installationId: 'inst_1', repoFullName: requested ?? 'Zabaca/cedarpad' }),
  );

// Let the fire-and-forget flip (a microtask) settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  conv = row();
  linkedCanvas = null;
  workspaceMembers = ['u_1'];
  served = [];
  servedAssigns = [];
  servedTokens = [];
  servedCanvasIds = [];
  servedRepos = [];
  servedMcpTokenHeaders = [];
  servedConversations = [];
  replyCalls = [];
  markReadCalls = [];
  attachCanvasCalls = [];
  servedPairings = [];
  canvasesById = {};
  createdCanvases = [];
  mintCalls = 0;
  mintResult = 'ghs_minted';
  mcpTokensByWorkspace = {};
});

// #383: the proxy's THREE conversation writes each ring the workspace's events hub, so a
// human replying, opening a thread, or pairing a chat with a canvas updates every open
// Shell's badge as fast as an agent's turn does.
describe('handleInboxBridge: the proxy’s row writes ring the workspace events hub', () => {
  const rung: string[] = [];
  const hubEnv = {
    WORKSPACE_EVENTS: {
      idFromName: (name: string) => ({ name }),
      get: ({ name }: { name: string }) => ({
        fetch: async () => {
          rung.push(name);
          return new Response(null, { status: 204 });
        },
      }),
    },
  } as never;
  const withHub = (method: string, subPath: string, convId = 'conv_1') =>
    handleInboxBridge(
      new Request(`https://poc.cedarpad.com/inbox/${convId}/bridge${subPath}`, {
        method,
        ...(subPath.endsWith('/attach-canvas') ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}),
      }),
      hubEnv,
      user,
      convId,
      subPath,
      mint,
      async (_env, _db, _ws, requested) => ({ installationId: 'inst_1', repoFullName: requested ?? 'Zabaca/cedarpad' }),
    );

  beforeEach(() => {
    rung.length = 0;
  });

  test('a chat SEND — the human answering', async () => {
    await withHub('POST', '/api/chat/chat_home/send');
    await settle();
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('the open-conversation GET — opening a thread clears its unread', async () => {
    await withHub('GET', '/api/inbox/conv_1/chat');
    await settle();
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('attach-canvas — the chat→canvas edge a private canvas hides it by', async () => {
    await withHub('POST', '/api/inbox/conv_1/attach-canvas');
    await settle();
    expect(rung).toEqual([workspaceEventsName('default')]);
  });

  test('a plain transcript read rings nothing — no row changed', async () => {
    await withHub('GET', '/api/chat/chat_home/transcript');
    await settle();
    expect(rung).toEqual([]);
  });

  test('the hub rung is the CONVERSATION’s workspace', async () => {
    conv = row({ workspaceId: 'ws_other' });
    workspaceMembers = ['u_1'];
    await withHub('POST', '/api/chat/chat_home/send');
    await settle();
    expect(rung).toEqual([workspaceEventsName('ws_other')]);
  });
});

describe('handleInboxBridge: the inbox triage flip on a proxied send', () => {
  test('a proxied chat SEND flips the Conversation waiting_on:agent (conversations.reply(convId))', async () => {
    const res = await proxy('POST', '/api/chat/chat_home/send');
    await settle();

    expect(res.status).toBe(200); // proxied through
    expect(served).toHaveLength(1); // the send reached the owning bridge
    expect(replyCalls).toEqual(['conv_1']); // …and the Conversation was flipped (unread cleared)
  });

  test('a proxied transcript GET does NOT flip (reading history is not answering)', async () => {
    await proxy('GET', '/api/chat/chat_home/transcript');
    await settle();

    expect(served).toHaveLength(1);
    expect(replyCalls).toEqual([]);
  });

  test('the alive beat does NOT flip', async () => {
    await proxy('POST', '/api/alive');
    await settle();

    expect(served).toHaveLength(1);
    expect(replyCalls).toEqual([]);
  });

  test('interrupt does NOT flip (stopping a turn is not answering)', async () => {
    await proxy('POST', '/api/chat/chat_home/interrupt');
    await settle();

    expect(served).toHaveLength(1);
    expect(replyCalls).toEqual([]);
  });

  test('MEMBERSHIP-gated, not creator-gated: a member proxies a conversation they did not create', async () => {
    conv = row({ userId: 'someone_else' }); // creator is another member — irrelevant now
    const res = await proxy('POST', '/api/chat/chat_home/send');
    await settle();

    expect(res.status).toBe(200);
    expect(served).toHaveLength(1);
    expect(replyCalls).toEqual(['conv_1']);
  });

  test('a NON-member (stranger to the workspace) is 404 — no flip, no wake', async () => {
    workspaceMembers = []; // u_1 is not a member of the conversation's workspace
    const res = await proxy('POST', '/api/chat/chat_home/send');
    await settle();

    expect(res.status).toBe(404);
    expect(served).toHaveLength(0);
    expect(replyCalls).toEqual([]);
  });

  test('a proxied SEND stamps the replier as x-inbox-assign (the bridge claims-if-unassigned); reads never do', async () => {
    await proxy('POST', '/api/chat/chat_home/send');
    await proxy('GET', '/api/chat/chat_home/transcript');

    expect(servedAssigns).toEqual(['u_1', null]);
  });
});

// ADR-0018 / #261: the edge already resolved and ownership-checked the Conversation, so the
// open-conversation route carries it to the bridge instead of the container re-reading the row.
describe('handleInboxBridge: the open-conversation GET forwards the resolved Conversation (#261)', () => {
  test('GET /api/inbox/:id/chat carries the Conversation the edge resolved', async () => {
    conv = row({ id: 'conv_1', sessionId: 'sess_9', ownerRef: 'chat_owner' });
    await proxy('GET', '/api/inbox/conv_1/chat');

    expect(servedConversations).toEqual([JSON.stringify({ id: 'conv_1', sessionId: 'sess_9', ownerRef: 'chat_owner' })]);
  });

  test('a client-sent header never survives: the edge overwrites it on the open GET and strips it elsewhere', async () => {
    const forged = JSON.stringify({ id: 'conv_1', sessionId: 'someone_elses_session', ownerRef: null });
    const req = (subPath: string, method: string) =>
      handleInboxBridge(
        new Request(`https://poc.cedarpad.com/inbox/conv_1/bridge${subPath}`, {
          method,
          headers: { 'x-inbox-conversation': forged },
        }),
        {} as never,
        user,
        'conv_1',
        subPath,
        mint,
        async () => null,
      );

    await req('/api/inbox/conv_1/chat', 'GET');
    await req('/api/chat/chat_1/transcript', 'GET');

    expect(servedConversations).toEqual([JSON.stringify({ id: 'conv_1', sessionId: 's', ownerRef: null }), null]);
  });

  test('opening a thread clears unread at the edge; other proxied paths never do', async () => {
    await proxy('GET', '/api/inbox/conv_1/chat');
    await proxy('GET', '/api/chat/chat_1/transcript');
    await settle();

    expect(markReadCalls).toEqual(['conv_1']);
  });
});

// Canvas pairing split (ADR-0018 / #264): the ROW half of attach-canvas is the edge's now —
// same-workspace enforcement, creating the canvas for an empty body, and writing the
// conversation→canvas edge. The container is left only the card placement, which it learns
// from the forwarded pairing header.
describe('handleInboxBridge: attach-canvas — the edge owns the rows (#264)', () => {
  const attach = (body: Record<string, unknown>, convId = 'conv_1') => {
    const subPath = `/api/inbox/${convId}/attach-canvas`;
    return handleInboxBridge(
      new Request(`https://poc.cedarpad.com/inbox/${convId}/bridge${subPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      {} as never,
      user,
      convId,
      subPath,
      mint,
      async () => null,
    );
  };

  test('an existing same-workspace canvas: the edge writes the edge and forwards the pairing', async () => {
    conv = row({ id: 'conv_1', sessionId: 'sess_9', ownerRef: 'chat_owner', workspaceId: 'ws_a', summary: 'Pricing' });
    canvasesById = { cv_board: { id: 'cv_board', workspaceId: 'ws_a' } };

    const res = await attach({ canvasId: 'cv_board' });

    expect(res.status).toBe(200); // proxied to the container, which places the card
    expect(attachCanvasCalls).toEqual([['conv_1', 'cv_board']]);
    expect(servedPairings).toEqual([
      JSON.stringify({ id: 'conv_1', sessionId: 'sess_9', ownerRef: 'chat_owner', canvasId: 'cv_board', summary: 'Pricing' }),
    ]);
  });

  test('a canvas in ANOTHER workspace is still rejected — 400, no edge written, no wake', async () => {
    conv = row({ id: 'conv_1', workspaceId: 'ws_a' });
    canvasesById = { cv_foreign: { id: 'cv_foreign', workspaceId: 'ws_OTHER' } };

    const res = await attach({ canvasId: 'cv_foreign' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'wrong_workspace' });
    expect(attachCanvasCalls).toEqual([]);
    expect(served).toEqual([]);
  });

  test('an empty body creates the canvas in the conversation’s workspace, named from the summary', async () => {
    conv = row({ id: 'conv_1', workspaceId: 'ws_a', summary: 'Explore the pricing model options' });

    const res = await attach({});

    expect(res.status).toBe(200);
    expect(createdCanvases).toEqual([{ workspaceId: 'ws_a', name: 'Explore the pricing model options' }]);
    expect(attachCanvasCalls).toEqual([['conv_1', 'cv_new_1']]);
  });

  test('an already-linked conversation is refused at the edge (409, first-wins) — the runner never wakes', async () => {
    conv = row({ id: 'conv_1', canvasId: 'cv_already' });

    const res = await attach({ canvasId: 'cv_board' });

    expect(res.status).toBe(409);
    expect(attachCanvasCalls).toEqual([]);
    expect(served).toEqual([]);
  });

  test('a client-sent pairing header never survives — the edge overwrites it, and strips it elsewhere', async () => {
    conv = row({ id: 'conv_1', workspaceId: 'ws_a' });
    canvasesById = { cv_board: { id: 'cv_board', workspaceId: 'ws_a' } };
    const forged = JSON.stringify({ id: 'conv_1', sessionId: 's', ownerRef: null, canvasId: 'cv_elsewhere', summary: null });
    const subPath = '/api/inbox/conv_1/attach-canvas';
    const res = await handleInboxBridge(
      new Request(`https://poc.cedarpad.com/inbox/conv_1/bridge${subPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-inbox-canvas-pairing': forged },
        body: JSON.stringify({ canvasId: 'cv_board' }),
      }),
      {} as never,
      user,
      'conv_1',
      subPath,
      mint,
      async () => null,
    );
    await proxy('GET', '/api/chat/chat_1/transcript');

    expect(res.status).toBe(200);
    expect(servedPairings).toEqual([
      JSON.stringify({ id: 'conv_1', sessionId: 's', ownerRef: null, canvasId: 'cv_board', summary: null }),
      null,
    ]);
  });
});

// ADR-0010: the edge mints a short-lived, repo-scoped git token PER dev-agent send and rides
// it on the proxied request as `x-dev-agent-git-token` — the bridge arms `open_pr` for exactly
// that turn. Product sends never mint; reads (GET/alive/interrupt) never mint; a failed mint
// degrades to a token-less send (the turn just has no open_pr), never a blocked reply.
describe('handleInboxBridge: the dev-agent git token is minted onto a proxied send (ADR-0010)', () => {
  test('a dev-agent send carries x-dev-agent-git-token to the owning bridge', async () => {
    conv = row({ kind: DEV_AGENT_KIND });
    await proxy('POST', '/api/chat/chat_home/send');

    expect(mintCalls).toBe(1);
    expect(servedTokens).toEqual(['ghs_minted']);
  });

  test('the send re-mints for the conversation’s OWN repo (conv.repo → x-dev-agent-repo, ADR-0015)', async () => {
    conv = row({ kind: DEV_AGENT_KIND, repo: 'Zabaca/ledgerbot' } as never);
    await proxy('POST', '/api/chat/chat_home/send');

    // The resolver seam echoes the requested repo — conv.repo is what must be requested.
    expect(servedRepos).toEqual(['Zabaca/ledgerbot']);
    expect(servedTokens).toEqual(['ghs_minted']);
  });

  test('a legacy dev-agent row with no repo edge falls back to the workspace’s selection', async () => {
    conv = row({ kind: DEV_AGENT_KIND });
    await proxy('POST', '/api/chat/chat_home/send');

    expect(servedRepos).toEqual(['Zabaca/cedarpad']);
  });

  test('a PRODUCT send never mints — no token header reaches the bridge', async () => {
    conv = row({ workspaceId: 'default' });
    await proxy('POST', '/api/chat/chat_home/send');

    expect(mintCalls).toBe(0);
    expect(servedTokens).toEqual([null]);
  });

  test('a dev-agent transcript GET / alive beat never mints (only a send arms open_pr)', async () => {
    conv = row({ kind: DEV_AGENT_KIND });
    await proxy('GET', '/api/chat/chat_home/transcript');
    await proxy('POST', '/api/alive');

    expect(mintCalls).toBe(0);
    expect(servedTokens).toEqual([null, null]);
  });

  test('a failed mint (null) still proxies the send — token-less, never blocked', async () => {
    conv = row({ kind: DEV_AGENT_KIND });
    mintResult = null;
    const res = await proxy('POST', '/api/chat/chat_home/send');

    expect(res.status).toBe(200);
    expect(mintCalls).toBe(1);
    expect(servedTokens).toEqual([null]);
  });
});

describe('handleInboxBridge: which runner bridge a Conversation is proxied to (coordsForWorkspace)', () => {
  test('a product Conversation (workspaceId `default`) proxies to the legacy/prod container', async () => {
    conv = row({ workspaceId: 'default' });
    await proxy('GET', '/api/chat/chat_home/transcript');
    await settle();

    expect(served).toHaveLength(1);
    expect(served[0]?.sandboxId).not.toBe(DEV_AGENT_KIND);
  });

  test('a dev-agent Conversation resumes on the WARM default container (ADR-0010: a role, not a container)', async () => {
    conv = row({ kind: DEV_AGENT_KIND }); // workspaceId stays 'default' — kind is the type, not a workspace
    await proxy('GET', '/api/chat/chat_home/transcript');
    await settle();

    // The dev-agent is a logical Conversation tag now — its chats resume on the SAME warm
    // container product chats use (no perpetually-cold separate sandbox, no cold boot, no 425).
    // NOT a derived `workspace-dev-agent` container either.
    expect(served).toHaveLength(1);
    expect(served[0]?.sandboxId).toBe(LEGACY_SANDBOX_ID);
    expect(served[0]?.canvasWorkspace).toBe('default');
    expect(served[0]?.r2Prefix).toBe('workspaces/default/');
  });
});

// The chat→canvas edge (canvas pairing): a linked Conversation's SEND is routed to ITS canvas
// store — the edge stamps x-canvas-id from the row, since the Inbox surface (not a pad) sends
// no stamp of its own. Reads never stamp; unlinked conversations proxy untouched.
describe('handleInboxBridge: a linked Conversation’s send carries its canvas to the bridge', () => {
  test('a send for a canvas-linked Conversation stamps x-canvas-id', async () => {
    conv = row({ canvasId: 'cv_home' });
    await proxy('POST', '/api/chat/chat_1/send');
    expect(servedCanvasIds).toEqual(['cv_home']);
  });

  test('an unlinked Conversation’s send carries no x-canvas-id', async () => {
    await proxy('POST', '/api/chat/chat_1/send');
    expect(servedCanvasIds).toEqual([null]);
  });

  test('a transcript GET never stamps (routing the turn, not the read)', async () => {
    conv = row({ canvasId: 'cv_home' });
    await proxy('GET', '/api/chat/chat_1/transcript');
    expect(servedCanvasIds).toEqual([null]);
  });
});

// ADR-0016: a hidden conversation is the same 404 as a missing row on every proxied
// sub-path — its own private flag, or a private linked canvas (canvas dominates).
describe('handleInboxBridge: visibility gate (ADR-0016)', () => {
  test('a private conversation proxies for its creator, 404s for another member', async () => {
    conv = row({ visibility: 'private', createdBy: 'u_1' } as never);
    expect((await proxy('GET', '/api/chat/chat_1/transcript')).status).toBe(200);
    conv = row({ visibility: 'private', createdBy: 'u_2' } as never);
    workspaceMembers = ['u_1', 'u_2'];
    expect((await proxy('GET', '/api/chat/chat_1/transcript')).status).toBe(404);
  });

  test('canvas dominates: a shared chat on someone else’s private canvas 404s — even for the chat’s creator', async () => {
    conv = row({ canvasId: 'cv_priv', createdBy: 'u_1' } as never);
    linkedCanvas = { visibility: 'private', createdBy: 'u_2' };
    expect((await proxy('POST', '/api/chat/chat_1/send')).status).toBe(404);
    expect(served).toEqual([]); // never reached the runner
  });

  test('a workspace-visible linked canvas gates nothing', async () => {
    conv = row({ canvasId: 'cv_open' });
    linkedCanvas = { visibility: 'workspace', createdBy: 'u_2' };
    expect((await proxy('POST', '/api/chat/chat_1/send')).status).toBe(200);
  });
});

// ADR-0013 train 2 (#176): a workspace's connected external-MCP tokens ride the send as a
// single JSON header (server/mcp-registry.ts's MCP_TOKENS_HEADER), mirroring x-dev-agent-git-
// token — edge custody, per-send, never persisted container-side. No connected tokens ⇒ no
// header at all (not connected = no attempt).
describe('handleInboxBridge: the workspace’s external-MCP tokens ride the send (ADR-0013 train 2)', () => {
  test('a connected token attaches x-mcp-tokens to the proxied send', async () => {
    conv = row({ workspaceId: 'ws_a' });
    mcpTokensByWorkspace = { ws_a: { ledgerbot: 'tok_a' } };
    await proxy('POST', '/api/chat/chat_1/send');
    expect(servedMcpTokenHeaders).toEqual([JSON.stringify({ ledgerbot: 'tok_a' })]);
  });

  test('no connected token ⇒ no header at all', async () => {
    conv = row({ workspaceId: 'ws_a' });
    mcpTokensByWorkspace = {};
    await proxy('POST', '/api/chat/chat_1/send');
    expect(servedMcpTokenHeaders).toEqual([null]);
  });

  test('a second workspace is isolated — its send never sees the first workspace’s token', async () => {
    mcpTokensByWorkspace = { ws_a: { ledgerbot: 'tok_a' } };
    conv = row({ workspaceId: 'ws_b' });
    await proxy('POST', '/api/chat/chat_1/send');
    expect(servedMcpTokenHeaders).toEqual([null]);
  });

  test('a transcript GET never attaches the header (routing the turn, not the read)', async () => {
    conv = row({ workspaceId: 'ws_a' });
    mcpTokensByWorkspace = { ws_a: { ledgerbot: 'tok_a' } };
    await proxy('GET', '/api/chat/chat_1/transcript');
    expect(servedMcpTokenHeaders).toEqual([null]);
  });
});
