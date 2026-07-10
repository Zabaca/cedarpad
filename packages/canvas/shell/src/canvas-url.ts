// The canvas stage's selected canvas rides in the URL (query params), same spirit as stage.ts
// and inbox/inbox-url.ts: a reload/back-button lands back on the same open canvas. These are
// pure helpers (parse/serialize) so Shell.tsx's CanvasStage just reads `canvas` on mount and
// calls history.replaceState on change — no popstate handling needed, since replaceState never
// grows back/forward history.

/** The canvas id named by a `location.search`, or `null` when none is selected. */
export function canvasFromUrl(search: string): string | null {
  return new URLSearchParams(search).get('canvas');
}

/** `search` with `id` merged in as `?canvas=<id>` — every other param (`stage`, …) passes
 *  through untouched. Omitted entirely when `id` is `null`, so the URL stays clean. Returns
 *  the full query string (`''` or `?a=b`), ready to append to a pathname. */
export function urlWithCanvas(search: string, id: string | null): string {
  const params = new URLSearchParams(search);

  if (id) params.set('canvas', id);
  else params.delete('canvas');

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
