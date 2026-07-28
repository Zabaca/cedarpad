import { beforeEach, describe, expect, test } from 'bun:test';

import { handleSyncUpgrade, parseSyncPath } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

// The sync upgrade is the ONE door into a canvas's room, so its gate is the whole security
// story of ADR-0019's server half: no session ⇒ no room, and a session that cannot reach
// canvas Y must not be able to open canvas Y's room by naming it in the path. Both run
// against the real handler; only the reachability lookup (a database round trip) is
// injected. Deliberately NOT `mock.module` — bun's module mocks are process-global, and
// stubbing `access.ts` / the db runtime here corrupts every other worker suite in the run.

/** Only `u_1` on `canvas_x` is reachable; everything else fails closed, like the real one. */
const canReach = async (_env: unknown, canvasId: string, userId: string) =>
  userId === 'u_1' && canvasId === 'canvas_x';

/** Records which DO name the handler resolved, so "one room per canvas" is observable. */
let resolvedNames: string[] = [];
const env = {
  CANVAS_SYNC: {
    idFromName(name: string) {
      resolvedNames.push(name);
      return { name };
    },
    get(id: { name: string }) {
      return { fetch: async () => new Response(`room:${id.name}`, { status: 101 }) };
    },
  },
} as never;

const upgrade = (path: string) =>
  new Request(`https://app.cedarpad.com${path}`, { headers: { upgrade: 'websocket' } });

beforeEach(() => {
  resolvedNames = [];
});

describe('parseSyncPath', () => {
  test('matches the connect route and yields the canvas id', () => {
    expect(parseSyncPath('/api/canvas-sync/canvas_x/connect')).toBe('canvas_x');
  });

  test('ignores everything else', () => {
    expect(parseSyncPath('/api/canvas-sync/canvas_x')).toBeNull();
    expect(parseSyncPath('/api/chat/stream')).toBeNull();
  });
});

describe('handleSyncUpgrade', () => {
  test('rejects an unauthenticated upgrade', async () => {
    const res = await handleSyncUpgrade(upgrade('/api/canvas-sync/canvas_x/connect'), env, 'canvas_x', null, canReach);
    expect(res.status).toBe(401);
    // No Durable Object was even addressed: an anonymous request cannot instantiate a room.
    expect(resolvedNames).toEqual([]);
  });

  test("rejects a user authorized for canvas X opening canvas Y's room", async () => {
    const res = await handleSyncUpgrade(
      upgrade('/api/canvas-sync/canvas_y/connect'),
      env,
      'canvas_y',
      { id: 'u_1' },
      canReach,
    );
    expect(res.status).toBe(403);
    expect(resolvedNames).toEqual([]);
  });

  test('routes an authorized upgrade to the canvas-derived room, deterministically', async () => {
    const path = '/api/canvas-sync/canvas_x/connect';
    const one = await handleSyncUpgrade(upgrade(path), env, 'canvas_x', { id: 'u_1' }, canReach);
    await handleSyncUpgrade(upgrade(path), env, 'canvas_x', { id: 'u_1' }, canReach);
    expect(one.status).toBe(101);
    expect(resolvedNames).toEqual([syncRoomName('canvas_x'), syncRoomName('canvas_x')]);
  });
});
