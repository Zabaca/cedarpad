// What survives on the canvas SSE stream after ADR-0019 moved the DOCUMENT onto tldraw
// sync, and #293 moved PRESENCE onto sync's own channel: the agent's screenshot
// round-trip. It is not carried by the sync protocol, so it may not vanish with
// `sync.ts`. It is also the leg with logic worth pinning: the agent's `view_canvas` tool
// blocks on a reply, so EVERY path — including "nothing on the canvas" and "rendering
// threw" — must answer.

import { describe, expect, test } from 'bun:test';

import { respondToScreenshot } from './canvas-stream.ts';

describe('respondToScreenshot', () => {
  test('renders the canvas and replies with the data URL, tagged with the request id', async () => {
    const replies: Array<{ id: string; url: string | null }> = [];
    await respondToScreenshot(JSON.stringify({ id: 'req1' }), async () => 'data:image/png;base64,AAA', (id, url) => {
      replies.push({ id, url });
    });
    expect(replies).toEqual([{ id: 'req1', url: 'data:image/png;base64,AAA' }]);
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
