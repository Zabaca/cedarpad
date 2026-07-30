// Which page the human is looking at, in the form the write path expects.
//
// The canvas model spells "the first page" as an ABSENT `page` (src/shapes.ts): every
// canvas written before pages were reachable has no page marker, and keeping absence
// meaningful is what lets those canvases round-trip unchanged. So a caller that always
// stamped the current page would rewrite the read shape of nearly every canvas for no
// information gained.

/**
 * The page id to put on a write, given the canvas's pages in tldraw's own order and the
 * page currently open. Undefined for the first page — see above; that is the convention,
 * not a missing value.
 */
export function pageToSend(pageIdsInOrder: readonly string[], currentPageId: string): string | undefined {
  const first = pageIdsInOrder[0];
  return first !== undefined && first !== currentPageId ? currentPageId : undefined;
}

/**
 * The page a reload should open, given what was remembered and what the canvas still has.
 *
 * A remembered page can be GONE — another client can delete it while this tab is closed —
 * so the memory is a request, not an instruction. Undefined means "leave tldraw where it
 * put you": opening some other page because the remembered one vanished would put the
 * human somewhere they never asked for, with no sign that anything was substituted.
 */
export function restorablePage<Id extends string>(remembered: string | null | undefined, availablePageIds: readonly Id[]): Id | undefined {
  // Answering with the id FROM the canvas, rather than the remembered string, is what lets
  // tldraw's branded `TLPageId` flow through without a cast at the call site.
  return availablePageIds.find((id) => id === remembered);
}

/**
 * The key a saved camera hangs off. Per canvas AND per page: tldraw scopes the camera to
 * a page, so a single per-canvas entry restores page one's viewport onto whatever page you
 * reopen — which reads as "it lost my place" even once the right page is restored.
 */
export function cameraKey(canvasId: string, pageId: string): string {
  return `${canvasId}::${pageId}`;
}
