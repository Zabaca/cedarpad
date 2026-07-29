// The pad↔Shell gesture protocol (CONTEXT.md "Docked chat", "Focus a chat card"): the ONE
// postMessage boundary between the embedded Render Pad iframe and the Shell that hosts it.
// Everything else the two surfaces share converges at the bridge over HTTP/SSE — only
// *gestures* cross in-page, in both directions: dock (and its inverse, "the docked chat's
// card was deleted") flows pad→Shell; focus flows Shell→pad.
// Kept tldraw-free (shared/) so both sides import the same guard, chat-wire style.

export const DOCK_CHAT = 'cedarpad:dock-chat' as const;
export const DOCK_CHAT_DELETED = 'cedarpad:chat-deleted' as const;
export const FOCUS_CHAT = 'cedarpad:focus-chat' as const;

export type DockMessage =
  | { type: typeof DOCK_CHAT; chatId: string; title: string }
  | { type: typeof DOCK_CHAT_DELETED; chatId: string }
  | { type: typeof FOCUS_CHAT; chatId: string };

/** Narrow a raw `message` payload to a DockMessage, or null for anything foreign — the
 *  Shell listens on `window`, which any same-origin script can post to, so the shape (not
 *  just the origin) is checked before it drives UI state. */
export function parseDockMessage(data: unknown): DockMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as { type?: unknown; chatId?: unknown; title?: unknown };
  if (typeof m.chatId !== 'string' || !m.chatId) return null;
  if (m.type === DOCK_CHAT && typeof m.title === 'string') return { type: DOCK_CHAT, chatId: m.chatId, title: m.title };
  if (m.type === DOCK_CHAT_DELETED) return { type: DOCK_CHAT_DELETED, chatId: m.chatId };
  if (m.type === FOCUS_CHAT) return { type: FOCUS_CHAT, chatId: m.chatId };
  return null;
}

/** Is this surface embedded in the Shell (an iframe)? The dock affordance only exists then —
 *  a standalone pad tab has no panel to dock into. */
export function isEmbedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

/** Post a gesture DOWN into an embedded pad iframe, same-origin only. No-op when the frame
 *  is absent or has not loaded a document yet (the Inbox renders its pad pane conditionally). */
export function postToPad(frame: HTMLIFrameElement | null, msg: DockMessage): void {
  frame?.contentWindow?.postMessage(msg, window.location.origin);
}

/** Post a dock message to the embedding Shell, same-origin only. No-op when standalone. */
export function postDockMessage(msg: DockMessage): void {
  if (!isEmbedded()) return;
  window.parent.postMessage(msg, window.location.origin);
}
