import { describe, expect, test } from 'bun:test';

import { handleCanvasSnapshot, parseCanvasSnapshotPath } from './canvas-snapshot-api.ts';
import type { Env } from './index.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

// Importing a snapshot REPLACES a canvas's whole document, so this door is gated harder
// than `/connect` and `/mutate`: admin-only. The role lookup is injected for the same
// reason `canReach` is in the other two.

/** A DO namespace that records what reached the stub — the same seam the other two
 *  doors' tests use, so the gate is testable without a Durable Object. */
function fakeNamespace() {
  const names: string[] = [];
  const seen: Request[] = [];
  const env = {
    CANVAS_SYNC: {
      idFromName: (n: string) => {
        names.push(n);
        return n;
      },
      get: () => ({
        fetch: async (r: Request) => {
          seen.push(r);
          return new Response('{"documents":[]}', { status: 200 });
        },
      }),
    },
  } as unknown as Env;
  return { env, names, seen };
}

const isAdmin = async (_env: Env, userId: string) => userId === 'root';
const url = 'https://app.test/api/canvas-sync/c1/snapshot';

describe('parseCanvasSnapshotPath', () => {
  test('matches the snapshot route only', () => {
    expect(parseCanvasSnapshotPath('/api/canvas-sync/c1/snapshot')).toBe('c1');
    expect(parseCanvasSnapshotPath('/api/canvas-sync/c1/connect')).toBeNull();
    expect(parseCanvasSnapshotPath('/api/canvas-sync/c1/mutate')).toBeNull();
  });
});

describe('handleCanvasSnapshot', () => {
  test('rejects an unauthenticated caller with 401, before any Durable Object is addressed', async () => {
    const { env, names } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url), env, 'c1', null, isAdmin);
    expect(res.status).toBe(401);
    expect(names).toEqual([]);
  });

  test('rejects a signed-in NON-admin with 403, before any Durable Object is addressed', async () => {
    const { env, names } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url), env, 'c1', { id: 'u_1' }, isAdmin);
    expect(res.status).toBe(403);
    expect(names).toEqual([]);
  });

  test('rejects a method that is neither GET nor POST', async () => {
    const { env, names } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url, { method: 'DELETE' }), env, 'c1', { id: 'root' }, isAdmin);
    expect(res.status).toBe(405);
    expect(names).toEqual([]);
  });

  test('routes an admin to the SAME canvas-derived room the other two doors use', async () => {
    const { env, names, seen } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url), env, 'c1', { id: 'root' }, isAdmin);
    expect(res.status).toBe(200);
    expect(names).toEqual([syncRoomName('c1')]);
    expect(seen[0]?.headers.get(SYNC_USER_HEADER)).toBe('root');
  });

  test('forwards a POST body untouched — the snapshot is the document, not a narrow contract', async () => {
    const { env, seen } = fakeNamespace();
    const body = JSON.stringify({ documents: [{ state: { id: 'shape:a' }, lastChangedClock: 0 }] });
    await handleCanvasSnapshot(
      new Request(`${url}?force=1`, { method: 'POST', body }),
      env,
      'c1',
      { id: 'root' },
      isAdmin,
    );
    expect(await seen[0]?.text()).toBe(body);
    // `?force=1` has to survive the hop: it is the only way past the room's non-empty guard.
    expect(new URL(seen[0]?.url ?? '').searchParams.get('force')).toBe('1');
  });
});
