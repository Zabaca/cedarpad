// MCP's read_image and view_canvas, at the bridge: the two routes the edge proxies to.
//
// read_image runs the in-canvas agent's own `readImageOp` against the room the request
// names. view_canvas is the in-canvas agent's browser round-trip, driven here through the
// REAL stream and reply routes — the subscriber is a stand-in browser that answers the
// `screenshot` frame the way src/canvas-stream.ts does.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { RemoteCanvasStore } from '../src/remote-store.ts';
import type { CanvasShape } from '../src/shapes.ts';
import { createStore } from '../src/store.ts';
import { handleRequest, setCanvasRoomOpener } from './bridge.ts';

const PIC = { id: 'shape:pic', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:image/png;base64,iVBOR' } as unknown as CanvasShape;

const openerWith = (byCanvas: Record<string, CanvasShape[]>) => async (canvasId: string): Promise<RemoteCanvasStore> => {
  const store = createStore(byCanvas[canvasId] ?? []);
  return { ...store, flush: async () => {} } as unknown as RemoteCanvasStore;
};

describe('GET /api/canvas/image', () => {
  beforeEach(() => setCanvasRoomOpener(openerWith({ canvasA: [PIC] })));
  afterEach(() => setCanvasRoomOpener(null));

  const get = (canvasId: string, id: string) =>
    handleRequest(new Request(`http://localhost/api/canvas/image?id=${encodeURIComponent(id)}`, { headers: { 'x-canvas-id': canvasId } }));

  test('answers with the image shape\'s pixels from the canvas the request names', async () => {
    const res = await get('canvasA', 'shape:pic');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: 'iVBOR', mimeType: 'image/png' });
  });

  test('the same shape id on another canvas is not found — the room is the request\'s, never a guess', async () => {
    const res = await get('canvasB', 'shape:pic');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain('No image data');
  });
});

describe('POST /api/canvas/view', () => {
  const CANVAS = `view-${Math.random().toString(36).slice(2, 8)}`;
  const view = (body: unknown) =>
    handleRequest(
      new Request('http://localhost/api/canvas/view', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-canvas-id': CANVAS },
        body: JSON.stringify(body),
      }),
    );

  test('with no tab open it answers url: null instead of hanging', async () => {
    const res = await view({});
    expect(await res.json()).toEqual({ url: null });
  });

  test('round-trips through an open tab, carrying the page it was asked for', async () => {
    const stream = await handleRequest(new Request(`http://localhost/api/canvas/stream?canvas=${CANVAS}`));
    const reader = stream.body!.getReader();
    const asked: Array<{ id: string; pageId?: string }> = [];

    // The stand-in browser: read frames until the screenshot ask, then POST the reply.
    const browser = (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value);
        const m = /event: screenshot\ndata: (.+)\n/.exec(buf);
        if (!m) continue;
        const frame = JSON.parse(m[1]!) as { id: string; pageId?: string };
        asked.push(frame);
        await handleRequest(
          new Request(`http://localhost/api/canvas/screenshot?canvas=${CANVAS}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: frame.id, url: 'data:image/png;base64,AAAA' }),
          }),
        );
        return;
      }
    })();

    const res = await view({ pageId: 'page:two' });
    await browser;
    await reader.cancel();
    expect(await res.json()).toEqual({ url: 'data:image/png;base64,AAAA' });
    expect(asked[0]?.pageId).toBe('page:two');
  });

  test('a malformed body is a 400, not a screenshot of some default', async () => {
    expect((await view({ pageId: '' })).status).toBe(400);
  });
});
