// ADR-0016: canvas visibility — the ONE effective-visibility predicate, pure. Every
// surface (canvas registry API, pad routes, MCP tools) answers "can U see this canvas?"
// through `canvasHiddenFrom`.

/** The slice of a canvas row the predicate reads. */
export interface CanvasVisibilitySlice {
  visibility: 'workspace' | 'private';
  createdBy: string | null;
}

/** Is this canvas hidden from `userId`? Private hides from everyone but its creator —
 *  the workspace owner included (manage-not-read is the caller's separate affordance).
 *  A creator-less private row hides from everyone (unreachable by the flip rules —
 *  creator-less canvases are permanently workspace-visible — but fail closed). */
export function canvasHiddenFrom(canvas: CanvasVisibilitySlice, userId: string): boolean {
  return canvas.visibility === 'private' && canvas.createdBy !== userId;
}

/** May `userId` flip this canvas's visibility to `next`? Creator: both ways. The
 *  workspace owner (pass `isOwner`) may only force-publish (→ workspace) — the
 *  manage-not-read escape hatch. Creator-less canvases are never flippable. */
export function mayFlipCanvas(
  canvas: CanvasVisibilitySlice,
  userId: string,
  isOwner: boolean,
  next: 'workspace' | 'private',
): boolean {
  if (canvas.createdBy === userId) return canvas.createdBy !== null;
  return isOwner && next === 'workspace';
}
