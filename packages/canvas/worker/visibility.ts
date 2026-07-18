// ADR-0016: canvas/chat visibility — the ONE effective-visibility predicate, pure.
// Every surface (canvas registry API, pad routes, Inbox list + bridge proxy, MCP
// tools) answers "can U see this?" through these two functions; nothing copies a
// canvas's visibility onto a conversation (the canvas contribution is derived at
// read time via the `canvas_id` join the caller performs).

/** The slice of a canvas row the predicate reads. */
export interface CanvasVisibilitySlice {
  visibility: 'workspace' | 'private';
  createdBy: string | null;
}

/** The slice of a conversation row the predicate reads. */
export interface ConversationVisibilitySlice {
  visibility: 'shared' | 'private';
  createdBy: string | null;
}

/** Is this canvas hidden from `userId`? Private hides from everyone but its creator —
 *  the workspace owner included (manage-not-read is the caller's separate affordance).
 *  A creator-less private row hides from everyone (unreachable by the flip rules —
 *  creator-less canvases are permanently workspace-visible — but fail closed). */
export function canvasHiddenFrom(canvas: CanvasVisibilitySlice, userId: string): boolean {
  return canvas.visibility === 'private' && canvas.createdBy !== userId;
}

/**
 * Is this conversation hidden from `userId`? Effective rule (ADR-0016):
 * hidden ⟺ (its own flag is private and U isn't the chat's creator)
 *        OR (its canvas is private and U isn't the canvas's creator — dominance:
 *            re-privatizing a canvas hides ALL its chats, their creators included).
 * `canvas` is null when the conversation is canvas-less or the canvas has no
 * registry row (the legacy `default` canvas — permanently workspace-visible).
 */
export function conversationHiddenFrom(
  conv: ConversationVisibilitySlice,
  canvas: CanvasVisibilitySlice | null,
  userId: string,
): boolean {
  if (conv.visibility === 'private' && conv.createdBy !== userId) return true;
  return canvas ? canvasHiddenFrom(canvas, userId) : false;
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
