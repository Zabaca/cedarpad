// The pad half of the focus gesture (shared/dock-messages.ts FOCUS_CHAT): resolve "the chat
// the Shell is showing" to "the card on this canvas that fronts it". Kept React- and
// tldraw-free so it tests as a plain function; App.tsx feeds it the editor's page shapes and
// does the camera work (select + zoomToBounds, the same move SidePanel's instance list makes).

/** The only bits of a tldraw shape this resolution needs. */
export type ChatCardish = { id: string; type: string; props?: unknown };

/**
 * The shape id of the `chat` card fronting `chatId`, or null when this canvas holds none.
 * A card's chat is `props.chatId` when set (a card placed by canvas pairing, fronting a chat
 * born elsewhere) and otherwise its own shape id — ChatShape's `chatIdOf` convention.
 */
export function chatShapeIdFor(shapes: readonly ChatCardish[], chatId: string): string | null {
  if (!chatId) return null;
  for (const s of shapes) {
    if (s.type !== 'chat') continue;
    const props = s.props as { chatId?: unknown } | undefined;
    const owned = typeof props?.chatId === 'string' && props.chatId ? props.chatId : s.id;
    if (owned === chatId) return s.id;
  }
  return null;
}
