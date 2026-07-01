// Lets a placed canvas component talk back to the chat agent. The focused chat
// card keeps `activeChatId` pointed at its session; components call sendToAgent()
// to post a message into that session. The message rides the same /api/chat/:id/send
// route the chat card uses, so the reply streams into that card over SSE.
//
// This is a module-level singleton. The chat card (in the main bundle) and a
// dynamically-imported component both import this exact module URL, so they share
// one instance and one activeChatId.

let activeChatId = 'chat_1';

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

// Post a message into the active chat. Relative URL so vite proxies it to the
// bridge (the absolute :4511 form the old single-session components used is gone).
export async function sendToAgent(message: string): Promise<void> {
  const id = activeChatId;
  const res = await fetch(`/api/chat/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`send failed: HTTP ${res.status}`);
}
