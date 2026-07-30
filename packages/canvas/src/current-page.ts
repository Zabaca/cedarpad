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

/**
 * The shapes on one page, for a reader that asked for one.
 *
 * This exists because a whole canvas is too big to hand an agent: an unfiltered read of a
 * busy board overruns the MCP response limit, and the workaround agents found for
 * themselves — dump it to a file and read the file back — costs a round trip and still
 * reads everything.
 *
 * `page` undefined means "no filter", which is what every existing caller does, so their
 * answer is unchanged.
 *
 * @throws when `page` names a page the canvas does not have. Answering an empty list would
 * be indistinguishable from the page being empty, and the write path already refuses an
 * unknown page for the same reason (worker/canvas-mutate.ts).
 */
export function shapesOnPage<S extends { page?: string }>(
  shapes: readonly S[],
  pages: readonly { id: string; name: string }[],
  page: string | undefined,
): S[] {
  if (!page) return [...shapes];
  if (!pages.some((p) => p.id === page)) {
    throw new Error(`no page "${page}" on this canvas — it has ${pages.map((p) => `${p.id} (${p.name})`).join(', ')}`);
  }
  // ABSENT MEANS THE FIRST PAGE, so page one has to collect the unmarked shapes as well as
  // the ones naming it — otherwise it reads as empty on every canvas predating pages.
  const isFirst = pages[0]?.id === page;
  return shapes.filter((s) => s.page === page || (isFirst && s.page === undefined));
}
