// What is LEFT of the canvas SSE stream after ADR-0019.
//
// The document no longer travels here — `useSync` owns it, over a WebSocket to the
// canvas's Durable Object (src/canvas-sync.ts). ONE rider on this stream is not part of
// the sync protocol and would have vanished with `sync.ts`, so it moved here instead:
//
//   - the agent's screenshot round-trip (`view_canvas`): the bridge asks, the browser
//     renders a PNG with tldraw and POSTs it back. `/api/canvas/screenshot` is explicitly
//     not part of the sync plane (#297).
//   - `select_page`: the bridge moves THIS viewer's editor to a page. Which page you are
//     looking at is per-client tldraw instance state, not document state, so it cannot
//     travel over sync — the whole point is that it moves one person and not the others.
//
// Presence used to be the second rider; #293 moved it onto the sync protocol's own
// presence channel, which is where it belongs. One rider left is not a reason to fold
// this module away — the screenshot round-trip still needs a stream from the bridge.
//
// The idle gate and the recovery wrapper come along for the same reason they existed: an
// always-open EventSource auto-reconnects, which re-wakes a slept CF container. That is
// still true of this stream, because this stream still hits the bridge. (The sync
// WebSocket does not — it terminates at the edge Worker, so it cannot pin the container.)

import type { Editor } from 'tldraw';

import { registerStream } from './idle';
import { createRecoveringStream } from './stream-recovery';
import { withCanvasHeader, withCanvasParam } from './active-canvas';

const API = '/api';

/**
 * Answer one `screenshot` frame. Extracted from the stream wiring and Editor-free so the
 * every-path-replies rule is testable: the agent's tool call BLOCKS on this reply, so a
 * dropped one is a hung turn, not a missing image.
 *
 * The one case that must NOT reply is a frame with no id — there is nothing to answer.
 */
export async function respondToScreenshot(
  data: string,
  render: () => Promise<string | null>,
  reply: (id: string, url: string | null) => void,
): Promise<void> {
  let id: string;
  try {
    const parsed = JSON.parse(data) as { id?: unknown };
    if (typeof parsed.id !== 'string') return;
    id = parsed.id;
  } catch {
    return;
  }
  try {
    reply(id, await render());
  } catch {
    reply(id, null);
  }
}

/**
 * Move this editor to a page the bridge named. Editor-free and separately testable for the
 * same reason `respondToScreenshot` is, minus the reply: nothing downstream blocks on this,
 * so the whole failure budget is "the human's view did not move".
 *
 * A page id this browser does not have is IGNORED, not an error to surface. The frame and
 * the tldraw store arrive over two different transports (this SSE stream and the sync
 * socket), so a page created moments ago can legitimately be named before this client has
 * synced it — a transient race, not a bug worth shouting about.
 */
export function respondToSelectPage(data: string, setPage: (pageId: string) => void, hasPage: (pageId: string) => boolean): void {
  let pageId: string;
  try {
    const parsed = JSON.parse(data) as { pageId?: unknown };
    if (typeof parsed.pageId !== 'string') return;
    pageId = parsed.pageId;
  } catch {
    return;
  }
  if (hasPage(pageId)) setPage(pageId);
}

/** Render the whole current page as a PNG data URL, or null when there is nothing on it. */
async function renderCanvasPng(editor: Editor): Promise<string | null> {
  const ids = [...editor.getCurrentPageShapeIds()];
  if (ids.length === 0) return null;
  const { url } = await editor.toImageDataUrl(ids, { format: 'png', background: true, padding: 24 });
  return url;
}

/** Open the canvas SSE stream and keep the screenshot leg alive. */
export function wireCanvasStream(editor: Editor): () => void {
  const postScreenshot = (id: string, url: string | null) => {
    void fetch(`${API}/canvas/screenshot`, {
      method: 'POST',
      headers: withCanvasHeader({ 'content-type': 'application/json' }),
      body: JSON.stringify({ id, url }),
    }).catch(() => {});
  };

  const stream = createRecoveringStream(() => {
    const es = new EventSource(withCanvasParam(`${API}/canvas/stream`));
    es.addEventListener('screenshot', (e) => {
      void respondToScreenshot((e as MessageEvent).data as string, () => renderCanvasPng(editor), postScreenshot);
    });
    es.addEventListener('page', (e) => {
      respondToSelectPage(
        (e as MessageEvent).data as string,
        (pageId) => editor.setCurrentPage(pageId as Parameters<Editor['setCurrentPage']>[0]),
        (pageId) => editor.getPages().some((p) => p.id === pageId),
      );
    });
    return es;
  });
  stream.open();
  const unregisterIdle = registerStream(stream);

  return () => {
    unregisterIdle();
    stream.close();
  };
}
