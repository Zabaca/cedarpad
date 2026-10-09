// The bridge's per-canvas SSE plane — what is LEFT of it after ADR-0019 (#297), plus the
// one thing that has since been added to it.
//
// The canvas document does not travel over this stream. It lives in the canvas's
// Durable-Object-hosted TLSocketRoom, and every browser reads it over the sync WebSocket
// (src/canvas-sync.ts). The old `CanvasSession` — an in-memory CanvasStore, its R2
// persistence, its save-health, and a full-state rebroadcast on every edit — is gone with
// the rest of the hand-rolled sync plane.
//
// What travels here is everything that has to reach a browser and is NOT part of the sync
// protocol. The sync socket terminates at the edge Worker and never reaches this process,
// so anything the BRIDGE needs to say to a browser needs a stream of its own:
//
//   - `screenshot`: the agent's `view_canvas` round-trip (the in-canvas agent's and the MCP
//     tool's). The bridge asks for a PNG, the browser renders it with tldraw and POSTs it
//     back, correlated by id.
//   - `page`: move this viewer's editor to a page. Fire-and-forget — there is no reply to
//     correlate, because nothing downstream blocks on the human's screen having moved.
//
// WHY SUBSCRIBERS CARRY AN IDENTITY: `page` is addressed at ONE person. A canvas is a
// shared surface — several members and any number of guests may hold a stream at once —
// and moving all of them because one of them asked is an action nobody else consented to.
// So a subscriber is a controller plus the edge's answer to "who is this", and a `page`
// fan-out filters on it.
//
// The identity is PRESENTATION-ONLY and must never gate anything (see CANVAS_VIEWER_HEADER
// in shared/bridge-wire.ts). It is also frequently ABSENT — a guest's per-browser id lives
// in localStorage and never reaches the edge. Absent is never a wildcard, in either
// direction: an unidentified subscriber is never targeted, and a fan-out with no viewer
// targets nobody. Both halves fail closed, so the worst outcome is that nothing moves.

import { sseEvent } from './sse.ts';

/** One subscribed browser: its stream, and who the edge said it belongs to (null for a
 *  guest, or anyone the edge could not name). */
export interface CanvasSubscriber {
  controller: ReadableStreamDefaultController;
  viewer: string | null;
}

/** The bridge→browser channel for ONE canvas: its SSE subscribers and the frames it sends. */
export interface ScreenshotChannel {
  readonly canvasId: string;
  /** Subscribed browsers. Also the /api/status client count and the idle-reaper's signal. */
  readonly clients: Set<CanvasSubscriber>;
  /** Ask the browser for a PNG; resolves null if nobody is connected or it times out.
   *  `pageId` renders that page; without it, whatever page the answering tab is on. */
  requestScreenshot(timeoutMs?: number, pageId?: string): Promise<string | null>;
  /** Resolve a pending screenshot (the browser POSTs the PNG back, correlated by id). */
  resolveScreenshot(id: string, url: string | null): void;
  /**
   * Ask `viewer`'s open editors to switch to `pageId`. A null viewer matches nobody at all
   * (never everybody).
   *
   * Returns how many streams the frame was ENQUEUED TO — which is delivery, NOT application.
   * This leg is fire-and-forget by design, and the browser still declines a page it has not
   * synced yet (`respondToSelectPage`), so a non-zero answer means "N views were asked", not
   * "N views changed". Callers must phrase it that way; 0 is the only fully certain fact
   * here, and it means nobody was even asked.
   */
  selectPage(pageId: string, viewer: string | null): number;
}

export function createScreenshotChannel(canvasId: string): ScreenshotChannel {
  const clients = new Set<CanvasSubscriber>();
  let shotSeq = 0;
  const pendingShots = new Map<string, (url: string | null) => void>();

  /** Enqueue onto every subscriber `match` accepts, dropping the ones whose stream is
   *  already dead. Returns how many actually took the frame. */
  const fanOut = (frame: Uint8Array, match: (s: CanvasSubscriber) => boolean): number => {
    let sent = 0;
    for (const sub of clients) {
      if (!match(sub)) continue;
      try {
        sub.controller.enqueue(frame);
        sent += 1;
      } catch {
        clients.delete(sub);
      }
    }
    return sent;
  };

  function requestScreenshot(timeoutMs = 7000, pageId?: string): Promise<string | null> {
    if (clients.size === 0) return Promise.resolve(null);
    const id = `shot${(shotSeq += 1)}`;
    // Every subscriber: a screenshot is a question about the CANVAS, not about a person,
    // and the first browser to answer resolves it.
    fanOut(sseEvent('screenshot', pageId ? { id, pageId } : { id }), () => true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingShots.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingShots.set(id, (url) => {
        clearTimeout(timer);
        pendingShots.delete(id);
        resolve(url);
      });
    });
  }

  function resolveScreenshot(id: string, url: string | null): void {
    pendingShots.get(id)?.(url);
  }

  function selectPage(pageId: string, viewer: string | null): number {
    if (!viewer) return 0;
    return fanOut(sseEvent('page', { pageId }), (s) => s.viewer === viewer);
  }

  return { canvasId, clients, requestScreenshot, resolveScreenshot, selectPage };
}

/**
 * A lazy keyed registry, one channel per canvasId — built on first access and reused
 * thereafter, so a canvasId maps to exactly one subscriber set. This is the surviving
 * half of `createSessionRegistry`: the keying, without the store it used to key.
 */
export function createScreenshotChannels() {
  const map = new Map<string, ScreenshotChannel>();
  return {
    get(canvasId: string): ScreenshotChannel {
      let c = map.get(canvasId);
      if (!c) {
        c = createScreenshotChannel(canvasId);
        map.set(canvasId, c);
      }
      return c;
    },
    /** Channels built so far — the total connected-client count for /api/status. */
    built(): ScreenshotChannel[] {
      return [...map.values()];
    },
  };
}
