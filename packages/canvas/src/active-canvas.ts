// Which canvas the frontend is addressing. The edge sets a NON-HttpOnly `cs_canvas`
// cookie when you open `/w/:ws/canvas/:id` (see worker/index.ts); we read it here and
// stamp it onto every bridge call so the single bridge routes to the right per-canvas
// CanvasStore (#53). Absent selection ⇒ `default`, so today's un-namespaced calls are
// byte-for-byte preserved.

/** The canvas-selection cookie (mirrors worker/shell-routing.ts CANVAS_COOKIE). */
export const CANVAS_COOKIE = 'cs_canvas';

/** The default canvas id (mirrors component-loader / worker DEFAULT_CANVAS_ID). */
export const DEFAULT_CANVAS_ID = 'default';

/** Read `cs_canvas` from a raw cookie header string, or null when unset. Pure, so the
 *  selection logic is unit-testable without a document. */
export function readCanvasCookie(cookieHeader: string | null): string | null {
  for (const c of (cookieHeader ?? '').split(/;\s*/)) {
    const [k, ...v] = c.split('=');
    if (k === CANVAS_COOKIE && v.length) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** The selected canvas id from the browser's cookies, or `default` when unset. */
export function activeCanvasId(): string {
  const raw = typeof document === 'undefined' ? null : document.cookie;
  return readCanvasCookie(raw) ?? DEFAULT_CANVAS_ID;
}

/** Merge the `x-canvas-id` selection header into a bridge fetch's headers. */
export function withCanvasHeader(headers?: HeadersInit): Record<string, string> {
  return { ...(headers as Record<string, string> | undefined), 'x-canvas-id': activeCanvasId() };
}

/** Append `?canvas=<id>` to a stream URL (EventSource can't send headers). */
export function withCanvasParam(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}canvas=${encodeURIComponent(activeCanvasId())}`;
}
