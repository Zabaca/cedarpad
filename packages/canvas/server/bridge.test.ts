// The /api/chat/:id/send subscribe-before-send wire contract (425 Too Early).
//
// Importing bridge.ts does NOT bind a port (Bun.serve is guarded behind
// `import.meta.main`), so we drive the exported `handleRequest` directly with a
// Request and assert the response. `setChatTurnDispatcher` swaps in a spy so the
// 2xx path never invokes the real agent SDK and we can assert dispatch happened (or,
// on the 425 path, did NOT). `chatClients` is the shared subscriber set the guard
// consults — one connected stream carries every chat, so a single fake controller
// represents "a subscriber exists".

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { type CanvasImage, parseCanvasImages, runChat } from './agent.ts';
import { chatClients, handleRequest, setChatTurnDispatcher, webPocDb } from './bridge.ts';
import { resumeConversation } from './inbox.ts';
import { conversations } from '../web-poc/lib/db/index.ts';
import { DEV_AGENT_WORKSPACE_ID } from './dev-agent-workflow.ts';

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
      workspaceId: DEV_AGENT_WORKSPACE_ID,
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
