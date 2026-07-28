import { expect, test } from '../fixtures/test.ts';

/**
 * Opening a conversation, against the REAL running bridge (ADR-0018 / #261).
 *
 * `GET /api/inbox/:id/chat` is the route the Inbox's third pane hits (through the edge chat
 * proxy) to resolve a Conversation to the chatId its <ChatView> subscribes to. Since #261 the
 * bridge no longer reads the Conversation from the platform data layer — the edge, which
 * already resolved and ownership-checked the row, forwards it on `x-inbox-conversation`.
 *
 * This spec drives the live dev stack (vite → bun bridge on the worktree's derived port), so
 * it exercises the container half of that seam for real: routing, header parsing, transcript
 * restore, ChatMeta seeding, and the JSON response.
 *
 * SCOPE NOTE: this spec drives the bridge DIRECTLY, stamping the header itself. Since #263 the
 * harness does start the edge Worker (on the worktree's derived port) — but there is still no
 * auth fixture (see .claude/skills/worktree/SKILL.md), so the edge's own legs — the ownership
 * check and the stamping of this header — remain covered by worker/inbox-bridge.test.ts rather
 * than here. Driving this route through the edge needs a seeded Better Auth session: the
 * deferred Shell-flow work, deliberately not bundled into either slice.
 */

const forwarded = (conv: unknown) => ({ 'x-inbox-conversation': JSON.stringify(conv) });

test('opening a conversation resolves its chatId from the forwarded row', async ({ request }) => {
  // Unique per run so repeat runs never collide in this worktree's dev DB — and deliberately
  // NEVER created there: a row that does not exist still opens, which is the whole point.
  const id = `e2e-conv-${Date.now()}`;

  const res = await request.get(`/api/inbox/${id}/chat`, {
    headers: forwarded({ id, sessionId: `e2e-sess-${Date.now()}`, ownerRef: 'chat_e2e_owner' }),
  });

  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ chatId: 'chat_e2e_owner' });
});

test('a forged or missing forwarded row is rejected — the header is parsed, not trusted', async ({ request }) => {
  const id = `e2e-conv-guard-${Date.now()}`;

  const absent = await request.get(`/api/inbox/${id}/chat`);
  const offContract = await request.get(`/api/inbox/${id}/chat`, { headers: forwarded({ id, ownerRef: null }) });
  const mismatched = await request.get(`/api/inbox/${id}/chat`, {
    headers: forwarded({ id: 'some-other-conversation', sessionId: 's', ownerRef: null }),
  });

  expect([absent.status(), offContract.status(), mismatched.status()]).toEqual([404, 404, 404]);
});
