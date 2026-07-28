import { describe, expect, test } from 'bun:test';

import { canvasRoomOpener } from './canvas-room.ts';
import { canvasMutateToken } from '../shared/canvas-mutation.ts';

const SECRET = 'test-secret';
const ORIGIN = 'https://edge.test';

/** A room that answers every op with the same empty state, recording what it was sent. */
function fakeEdge() {
  const calls: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ version: 7, shapes: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('canvasRoomOpener', () => {
  test('opens a store on the canvas\'s room, presenting the container service bearer', async () => {
    const { calls, fetchImpl } = fakeEdge();
    const open = canvasRoomOpener({ origin: ORIGIN, secret: SECRET, fetchImpl });
    const store = await open('canvas-1');

    expect(store.getState().version).toBe(7);
    expect(calls[0]?.url).toBe(`${ORIGIN}/api/canvas-sync/canvas-1/mutate`);
    expect(calls[0]?.auth).toBe(`Bearer ${await canvasMutateToken(SECRET)}`);
    expect(calls[0]?.body).toEqual({ op: 'read' });
  });

  test('an unconfigured bridge fails loudly rather than writing somewhere nobody reads', async () => {
    const open = canvasRoomOpener({ origin: undefined, secret: SECRET });
    await expect(open('canvas-1')).rejects.toThrow(/no edge origin/i);
  });
});
