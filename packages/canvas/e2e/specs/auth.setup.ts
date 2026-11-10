import { OWNER_STATE, expect, test as setup } from '../fixtures/test.ts';

/**
 * The `setup` project (#276): create the ONE user that owns what the bridge files, and park
 * its session for the `owner` fixture. Every other project depends on this, so it runs first
 * and alone.
 *
 * Alone is the point. `joinBridgeWorkspace` writes the live D1, and D1's write lock admits a
 * single writer — an external write landing mid-request makes the EDGE's write fail, which
 * surfaces as a sign-up 422 or a `conversation.start failed: 500` somewhere else entirely.
 * Seeding per test made ~25% of a 4-worker run fail that way; one serialized seed does not.
 */
setup('seed the user who owns the bridge’s workspace', async ({ signIn, joinBridgeWorkspace, promoteToAdmin }) => {
  const user = await signIn();
  await joinBridgeWorkspace(user);
  // …and is the migration OPERATOR too (#321): the snapshot door is admin-gated. Same
  // one-writer rule, so it happens here rather than in the spec that needs it.
  await promoteToAdmin(user);

  // Prove the seed took before anything depends on it: the workspace is now the user's.
  const res = await user.request.get('/api/workspaces');
  expect(res.status()).toBe(200);
  expect((await res.json()) as { workspaces: Array<{ id: string }> }).toHaveProperty('workspaces');

  await user.request.storageState({ path: OWNER_STATE });
});
