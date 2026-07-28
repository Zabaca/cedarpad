// What is LEFT of the bridge's per-canvas SSE plane after ADR-0019 (#297).
//
// The canvas document does not travel over this stream any more — it lives in the
// canvas's Durable-Object-hosted TLSocketRoom, and every browser reads it over the sync
// WebSocket (src/canvas-sync.ts). The old `CanvasSession` — an in-memory CanvasStore, its
// R2 persistence, its save-health, and a full-state rebroadcast on every edit — is gone
// with the rest of the hand-rolled sync plane.
//
// ONE rider on that stream was never part of the sync protocol and would have vanished
// with it: the agent's screenshot round-trip (`view_canvas`). The bridge asks the browser
// for a PNG over SSE; the browser renders it with tldraw and POSTs it back, correlated by
// id. That needs a stream FROM the bridge (the sync socket terminates at the edge Worker
// and never reaches this process), so it keeps one — carrying `screenshot` frames and
// nothing else. The browser half is `src/canvas-stream.ts`.

import { sseEvent } from './sse.ts';

/** The screenshot round-trip for ONE canvas: its SSE subscribers plus the ask/answer pair. */
export interface ScreenshotChannel {
  readonly canvasId: string;
  /** Subscribed browsers. Also the /api/status client count and the idle-reaper's signal. */
  readonly clients: Set<ReadableStreamDefaultController>;
  /** Ask the browser for a PNG; resolves null if nobody is connected or it times out. */
  requestScreenshot(timeoutMs?: number): Promise<string | null>;
  /** Resolve a pending screenshot (the browser POSTs the PNG back, correlated by id). */
  resolveScreenshot(id: string, url: string | null): void;
}

export function createScreenshotChannel(canvasId: string): ScreenshotChannel {
  const clients = new Set<ReadableStreamDefaultController>();
  let shotSeq = 0;
  const pendingShots = new Map<string, (url: string | null) => void>();

  function requestScreenshot(timeoutMs = 7000): Promise<string | null> {
    if (clients.size === 0) return Promise.resolve(null);
    const id = `shot${(shotSeq += 1)}`;
    const frame = sseEvent('screenshot', { id });
    for (const c of clients) {
      try {
        c.enqueue(frame);
      } catch {
        clients.delete(c);
      }
    }
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

  return { canvasId, clients, requestScreenshot, resolveScreenshot };
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
