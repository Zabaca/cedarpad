// The Inbox's third pane embeds the SAME Render Pad iframe the canvas stage mounts
// (`CanvasStage` in Shell.tsx), just addressed by the Conversation's linked `canvasId`
// (the chat→canvas edge, worker/inbox-view.ts) instead of the canvas rail's selection.
import type { InboxItem } from './contract';

/** The Render Pad URL for `item`'s linked canvas, or `null` if it has none. */
export function padUrlFor(item: Pick<InboxItem, 'workspaceId' | 'canvasId'>): string | null {
  if (!item.canvasId) return null;
  return `/w/${encodeURIComponent(item.workspaceId)}/canvas/${encodeURIComponent(item.canvasId)}/pad`;
}
