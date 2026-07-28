// The browser's end of ADR-0019: where `useSync` connects, and what it uploads
// images to. Both are pure string builders so they're testable without a DOM.

import { describe, expect, test } from 'bun:test';

import { createCanvasAssetStore, syncUri } from './canvas-sync.ts';

describe('syncUri', () => {
  test('is the worker sync route on the page origin, as a websocket scheme', () => {
    expect(syncUri('https://app.cedarpad.com', 'c1')).toBe('wss://app.cedarpad.com/api/canvas-sync/c1/connect');
    expect(syncUri('http://localhost:4510', 'c1')).toBe('ws://localhost:4510/api/canvas-sync/c1/connect');
  });

  test('escapes the canvas id, so an id can never inject path segments', () => {
    expect(syncUri('https://x.test', 'a/b')).toBe('wss://x.test/api/canvas-sync/a%2Fb/connect');
  });
});

// A `File` stand-in: bun:test has no DOM `File`, and the store only ever reads `.name`
// and hands the value straight to `fetch` as a body.
const fileNamed = (name: string) => ({ name }) as unknown as File;

describe('createCanvasAssetStore', () => {
  test('uploads the file to the canvas asset route and returns that URL as the src', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const store = createCanvasAssetStore('c1', {
      fetch: async (url, init) => {
        calls.push({ url: url as string, init: init as RequestInit });
        return new Response(null, { status: 200 });
      },
      newId: () => 'abc123',
    });

    const { src } = await store.upload({} as never, fileNamed('photo.png'));

    expect(src).toBe('/api/canvas-assets/c1/abc123-photo.png');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/canvas-assets/c1/abc123-photo.png');
    expect(calls[0]!.init.method).toBe('PUT');
  });

  // The whole point of R2 backing: the document carries a short URL, not the pixels.
  // A file name with a slash or a space must not be able to reshape that URL.
  test('sanitises the file name into a single flat path segment', async () => {
    const store = createCanvasAssetStore('c1', {
      fetch: async () => new Response(null, { status: 200 }),
      newId: () => 'abc123',
    });
    const { src } = await store.upload({} as never, fileNamed('a/b c.png'));
    expect(src).toBe('/api/canvas-assets/c1/abc123-a-b-c.png');
  });

  test('a failed upload rejects rather than silently returning a dead src', async () => {
    const store = createCanvasAssetStore('c1', {
      fetch: async () => new Response('nope', { status: 500 }),
      newId: () => 'abc123',
    });
    await expect(store.upload({} as never, fileNamed('photo.png'))).rejects.toThrow(/500/);
  });
});
