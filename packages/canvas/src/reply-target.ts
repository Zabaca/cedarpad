// A placed component's REPLY TARGET: the chat session its sendToAgent() answers to.
// A component is arrow-attached to the chat that created it (attachBatchToChat links
// chat -> component); that link is authoritative. This resolves the component's inbound
// arrow to its owning chat's *session* id (chatId || shape id, mirroring chatIdOf), so a
// component always replies into the chat that owns it — not whatever chat was last focused.

import type { CanvasShape } from './shapes';

/**
 * Which chat a component's message should post to, or null when there is none.
 *
 *  1. the chat at the start of an arrow whose end is this component (an existing chat) — authoritative
 *  2. else `focusedChatId`, when it names an existing chat — the fallback for unlinked (palette) components
 *  3. else null — the caller must surface this, never POST to a dead/wrong chat
 */
export function resolveReplyTarget(
  shapes: CanvasShape[],
  componentShapeId: string,
  focusedChatId?: string,
): string | null {
  // shape id -> session id (chatId || id), mirroring ChatShape's chatIdOf convention.
  const sessionByShapeId = new Map<string, string>();
  for (const s of shapes) if (s.type === 'chat') sessionByShapeId.set(s.id, s.chatId || s.id);

  for (const s of shapes) {
    if (s.type !== 'arrow' || s.endShapeId !== componentShapeId) continue;
    const owner = s.startShapeId && sessionByShapeId.get(s.startShapeId);
    if (owner) return owner;
  }

  const sessions = new Set(sessionByShapeId.values());
  return focusedChatId && sessions.has(focusedChatId) ? focusedChatId : null;
}
