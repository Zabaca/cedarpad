import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { GateUser } from './auth-gate.ts';
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
let served: SandboxCoords[] = [];
let servedTokens: Array<string | null> = [];
let servedCanvasIds: Array<string | null> = [];
let servedMcpTokenHeaders: Array<string | null> = [];
let replyCalls: string[] = [];
let mintCalls = 0;
let mintResult: string | null = 'ghs_minted';
let mcpTokensByWorkspace: Record<string, Record<string, string>> = {};

mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
    servedTokens.push(req.headers.get('x-dev-agent-git-token'));
    servedCanvasIds.push(req.headers.get('x-canvas-id'));
    servedMcpTokenHeaders.push(req.headers.get('x-mcp-tokens'));
    return new Response('proxied');
  },
}));
mock.module('../web-poc/lib/db/queries/conversations.ts', () => ({
  get: () => Promise.resolve(conv),
  reply: (_db: unknown, id: string) => {
    replyCalls.push(id);
    return Promise.resolve(conv);
  },
}));
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
  );

// Let the fire-and-forget flip (a microtask) settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  conv = row();
  served = [];
  servedTokens = [];
  servedCanvasIds = [];
  servedMcpTokenHeaders = [];
  replyCalls = [];
  mintCalls = 0;
  mintResult = 'ghs_minted';
  mcpTokensByWorkspace = {};
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

  test('a send for a Conversation the caller does not own is 404 — no flip, no wake', async () => {
    conv = row({ userId: 'someone_else' });
    const res = await proxy('POST', '/api/chat/chat_home/send');
    await settle();

    expect(res.status).toBe(404);
    expect(served).toHaveLength(0);
    expect(replyCalls).toEqual([]);
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
