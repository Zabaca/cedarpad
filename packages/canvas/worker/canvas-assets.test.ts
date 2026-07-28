import { describe, expect, test } from 'bun:test';

import { bearer, CANVAS_ASSET_LABEL, CANVAS_SNAPSHOT_LABEL, canvasOperatorToken } from '../shared/canvas-operator-token.ts';
import { REQUEST_BOUND_WINDOW_MS } from '../shared/service-token.ts';
import { handleCanvasAsset, parseAssetPath } from './canvas-assets.ts';

// The canvas asset route is the R2 half of ADR-0019's asset store: image bytes leave the
// tldraw document and live in the bucket. It carries the SAME gate as the sync upgrade —
// the canvas comes from the path, so naming someone else's canvas must be refused — and
// it self-gates for the same reason: an `<img>` cannot act on the login page at 200.
const canReach = async (_env: unknown, canvasId: string, userId: string) =>
  userId === 'u_1' && canvasId === 'canvas_x';

function bucketStub() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    bucket: {
      get: async (key: string) => {
        const v = objects.get(key);
        return v === undefined ? null : { arrayBuffer: async () => v.buffer as ArrayBuffer };
      },
      put: async (key: string, body: ArrayBuffer) => {
        objects.set(key, new Uint8Array(body));
      },
    },
  };
}

const SECRET = 'test-secret-at-least-32-characters-long!!';
const env = (b: ReturnType<typeof bucketStub>) => ({ MART_BUCKET: b.bucket, BETTER_AUTH_SECRET: SECRET }) as never;
const user = { id: 'u_1' } as never;

describe('parseAssetPath', () => {
  test('matches the asset route and yields the canvas id and object key', () => {
    expect(parseAssetPath('/api/canvas-assets/canvas_x/abc-photo.png')).toEqual({ canvasId: 'canvas_x', key: 'abc-photo.png' });
  });

  test('ignores everything else — including a nested key, which the client never mints', () => {
    expect(parseAssetPath('/api/canvas-assets/canvas_x')).toBeNull();
    expect(parseAssetPath('/api/canvas-assets/canvas_x/a/b.png')).toBeNull();
    expect(parseAssetPath('/api/canvas-sync/canvas_x/connect')).toBeNull();
  });
});

describe('handleCanvasAsset', () => {
  test('PUT stores the bytes under a canvas-scoped key, and GET reads them back', async () => {
    const b = bucketStub();
    const put = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_x/k.png', { method: 'PUT', body: new Uint8Array([1, 2, 3]) }),
      env(b),
      { canvasId: 'canvas_x', key: 'k.png' },
      user,
      canReach,
    );
    expect(put.status).toBe(200);
    // Canvas-scoped so one canvas's assets can never be addressed through another's id.
    expect([...b.objects.keys()]).toEqual(['canvas-assets/canvas_x/k.png']);

    const got = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_x/k.png'),
      env(b),
      { canvasId: 'canvas_x', key: 'k.png' },
      user,
      canReach,
    );
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('a missing object is a 404, not an empty 200', async () => {
    const b = bucketStub();
    const res = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_x/nope.png'),
      env(b),
      { canvasId: 'canvas_x', key: 'nope.png' },
      user,
      canReach,
    );
    expect(res.status).toBe(404);
  });

  test('no session ⇒ 401, before the bucket is touched', async () => {
    const b = bucketStub();
    const res = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_x/k.png', { method: 'PUT', body: new Uint8Array([1]) }),
      env(b),
      { canvasId: 'canvas_x', key: 'k.png' },
      null,
      canReach,
    );
    expect(res.status).toBe(401);
    expect(b.objects.size).toBe(0);
  });

  test('a session that cannot reach the canvas named in the path ⇒ 403', async () => {
    const b = bucketStub();
    const res = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_y/k.png', { method: 'PUT', body: new Uint8Array([1]) }),
      env(b),
      { canvasId: 'canvas_y', key: 'k.png' },
      user,
      canReach,
    );
    expect(res.status).toBe(403);
    expect(b.objects.size).toBe(0);
  });

  test('anything but GET/PUT is refused', async () => {
    const b = bucketStub();
    const res = await handleCanvasAsset(
      new Request('https://x.test/api/canvas-assets/canvas_x/k.png', { method: 'DELETE' }),
      env(b),
      { canvasId: 'canvas_x', key: 'k.png' },
      user,
      canReach,
    );
    expect(res.status).toBe(405);
  });
});

// #329: the migration's asset uploads travel with the snapshot load, which now runs from
// the environment rather than from a session cookie — and `canReachCanvas` could never
// serve that run anyway, since the operator need not be a member of every workspace that
// owns a canvas. Own label, so a snapshot token is not an asset token.
describe('handleCanvasAsset — the operator principal', () => {
  const put = (b: ReturnType<typeof bucketStub>, token: string, canvas = 'canvas_y') =>
    handleCanvasAsset(
      new Request(`https://x.test/api/canvas-assets/${canvas}/k.png`, { method: 'PUT', body: 'bytes', headers: bearer(token) }),
      env(b),
      { canvasId: canvas, key: 'k.png' },
      null,
      canReach,
    );

  test('uploads to a canvas the caller could never REACH as a member', async () => {
    const b = bucketStub();
    const res = await put(b, await canvasOperatorToken(SECRET, CANVAS_ASSET_LABEL, 'canvas_y'));
    expect(res.status).toBe(200);
    expect(b.objects.get('canvas-assets/canvas_y/k.png')).toBeDefined();
  });

  test('rejects a SNAPSHOT-label token — the two doors do not share a credential', async () => {
    const b = bucketStub();
    const res = await put(b, await canvasOperatorToken(SECRET, CANVAS_SNAPSHOT_LABEL, 'canvas_y'));
    expect(res.status).toBe(401);
    expect(b.objects.size).toBe(0);
  });

  test('rejects a token minted for a different canvas', async () => {
    const b = bucketStub();
    const res = await put(b, await canvasOperatorToken(SECRET, CANVAS_ASSET_LABEL, 'canvas_x'));
    expect(res.status).toBe(401);
    expect(b.objects.size).toBe(0);
  });

  test('rejects an expired token, naming skew', async () => {
    const b = bucketStub();
    const stale = await canvasOperatorToken(SECRET, CANVAS_ASSET_LABEL, 'canvas_y', Date.now() - REQUEST_BOUND_WINDOW_MS - 1000);
    const res = await put(b, stale);
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/SKEW/);
    expect(b.objects.size).toBe(0);
  });
});
