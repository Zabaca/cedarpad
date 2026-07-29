// Lets a placed canvas component talk back to the chat agent. `activeChatId` tracks
// which chat card the user last FOCUSED — the anchor a new chat forks off, and the
// fallback reply target for a component that isn't attached to any chat. A component's
// actual reply target is resolved from its own canvas link (see resolveReplyTarget in
// ./reply-target); the host binds that to the `sendToAgent` prop it injects. The message
// rides the same /api/chat/:id/send route the chat card uses, so the reply streams into
// that card over SSE.
//
// This is a module-level singleton. The chat card (in the main bundle) and a
// dynamically-imported component both import this exact module URL, so they share
// one instance and one activeChatId.

// Empty until the user focuses a chat card. NOT a shape id: post-#327 canvas-born chats
// get random ids, so a hardcoded default would never name a real session.
let activeChatId = '';

export function setActiveChat(id: string): void {
  if (id) activeChatId = id;
}

export function getActiveChat(): string {
  return activeChatId;
}

// A fork request from a chat card's fork button. App owns the editor (it places the
// new chat shape + bound arrow) and registers the handler here; ChatShape, which has
// no editor access, calls requestFork. Same module-level-singleton pattern as the
// activeChatId above so both bundles share one instance.
let forkHandler: ((parentChatId: string) => void) | null = null;
export function setForkHandler(fn: ((parentChatId: string) => void) | null): void { forkHandler = fn; }
export function requestFork(parentChatId: string): void { forkHandler?.(parentChatId); }

// Post a message into a specific chat session. Relative URL so vite proxies it to the
// bridge (the absolute :4511 form the old single-session components used is gone). The
// caller resolves WHICH chat (the component host, via resolveReplyTarget); this only sends.
export async function postMessageToChat(chatId: string, message: string): Promise<void> {
  const res = await fetch(`/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status}`);
}
