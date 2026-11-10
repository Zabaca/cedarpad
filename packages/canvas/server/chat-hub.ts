// The chat plane's runtime state, in one place. It exists for the same reason
// server/screenshot-channel.ts does: what used to be loose module-level singletons in
// server/bridge.ts becomes one keyed, testable module. (Its canvas-plane counterpart shrank
// to just the screenshot channel when ADR-0019 / #297 moved canvas state into the room.)
//
// It owns three things and nothing else:
//   - the ONE multiplexed SSE subscriber set (all chats share one stream per client) plus
//     each guest subscriber's canvas scope, which the broadcast filter consults;
//   - the chat→canvas binding and the set of guest-STARTED chats, i.e. the facts the four
//     guest-confinement guards in bridge.ts ask about;
//   - the turn abort plane (one AbortController per in-flight chat turn).
//
// Deliberately dependency-free so it is constructible in a test without booting the bridge
// (importing bridge.ts opens stores and the DB at module top level).

import type { ChatFrame } from '../shared/chat-wire.ts';
import { sseData } from './sse.ts';

export interface ChatHub {
  // --- subscribers (the one multiplexed chat stream) ---
  /** Register an SSE subscriber. A guest subscription carries the one canvas it may see. */
  subscribe(controller: ReadableStreamDefaultController, guestCanvas?: string): void;
  unsubscribe(controller: ReadableStreamDefaultController): void;
  /** Live subscriber count — the /send 425 subscribe-before-send gate and /api/status. */
  subscriberCount(): number;
  /** Fan one frame out to every subscriber it is allowed to reach; drops dead controllers. */
  broadcast(frame: ChatFrame): void;

  // --- chat→canvas binding + guest ownership ---
  bindCanvas(chatId: string, canvasId: string): void;
  canvasOf(chatId: string): string | undefined;
  markGuestChat(chatId: string): void;
  isGuestChat(chatId: string): boolean;

  // --- turn abort plane ---
  /** The live turn registry, injected into TurnDeps as-is (server/turn.ts owns the writes). */
  readonly aborters: Map<string, AbortController>;
  /** Is a turn in flight for this chat right now (ADR-0011)? */
  busy(chatId: string): boolean;
  /** Abort this chat's in-flight turn; false when there was nothing to abort. */
  abort(chatId: string): boolean;

  /** Test seam: clear ALL hub state (subscribers, bindings, guest set, aborters). */
  resetForTests(): void;
}

export function createChatHub(): ChatHub {
  // All chat sessions multiplex over ONE SSE stream per client. A turn's events are
  // broadcast to every subscriber, each frame TAGGED with its chatId so the client
  // routes it to the right session. This is deliberately one stream for ALL chats
  // (not one per chat): a browser caps ~6 concurrent connections per host over
  // HTTP/1.1, and each EventSource holds one open forever, so one-per-chat-card means
  // a single tab with ~5 chats + the canvas stream saturates the cap and starves
  // every POST (send/shapes) into "pending". One shared stream keeps it flat at 2.
  const clients = new Set<ReadableStreamDefaultController>();

  // --- guest chat confinement (#220 slice 6, canvas ADR-0015) ---
  // The edge stamps `x-guest-canvas` on every proxied guest request. Bridge-side that means:
  // member conversations are VIEW-ONLY (a guest send into an established non-guest chat is
  // 403), a guest may start/continue their OWN chats addressed to exactly that canvas, and
  // the shared chat SSE delivers a guest only frames of chats KNOWN to live on that canvas.
  //
  // `chatCanvas` is the chat→canvas binding the filter consults, fed by the same places that
  // learn it anyway (send dispatch, session index). In-memory only — after a recycle a guest
  // can't continue their pre-recycle chat and can't stream frames of chats whose binding is
  // gone (fails CLOSED, never open). Known v1 gap, recorded on #220.
  const chatCanvas = new Map<string, string>();
  const guestChats = new Set<string>();
  /** Guest stream controllers → the one canvas whose chats they may see. Keyed by CONTROLLER
   * (weakly) so an unsubscribed controller can never leak its guest scope to a later frame. */
  const guestStreamCanvas = new WeakMap<ReadableStreamDefaultController, string>();

  // Live turns, keyed by chatId, so POST /interrupt can abort the in-flight query
  // (Esc / Stop in the UI). One turn per chat at a time — ENFORCED at /send (409
  // turn_in_flight, ADR-0011): the client-side queue only protects the tab that started
  // the turn; a headless send or a second tab needs the wire to say no.
  const aborters = new Map<string, AbortController>();

  return {
    subscribe(controller, guestCanvas) {
      clients.add(controller);
      if (guestCanvas) guestStreamCanvas.set(controller, guestCanvas);
    },
    unsubscribe(controller) {
      clients.delete(controller);
    },
    subscriberCount: () => clients.size,
    broadcast(frame) {
      const encoded = sseData(frame);
      for (const c of clients) {
        // #220: a guest stream sees only chats bound to ITS canvas; an unknown binding is
        // filtered too (fail closed — never leak a frame we can't place).
        const guestCanvas = guestStreamCanvas.get(c);
        if (guestCanvas !== undefined && chatCanvas.get(frame.chatId) !== guestCanvas) continue;
        try {
          c.enqueue(encoded);
        } catch {
          clients.delete(c);
        }
      }
    },
    bindCanvas(chatId, canvasId) {
      chatCanvas.set(chatId, canvasId);
    },
    canvasOf: (chatId) => chatCanvas.get(chatId),
    markGuestChat(chatId) {
      guestChats.add(chatId);
    },
    isGuestChat: (chatId) => guestChats.has(chatId),
    aborters,
    busy: (chatId) => aborters.has(chatId),
    abort(chatId) {
      const a = aborters.get(chatId);
      if (!a) return false;
      a.abort();
      return true;
    },
    resetForTests() {
      clients.clear();
      chatCanvas.clear();
      guestChats.clear();
      aborters.clear();
    },
  };
}
