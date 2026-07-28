import { createClient } from '@libsql/client';

import { requireLocalD1File } from '../../server/local-d1.ts';
import type { APIRequestContext } from '@playwright/test';

import { expect, test } from '../fixtures/test.ts';

/**
 * The paths that only exist BEHIND the edge's gate (ADR-0018 / #276).
 *
 * The other three specs each documented the same hole: with no authenticated fixture they had
 * to prove their behaviour below the UI — driving the bridge directly and stamping the
 * forwarded header themselves. This one signs in for real (`signIn`, see fixtures/test.ts) and
 * drives the edge Worker's own origin, so the legs that were unit-only get exercised as one
 * live path: the session gate, the Conversation ownership check (#261), and the
 * container→edge platform RPC hop (#262, #266).
 *
 * Nothing about auth is stubbed. The single `E2E_MODE` shim in play is the container
 * stand-in — local dev runs no container, so `serveWorkspace` proxies to the bridge process
 * (worker/sandbox-resolver.ts `localBridgeOrigin`). It sits DOWNSTREAM of every check asserted
 * here, so it papers over none of them.
 */

/** The local D1 the EDGE serves the platform data layer from. Read-only: a witness, not a writer. */
const platformDb = () => createClient({ url: `file:${requireLocalD1File()}` });

/**
 * Start a real chat turn as `user`, THROUGH THE EDGE, and return the Conversation it filed.
 *
 * Every hop is real: the edge gates the request on the session, proxies it to the bridge, the
 * turn asks the edge for its Conversation over the platform RPC, and the edge writes the row
 * into D1. The container holds no database (#266), so the row's existence proves the hop.
 * `x-headless-send` is the subscriber-less send the MCP surface uses (#177), so a request-only
 * spec can start a turn; the Claude SDK turn itself is the one stubbed thing (`E2E_MODE`, see
 * server/bridge.ts) because it needs a real OAuth token and a model round-trip.
 */
async function startConversation(user: APIRequestContext): Promise<{ id: string; chatId: string; message: string }> {
  const chatId = `e2e-authed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const message = `first message ${chatId}`;

  const res = await user.post(`/api/chat/${chatId}/send`, {
    headers: { 'x-headless-send': '1' },
    data: { message },
  });
  expect(res.status()).toBe(202);

  // The turn is fire-and-forget: poll the platform data layer until the edge lands its row.
  const db = platformDb();
  let id: string | null = null;
  try {
    await expect
      .poll(
        async () => {
          try {
            const rows = await db.execute({
              sql: 'select id, summary from conversations where owner_ref = ?',
              args: [chatId],
            });
            const row = rows.rows[0] as { id: string; summary: string } | undefined;
            id = row?.id ?? null;
            return row?.summary ?? null;
          } catch {
            // SQLITE_BUSY: the edge is mid-write on the same file — just poll again.
            return null;
          }
        },
        { timeout: 15_000, message: 'the chat turn never filed its Conversation' },
      )
      .toBe(message);
  } finally {
    db.close();
  }
  return { id: id!, chatId, message };
}

test('the edge gate admits a signed-in user and refuses an anonymous one', async ({ signIn, edgeRequest }) => {
  // `/api/workspaces` is served BY the edge (worker/shell.ts), so this is the gate itself
  // answering — not a container, and not vite, which never proxies this path locally.
  expect((await edgeRequest.get('/api/workspaces')).status()).toBe(401);

  const user = await signIn();
  const res = await user.request.get('/api/workspaces');
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty('workspaces');
});

test('a chat turn driven through the edge files its Conversation over the real RPC hop', async ({ owner }) => {
  const conv = await startConversation(owner);

  // Filed, and visible to its owner through the edge's OWN Inbox read — the same row, read
  // back through the gate rather than out of the file the spec just polled.
  const inbox = await owner.get('/api/inbox');
  const items = ((await inbox.json()) as { items: Array<{ id: string; summary: string }> }).items;
  expect(items.find((i) => i.id === conv.id)?.summary).toBe(conv.message);
});

test('a user cannot open a Conversation they do not own', async ({ owner, signIn }) => {
  const conv = await startConversation(owner);

  // A second real account, signed in, with no membership of the Conversation's workspace.
  const stranger = await signIn();

  // The route the Inbox's third pane hits to resolve a Conversation to its chatId (#261).
  const path = `/inbox/${conv.id}/bridge/api/inbox/${conv.id}/chat`;

  const denied = await stranger.request.get(path);
  // Indistinguishable from a missing row (worker/access.ts fails closed), and it never reached
  // the container: the edge answered.
  expect(denied.status()).toBe(404);

  const allowed = await owner.get(path);
  expect(allowed.status()).toBe(200);
  // The edge resolved the row, ownership-checked it, and forwarded it on `x-inbox-conversation`
  // for the bridge to answer from — the seam open-conversation.spec.ts can only stamp by hand.
  expect(await allowed.json()).toEqual({ chatId: conv.chatId });
});
