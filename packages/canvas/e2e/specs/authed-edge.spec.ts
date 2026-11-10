import { expect, test } from '../fixtures/test.ts';

/**
 * The paths that only exist BEHIND the edge's gate (ADR-0018 / #276).
 *
 * This spec signs in for real (`signIn`, see fixtures/test.ts) and drives the edge Worker's
 * own origin, so the gate and the edge→bridge proxy are exercised as one live path.
 *
 * Nothing about auth is stubbed. The single `E2E_MODE` shim in play is the container
 * stand-in — local dev runs no container, so `serveWorkspace` proxies to the bridge process
 * (worker/sandbox-resolver.ts `localBridgeOrigin`). It sits DOWNSTREAM of every check asserted
 * here, so it papers over none of them.
 */

test('the edge gate admits a signed-in user and refuses an anonymous one', async ({ signIn, edgeRequest }) => {
  // `/api/workspaces` is served BY the edge (worker/shell.ts), so this is the gate itself
  // answering — not a container, and not vite, which never proxies this path locally.
  expect((await edgeRequest.get('/api/workspaces')).status()).toBe(401);

  const user = await signIn();
  const res = await user.request.get('/api/workspaces');
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty('workspaces');
});

test('a chat send through the edge reaches the bridge', async ({ owner }) => {
  const chatId = `e2e-authed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // `x-headless-send` is the subscriber-less send, so a request-only spec can start a turn; the
  // Claude SDK turn itself is the one stubbed thing (`E2E_MODE`, see server/bridge.ts).
  const res = await owner.post(`/api/chat/${chatId}/send`, {
    headers: { 'x-headless-send': '1' },
    data: { message: `first message ${chatId}` },
  });
  expect(res.status()).toBe(202);
});
