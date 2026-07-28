import { describe, expect, test } from 'bun:test';

import type { Env } from './index.ts';
import { handleCanvasMutate, parseCanvasMutatePath } from './canvas-mutate-api.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';

const post = (body: unknown) =>
  new Request('https://app.test/api/canvas-sync/c1/mutate', { method: 'POST', body: JSON.stringify(body) });

/** A DO namespace that records what reached the stub, so the gate can be tested without
 *  a Durable Object (the same seam `handleSyncUpgrade`'s tests use). */
function fakeNamespace() {
  const seen: Request[] = [];
  const env = {
    CANVAS_SYNC: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (r: Request) => {
          seen.push(r);
          return new Response('{"version":1,"shapes":[]}', { status: 200 });
        },
      }),
    },
  } as unknown as Env;
  return { env, seen };
}

describe('parseCanvasMutatePath', () => {
  test('matches the mutate route only', () => {
    expect(parseCanvasMutatePath('/api/canvas-sync/c1/mutate')).toBe('c1');
    expect(parseCanvasMutatePath('/api/canvas-sync/c1/connect')).toBeNull();
  });
});

describe('handleCanvasMutate', () => {
  test('rejects an unauthenticated caller with 401, before any Durable Object is addressed', async () => {
    const { env, seen } = fakeNamespace();
    const res = await handleCanvasMutate(post({ op: 'read' }), env, 'c1', null, async () => true);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('rejects a caller who cannot reach this canvas with 403', async () => {
    const { env, seen } = fakeNamespace();
    const res = await handleCanvasMutate(post({ op: 'read' }), env, 'c1', { id: 'u1' } as never, async () => false);
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  test('stamps the authorized user and forwards to the room', async () => {
    const { env, seen } = fakeNamespace();
    const res = await handleCanvasMutate(post({ op: 'read' }), env, 'c1', { id: 'u1' } as never, async () => true);
    expect(res.status).toBe(200);
    expect(seen[0]?.headers.get(SYNC_USER_HEADER)).toBe('u1');
  });

  test('a malformed payload is a 400 that never reaches the room', async () => {
    const { env, seen } = fakeNamespace();
    const res = await handleCanvasMutate(post({ op: 'upsert', shapes: [{ id: 'shape:a' }] }), env, 'c1', { id: 'u1' } as never, async () => true);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('type') });
    expect(seen).toHaveLength(0);
  });
});
