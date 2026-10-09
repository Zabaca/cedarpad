// Which canvas the frontend is addressing. The Render Pad is served AT its own URL,
// `/w/:ws/canvas/:id/pad` (see worker/index.ts); we read the id back off the pathname and
// stamp it onto every bridge call so the single bridge routes to the right per-canvas
// CanvasStore (#53). The URL — not a browser-global cookie — carries the selection, so an
// iframed pad is self-describing and two tabs can hold two canvases (#105). Absent
// selection ⇒ `default`, so today's un-namespaced calls are byte-for-byte preserved.

import { CANVAS_ID_HEADER } from '../shared/bridge-wire.ts';

/** The default canvas id (mirrors component-loader / worker DEFAULT_CANVAS_ID). */
export const DEFAULT_CANVAS_ID = 'default';

/** The canvas id out of a pad pathname (mirrors worker/shell-routing.ts parsePadRoute),
 *  or null when this isn't a pad URL. Pure, so the selection logic is unit-testable. */
export function canvasIdFromPath(pathname: string): string | null {
  return /^\/w\/[^/]+\/canvas\/([^/]+)\/pad\/?$/.exec(pathname)?.[1] ?? null;
}

/** The selected canvas id from the pad's own URL, or `default` when it isn't a pad URL. */
export function activeCanvasId(): string {
  const path = typeof window === 'undefined' ? null : window.location.pathname;
  return (path && canvasIdFromPath(path)) || DEFAULT_CANVAS_ID;
}

/** The workspace id out of a pad pathname (`/w/:ws/canvas/:id/pad`), or null when this
 * isn't a pad URL (e.g. a guest surface). */
export function workspaceIdFromPath(pathname: string): string | null {
  return /^\/w\/([^/]+)\/canvas\/[^/]+\/pad\/?$/.exec(pathname)?.[1] ?? null;
}

/** The active workspace id from the pad's own URL, or `default` when it isn't a pad URL
 * (mirrors activeCanvasId's fallback convention). */
export function activeWorkspaceId(): string {
  const path = typeof window === 'undefined' ? null : window.location.pathname;
  return (path && workspaceIdFromPath(path)) || DEFAULT_CANVAS_ID;
}

/** Merge the `x-canvas-id` selection header into a bridge fetch's headers. */
export function withCanvasHeader(headers?: HeadersInit): Record<string, string> {
  return { ...(headers as Record<string, string> | undefined), [CANVAS_ID_HEADER]: activeCanvasId() };
}

/** `x-canvas-id` for CHAT calls: stamped only when this surface IS a pad. The chat-store is
 * shared with non-pad surfaces (the Inbox thread), where a defaulted stamp would falsely
 * claim the Default canvas as the chat's home — the chat→canvas edge is a claim, not a
 * fallback, so absence must mean "no canvas". */
export function withPadCanvasHeader(headers?: HeadersInit): Record<string, string> {
  const path = typeof window === 'undefined' ? null : window.location.pathname;
  const id = path ? canvasIdFromPath(path) : null;
  const base = { ...(headers as Record<string, string> | undefined) };
  return id ? { ...base, [CANVAS_ID_HEADER]: id } : base;
}

/** Append `?canvas=<id>` to a stream URL (EventSource can't send headers). */
export function withCanvasParam(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}canvas=${encodeURIComponent(activeCanvasId())}`;
}
