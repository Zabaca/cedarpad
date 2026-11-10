import { describe, expect, test } from 'bun:test';

import { canvasAssetReadToken, verifyCanvasAssetReadToken } from './canvas-asset-read.ts';
import { canvasMutateToken, verifyCanvasMutateToken } from './canvas-mutation.ts';
import { platformRpcToken, verifyPlatformRpcToken } from './platform-rpc.ts';
import { serviceToken } from './service-token.ts';
import { workspaceKey } from './workspace-key.ts';

const SECRET = 'test-secret-at-least-32-characters-long!!';

// #374: the bearers a container presents used to be constants of the deployment, so a
// container for one workspace could name another's. They are now derived from a key that
// exists only per workspace.
describe('workspaceKey', () => {
  test('is the same for one workspace and different for another', async () => {
    expect(await workspaceKey(SECRET, 'ws_a')).toBe(await workspaceKey(SECRET, 'ws_a'));
    expect(await workspaceKey(SECRET, 'ws_a')).not.toBe(await workspaceKey(SECRET, 'ws_b'));
  });

  test('depends on the secret', async () => {
    expect(await workspaceKey(SECRET, 'ws_a')).not.toBe(await workspaceKey(`${SECRET}x`, 'ws_a'));
  });

  test('is not any surface bearer, so it cannot be replayed as one', async () => {
    const key = await workspaceKey(SECRET, 'ws_a');
    for (const bearer of [await platformRpcToken(SECRET), await canvasMutateToken(SECRET), await canvasAssetReadToken(SECRET)]) {
      expect(key).not.toBe(bearer);
    }
  });

  test('is not the secret and does not contain it', async () => {
    expect(await workspaceKey(SECRET, 'ws_a')).not.toContain(SECRET);
  });

  // The prefix is fixed and the id is everything after it, so no two ids share a message.
  test('two ids that only differ at the end do not collide', async () => {
    expect(await workspaceKey(SECRET, 'ws_a')).not.toBe(await workspaceKey(SECRET, 'ws_a:'));
  });

  // A pinned value, so the derivation cannot drift between the edge (which derives to verify)
  // and a container (whose key the edge handed it at boot). Both are deployed pieces.
  test('still produces the same bytes', async () => {
    expect(await serviceToken(SECRET, 'workspace-key/v1:default')).toBe(await workspaceKey(SECRET, 'default'));
    expect(await workspaceKey(SECRET, 'default')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('a bearer derived from one workspace key verifies only against that workspace', () => {
  test('platform RPC', async () => {
    const keyA = await workspaceKey(SECRET, 'ws_a');
    const keyB = await workspaceKey(SECRET, 'ws_b');
    const bearer = await platformRpcToken(keyA);
    expect(await verifyPlatformRpcToken(keyA, bearer)).toBe(true);
    expect(await verifyPlatformRpcToken(keyB, bearer)).toBe(false);
  });

  test('canvas mutation', async () => {
    const keyA = await workspaceKey(SECRET, 'ws_a');
    const keyB = await workspaceKey(SECRET, 'ws_b');
    const bearer = await canvasMutateToken(keyA);
    expect(await verifyCanvasMutateToken(keyA, bearer)).toBe(true);
    expect(await verifyCanvasMutateToken(keyB, bearer)).toBe(false);
  });

  test('asset read', async () => {
    const keyA = await workspaceKey(SECRET, 'ws_a');
    const keyB = await workspaceKey(SECRET, 'ws_b');
    const bearer = await canvasAssetReadToken(keyA);
    expect(await verifyCanvasAssetReadToken(keyA, bearer)).toBe(true);
    expect(await verifyCanvasAssetReadToken(keyB, bearer)).toBe(false);
  });

  test('the old constant bearer, derived straight from the secret, verifies against no workspace key', async () => {
    const legacy = await platformRpcToken(SECRET);
    expect(await verifyPlatformRpcToken(await workspaceKey(SECRET, 'ws_a'), legacy)).toBe(false);
    expect(await verifyPlatformRpcToken(await workspaceKey(SECRET, 'default'), legacy)).toBe(false);
  });
});
