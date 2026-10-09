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

import type { Editor, TLPageId, TLShapeId } from 'tldraw';

import { ScreenshotTarget } from '../shared/bridge-wire';
import { registerStream } from './idle';
import { createRecoveringStream } from './stream-recovery';
import { withCanvasHeader, withCanvasParam } from './active-canvas';

const API = '/api';

/**
 * Answer one `screenshot` frame. Extracted from the stream wiring and Editor-free so the
 * every-path-replies rule is testable: the agent's tool call BLOCKS on this reply, so a
 * dropped one is a hung turn, not a missing image.
 *
 * The one case that must NOT reply is a frame with no id — there is nothing to answer. A
 * frame whose target is off-contract still has an id, so it gets a null rather than a hang.
 */
export async function respondToScreenshot(
  data: string,
  render: (target: ScreenshotTarget) => Promise<string | null>,
  reply: (id: string, url: string | null) => void,
): Promise<void> {
  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(data) as { id?: unknown };
  } catch {
    return;
  }
  if (typeof parsed.id !== 'string') return;
  const id = parsed.id;
  const target = ScreenshotTarget.safeParse(parsed);
  if (!target.success) return reply(id, null);
  try {
    reply(id, await render(target.data));
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

/** Longest edge of the PNG, in pixels. A page full of pasted screenshots rendered at full
 *  size came back as 8–13 MB and missed the bridge's deadline in transit; a model downsizes
 *  past roughly this anyway, so anything larger is bytes nobody sees. */
export const SCREENSHOT_MAX_EDGE = 2000;

/** How far a small export is enlarged. A single sticky note or card is a few hundred page
 *  units across, and at 1:1 its text is too small to read. */
export const SCREENSHOT_MAX_UPSCALE = 2;

/** The export scale that fits `bounds` inside SCREENSHOT_MAX_EDGE, enlarging a small export
 *  up to SCREENSHOT_MAX_UPSCALE. */
export function screenshotScale(bounds: { w: number; h: number } | null): number {
  const edge = bounds ? Math.max(bounds.w, bounds.h) : 0;
  return edge > 0 ? Math.min(SCREENSHOT_MAX_UPSCALE, SCREENSHOT_MAX_EDGE / edge) : 1;
}

/** The shapes a target names: its `ids` that exist here, else a whole page — the named one,
 *  else the current one. A page this client has not synced yet is empty, like select_page's
 *  leg. */
function targetShapeIds(editor: Editor, target: ScreenshotTarget): TLShapeId[] {
  if (target.ids) return (target.ids as TLShapeId[]).filter((id) => editor.getShape(id));
  if (target.pageId && !editor.getPages().some((p) => p.id === target.pageId)) return [];
  return [...(target.pageId ? editor.getPageShapeIds(target.pageId as TLPageId) : editor.getCurrentPageShapeIds())];
}

/** Render a target as a PNG data URL, or null when it names nothing. Exporting by id never
 *  moves this viewer's own view. */
async function renderCanvasPng(editor: Editor, target: ScreenshotTarget): Promise<string | null> {
  const ids = targetShapeIds(editor, target);
  if (ids.length === 0) return null;
  // pixelRatio 1: tldraw's bitmap default is 2, which doubles both edges for no reader.
  const scale = screenshotScale(editor.getShapesPageBounds(ids));
  const { url } = await editor.toImageDataUrl(ids, { format: 'png', background: true, padding: 24, scale, pixelRatio: 1 });
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
      void respondToScreenshot((e as MessageEvent).data as string, (target) => renderCanvasPng(editor, target), postScreenshot);
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
