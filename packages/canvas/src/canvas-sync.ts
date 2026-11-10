// Where the browser's tldraw sync client connects (ADR-0019).
//
// The pad is served through the edge Worker, and `worker/sync-api.ts` handles
// `/api/canvas-sync/:canvasId/connect` on the SAME origin — so the URI is built from
// the page origin rather than configured. The Worker authorizes the upgrade before any
// Durable Object is addressed; the canvas id in the path is the whole request.

import type { TLAsset, TLAssetStore } from '@tldraw/tlschema';

/** The WebSocket URI of a canvas's sync room, on `origin`. Pure, so it's testable. */
export function syncUri(origin: string, canvasId: string): string {
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = `/api/canvas-sync/${encodeURIComponent(canvasId)}/connect`;
  return u.toString();
}

/** The asset route for one uploaded object. Mirrors `worker/canvas-assets.ts`. */
export function assetUrl(canvasId: string, key: string): string {
  return `/api/canvas-assets/${encodeURIComponent(canvasId)}/${encodeURIComponent(key)}`;
}

// One flat path segment per object: a uuid (so two uploads of the same file never
// collide) plus a sanitised name (so the object is recognisable in the bucket). The
// sanitisation is what makes `assetUrl`'s single-segment shape true — a file called
// `a/b.png` must not become two segments.
function objectKey(newId: () => string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'file';
  return `${newId()}-${safe}`;
}

/**
 * The canvas's asset store: image/video bytes go to R2 behind the Worker
 * (`worker/canvas-assets.ts`) and the tldraw document carries only the URL.
 *
 * This is the ADR-0019 replacement for carrying a base64 data URL in the record. The
 * old plane inlined pixels into `CanvasShape.src`, which the room would now put into DO
 * SQLite and re-broadcast — the exact cost the migration exists to remove.
 *
 * `resolve` is left to tldraw's default (use `asset.props.src`): the URL is same-origin
 * and the Worker authorizes it with the session cookie, so there is nothing to rewrite.
 */
export function createCanvasAssetStore(
  canvasId: string,
  // `fetch` is narrowed to the call shape we use rather than `typeof fetch`: the global
  // carries Bun/Cloudflare extras (`preconnect`) a test double has no business supplying.
  deps: { fetch?: (url: string, init: RequestInit) => Promise<Response>; newId?: () => string } = {},
): TLAssetStore {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  return {
    async upload(_asset: TLAsset, file: File, abortSignal?: AbortSignal) {
      const url = assetUrl(canvasId, objectKey(newId, file.name));
      const res = await doFetch(url, {
        method: 'PUT',
        body: file,
        signal: abortSignal,
        headers: file.type ? { 'content-type': file.type } : undefined,
      });
      // Fail loudly. Returning the src anyway would put a shape on every client's
      // canvas pointing at bytes that were never stored — a broken box nobody can fix.
      if (!res.ok) throw new Error(`asset upload failed: ${res.status}`);
      return { src: url };
    },
  };
}
