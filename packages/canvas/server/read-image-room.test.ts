// `read_image`, end to end (#340): a real sync room holding a real tldraw image shape →
// the `/mutate` read path (`readShapes`) → the container's remote store → the tool body →
// the edge's real asset door → the bucket.
//
// WHY THIS FILE EXISTS AT ALL. There was already a test asserting `imageSrcOf` returns a
// data URL, and it passed the whole time the feature was broken in production, because it
// seeded the store BY HAND — on the tool side of the seam where the bug lived. `readShapes`
// never resolved the image's asset record, so the agent saw `src: ''`. Nothing that seeds a
// store by hand can catch that. So the only fixture here is the ROOM, seeded the way a
// browser seeds it (an asset record plus a shape that points at it by `assetId`), and every
// hop after that is the production code path.

import { describe, expect, test } from 'bun:test';

import { readImageOp, readOp } from '../src/canvas-ops.ts';
import { verifyCanvasAssetReadToken } from '../shared/canvas-asset-read.ts';
import { CanvasMutation } from '../shared/canvas-mutation.ts';
import { applyMutation } from '../worker/canvas-mutate.ts';
import { createCanvasSyncRoom } from '../worker/sync-room.ts';
import { canvasAssetFetcher, canvasRoomOpener } from './canvas-room.ts';

const SECRET = 'test-secret-at-least-32-characters-long!!';
const ORIGIN = 'https://edge.test';
const CANVAS = 'canvas_x';
const KEY = 'abc-shot.png';
const PIXELS = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Seed the room the way the BROWSER does when a screenshot is pasted: the pixels go to an
 *  asset record, and the image shape carries only `assetId`. There is no agent-write path
 *  that authors an image, so this is the one faithful way in. */
async function seedRoom(src: string) {
  const room = createCanvasSyncRoom();
  await room.updateStore((ctx) => {
    ctx.put({
      id: 'asset:pic',
      typeName: 'asset',
      type: 'image',
      props: { name: 'shot.png', src, w: 200, h: 100, mimeType: 'image/png', isAnimated: false, fileSize: PIXELS.length },
      meta: {},
    } as never);
    ctx.put({
      id: 'shape:pic',
      typeName: 'shape',
      type: 'image',
      parentId: 'page:page',
      index: 'a1',
      rotation: 0,
      isLocked: false,
      opacity: 1,
      x: 10,
      y: 20,
      meta: {},
      props: { w: 200, h: 100, assetId: 'asset:pic', playing: true, url: '', crop: null, flipX: false, flipY: false, altText: 'a screenshot' },
    } as never);
  });
  return room;
}

/** The edge, as far as the container can tell: the `/mutate` door onto the real room, and
 *  the asset door onto a bucket.
 *
 *  `/mutate` is the PRODUCTION handler — that is the seam the bug lived in. The asset door
 *  is a stand-in that enforces the one thing this test is about (the container's own
 *  credential, and nothing else authenticates: the container holds no session); the real
 *  door's behaviour on that credential is covered in `worker/canvas-assets.test.ts`, which
 *  is where the Workers-runtime types belong. */
function fakeEdge(room: Awaited<ReturnType<typeof seedRoom>>) {
  const objects = new Map<string, Uint8Array>([[`${CANVAS}/${KEY}`, PIXELS]]);

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(String(url), init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/mutate')) {
      return Response.json(await applyMutation(room, CanvasMutation.parse(await request.json())));
    }
    const asset = /^\/api\/canvas-assets\/(.+)$/.exec(path)?.[1];
    if (!asset) return new Response('not found', { status: 404 });
    const presented = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!(await verifyCanvasAssetReadToken(SECRET, presented))) return new Response('unauthorized', { status: 401 });
    const bytes = objects.get(decodeURIComponent(asset));
    return bytes ? new Response(bytes.buffer as ArrayBuffer) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, objects };
}

const config = (fetchImpl: typeof fetch) => ({ origin: ORIGIN, secret: SECRET, fetchImpl });

describe('read_image over the real room + asset doors', () => {
  test('an asset-URL image reaches the agent as actual pixels', async () => {
    const room = await seedRoom(`/api/canvas-assets/${CANVAS}/${KEY}`);
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);

    // The seam the bug lived in: the shape came out of the room carrying only an assetId,
    // and `readShapes` has to resolve it or everything downstream sees an empty src.
    expect(store.getState().shapes.find((s) => s.id === 'shape:pic')).toMatchObject({
      type: 'image',
      src: `/api/canvas-assets/${CANVAS}/${KEY}`,
      alt: 'a screenshot',
    });

    const res = await readImageOp(store, 'shape:pic', canvasAssetFetcher(config(fetchImpl)));
    expect(res).toEqual({ image: { data: Buffer.from(PIXELS).toString('base64'), mimeType: 'image/png' }, text: 'Image shape shape:pic.' });
  });

  test('a legacy inline data URL still works, without touching the asset door', async () => {
    const room = await seedRoom('data:image/jpeg;base64,QUJD');
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);

    const res = await readImageOp(store, 'shape:pic', async () => {
      throw new Error('the data URL path must not fetch');
    });
    expect(res).toEqual({ image: { data: 'QUJD', mimeType: 'image/jpeg' }, text: 'Image shape shape:pic.' });
  });

  test('read_canvas still REDACTS the pixels — resolving the pointer did not start dumping images into context', async () => {
    const room = await seedRoom(`/api/canvas-assets/${CANVAS}/${KEY}`);
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);

    const text = readOp(store).text;
    expect(text).not.toContain('/api/canvas-assets/');
    expect(text).toContain('call read_image(\\"shape:pic\\") to view');
    // ...and the rest of the image's state is intact, which is what makes the marker useful.
    expect(text).toContain('"alt": "a screenshot"');
  });

  test('a shape that is not an image is refused by name', async () => {
    const room = await seedRoom(`/api/canvas-assets/${CANVAS}/${KEY}`);
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);
    expect(await readImageOp(store, 'shape:nope', canvasAssetFetcher(config(fetchImpl)))).toMatchObject({ isError: true });
  });

  test('an asset the bucket does not hold surfaces the edge status, not a silent blank', async () => {
    const room = await seedRoom(`/api/canvas-assets/${CANVAS}/gone.png`);
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);
    const res = await readImageOp(store, 'shape:pic', canvasAssetFetcher(config(fetchImpl)));
    expect(res).toMatchObject({ isError: true });
    expect((res as { text: string }).text).toContain('404');
  });

  test('a src that is not the asset route is never fetched — the room is writable by any member', async () => {
    const room = await seedRoom('https://evil.test/steal');
    const { fetchImpl } = fakeEdge(room);
    const store = await canvasRoomOpener(config(fetchImpl))(CANVAS);
    const reached: string[] = [];
    const spy = (async (url: string | URL | Request, init?: RequestInit) => {
      reached.push(String(url));
      return fetchImpl(url as never, init);
    }) as unknown as typeof fetch;

    const res = await readImageOp(store, 'shape:pic', canvasAssetFetcher(config(spy)));
    expect(res).toMatchObject({ isError: true });
    expect(reached).toEqual([]);
  });
});
