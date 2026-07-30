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
