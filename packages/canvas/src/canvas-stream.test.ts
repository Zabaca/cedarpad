// What survives on the canvas SSE stream after ADR-0019 moved the DOCUMENT onto tldraw
// sync, and #293 moved PRESENCE onto sync's own channel: the agent's screenshot
// round-trip. It is not carried by the sync protocol, so it may not vanish with
// `sync.ts`. It is also the leg with logic worth pinning: the agent's `view_canvas` tool
// blocks on a reply, so EVERY path — including "nothing on the canvas" and "rendering
// threw" — must answer.

import { describe, expect, test } from 'bun:test';

import { respondToScreenshot, respondToSelectPage } from './canvas-stream.ts';

describe('respondToScreenshot', () => {
  test('renders the canvas and replies with the data URL, tagged with the request id', async () => {
    const replies: Array<{ id: string; url: string | null }> = [];
    await respondToScreenshot(JSON.stringify({ id: 'req1' }), async () => 'data:image/png;base64,AAA', (id, url) => {
      replies.push({ id, url });
    });
    expect(replies).toEqual([{ id: 'req1', url: 'data:image/png;base64,AAA' }]);
  });

  test('hands the frame\'s page to the renderer, and no page when the frame names none', async () => {
    const asked: Array<string | undefined> = [];
    const render = async (pageId?: string) => (asked.push(pageId), 'data:image/png;base64,AAA');
    await respondToScreenshot(JSON.stringify({ id: 'p1', pageId: 'page:two' }), render, () => {});
    await respondToScreenshot(JSON.stringify({ id: 'p2' }), render, () => {});
    expect(asked).toEqual(['page:two', undefined]);
  });

  // An empty canvas is a legitimate answer, not a hang: the renderer returns null and we
  // still reply, so the agent's tool call completes with "nothing to show".
  test('replies null when there is nothing to render', async () => {
    const replies: Array<{ id: string; url: string | null }> = [];
    await respondToScreenshot(JSON.stringify({ id: 'req2' }), async () => null, (id, url) => replies.push({ id, url }));
    expect(replies).toEqual([{ id: 'req2', url: null }]);
  });

  test('a renderer that throws still produces a reply, so the agent never blocks forever', async () => {
    const replies: Array<{ id: string; url: string | null }> = [];
    await respondToScreenshot(
      JSON.stringify({ id: 'req3' }),
      async () => {
        throw new Error('toImageDataUrl exploded');
      },
      (id, url) => replies.push({ id, url }),
    );
    expect(replies).toEqual([{ id: 'req3', url: null }]);
  });

  // A malformed frame has no id to reply to — replying would answer the WRONG request.
  test('a frame with no usable id is dropped silently', async () => {
    const replies: unknown[] = [];
    await respondToScreenshot('not json', async () => 'x', () => replies.push(1));
    await respondToScreenshot(JSON.stringify({ nope: true }), async () => 'x', () => replies.push(1));
    expect(replies).toEqual([]);
  });
});

// The second rider (`select_page`). Unlike the screenshot leg nothing blocks on this, so
// the tests are about what it must NOT do: act on a frame it cannot trust, or on a page
// this client has not synced yet.
describe('respondToSelectPage', () => {
  const has = (ids: string[]) => (id: string) => ids.includes(id);

  test('switches to the page the bridge named', () => {
    const moved: string[] = [];
    respondToSelectPage(JSON.stringify({ pageId: 'page:two' }), (p) => moved.push(p), has(['page:page', 'page:two']));
    expect(moved).toEqual(['page:two']);
  });

  // The frame and the tldraw store arrive over DIFFERENT transports (this SSE stream and
  // the sync socket), so a page created moments ago can be named before this client has
  // it. Calling setCurrentPage on an unknown id is what throws inside tldraw.
  test('ignores a page this client has not synced yet rather than throwing', () => {
    const moved: string[] = [];
    expect(() => respondToSelectPage(JSON.stringify({ pageId: 'page:ghost' }), (p) => moved.push(p), has(['page:page']))).not.toThrow();
    expect(moved).toEqual([]);
  });

  test('a malformed frame moves nothing', () => {
    const moved: string[] = [];
    respondToSelectPage('not json', (p) => moved.push(p), () => true);
    respondToSelectPage(JSON.stringify({ nope: true }), (p) => moved.push(p), () => true);
    expect(moved).toEqual([]);
  });
});
