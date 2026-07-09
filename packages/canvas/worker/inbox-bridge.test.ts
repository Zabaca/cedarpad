import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { GateUser } from './auth-gate.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';

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
let replyCalls: string[] = [];

mock.module('@cloudflare/sandbox', () => ({ Sandbox: class {} }));
mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('./sandbox-runtime.ts', () => ({
  serveWorkspace: (_req: Request, _env: unknown, coords: SandboxCoords) => {
    served.push(coords);
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
    workspaceId: 'default',
    userId: 'u_1',
    summary: null,
    lastMessagePreview: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...o,
  }) as ConversationRow;

// Drive the proxy exactly as worker/index.ts does: the routing prefix already stripped to `subPath`.
const proxy = (method: string, subPath: string, convId = 'conv_1') =>
  handleInboxBridge(
    new Request(`https://poc.cedarpad.com/inbox/${convId}/bridge${subPath}`, { method }),
    {} as never,
    user,
    convId,
    subPath,
  );

// Let the fire-and-forget flip (a microtask) settle before asserting.
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  conv = row();
  served = [];
  replyCalls = [];
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
