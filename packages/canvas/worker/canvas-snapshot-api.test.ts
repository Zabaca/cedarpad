import { describe, expect, test } from 'bun:test';

import {
  bearer,
  CANVAS_ASSET_LABEL,
  CANVAS_SNAPSHOT_LABEL,
  canvasOperatorToken,
  OPERATOR_PRINCIPAL,
} from '../shared/canvas-operator-token.ts';
import { REQUEST_BOUND_WINDOW_MS } from '../shared/service-token.ts';
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
    BETTER_AUTH_SECRET: SECRET,
  } as unknown as Env;
  return { env, names, seen };
}

const SECRET = 'test-secret-at-least-32-characters-long!!';

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

// The SECOND principal (#329): an operator token derived from BETTER_AUTH_SECRET, so the
// migration script can run from the environment instead of a pasted session cookie. It is
// request-bound — one canvas, one label, one short window — because a static derivation is
// revocable only by rotating the secret, which logs out everyone.
describe('handleCanvasSnapshot — the operator principal', () => {
  const op = (canvas: string, label = CANVAS_SNAPSHOT_LABEL, now?: number) =>
    canvasOperatorToken(SECRET, label, canvas, now);

  test('admits a caller holding a valid operator token, with NO session at all', async () => {
    const { env, names, seen } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url, { headers: bearer(await op('c1')) }), env, 'c1', null, isAdmin);
    expect(res.status).toBe(200);
    expect(names).toEqual([syncRoomName('c1')]);
    // #333: the Durable Object refuses a /snapshot with no identity. The operator is
    // stamped like any other principal — never client-supplied.
    expect(seen[0]?.headers.get(SYNC_USER_HEADER)).toBe(OPERATOR_PRINCIPAL);
  });

  test('rejects a token minted under a DIFFERENT label — key separation, not a shared bearer', async () => {
    const { env, names } = fakeNamespace();
    const token = await op('c1', CANVAS_ASSET_LABEL);
    const res = await handleCanvasSnapshot(new Request(url, { headers: bearer(token) }), env, 'c1', null, isAdmin);
    expect(res.status).toBe(401);
    expect(names).toEqual([]);
  });

  test('rejects a token minted for a DIFFERENT canvas — it cannot be replayed sideways', async () => {
    const { env, names } = fakeNamespace();
    const res = await handleCanvasSnapshot(new Request(url, { headers: bearer(await op('c2')) }), env, 'c1', null, isAdmin);
    expect(res.status).toBe(401);
    expect(names).toEqual([]);
  });

  test('rejects an EXPIRED token, and says SKEW so it is not debugged as an auth bug', async () => {
    const { env, names } = fakeNamespace();
    const stale = await op('c1', CANVAS_SNAPSHOT_LABEL, Date.now() - REQUEST_BOUND_WINDOW_MS - 1000);
    const res = await handleCanvasSnapshot(new Request(url, { headers: bearer(stale) }), env, 'c1', null, isAdmin);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/SKEW/);
    expect(names).toEqual([]);
  });

  test('does NOT imply force: a POST without ?force=1 reaches the room without one', async () => {
    const { env, seen } = fakeNamespace();
    const init = { method: 'POST', body: '{"documents":[]}', headers: bearer(await op('c1')) };
    const res = await handleCanvasSnapshot(new Request(url, init), env, 'c1', null, isAdmin);
    expect(res.status).toBe(200);
    // The room's non-empty guard (worker/snapshot-io.ts) is the thing that must still bite,
    // and it bites on this parameter. A service credential must never supply it.
    expect(new URL(seen[0]?.url ?? '').searchParams.has('force')).toBe(false);
  });

  test('an unsigned bearer is 401, and without a secret no operator token can admit anyone', async () => {
    const { env, names } = fakeNamespace();
    const junk = await handleCanvasSnapshot(new Request(url, { headers: bearer('garbage') }), env, 'c1', null, isAdmin);
    expect(junk.status).toBe(401);
    const noSecret = { ...(env as object), BETTER_AUTH_SECRET: undefined } as unknown as Env;
    const res = await handleCanvasSnapshot(new Request(url, { headers: bearer(await op('c1')) }), noSecret, 'c1', null, isAdmin);
    expect(res.status).toBe(401);
    expect(names).toEqual([]);
  });
});
