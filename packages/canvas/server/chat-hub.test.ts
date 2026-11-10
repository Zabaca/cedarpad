// The chat plane's hub, tested without booting the bridge (that is the point of the module
// being dependency-free). Covers the fan-out, the guest broadcast filter — the security-
// relevant path that previously only had coverage through a live SSE response — dead-
// controller cleanup, the abort plane, and the test-reset seam.

import { describe, expect, test } from 'bun:test';
import type { ChatFrame } from '../shared/chat-wire.ts';
import { createChatHub } from './chat-hub.ts';

const decode = (u: Uint8Array): string => new TextDecoder().decode(u);

/** A subscriber that records the frames it received; `dead` makes enqueue throw (a closed stream). */
function recorder(dead = false) {
  const frames: string[] = [];
  const controller = {
    enqueue(chunk: Uint8Array) {
      if (dead) throw new Error('stream closed');
      frames.push(decode(chunk));
    },
    close() {},
    error() {},
  } as unknown as ReadableStreamDefaultController;
  return { controller, frames };
}

const frame = (chatId: string): ChatFrame => ({ chatId, kind: 'thinking', thinkingTokens: 1 });

describe('subscribers + fan-out', () => {
  test('every member subscriber receives every frame, tagged with its chatId', () => {
    const hub = createChatHub();
    const a = recorder();
    const b = recorder();
    hub.subscribe(a.controller);
    hub.subscribe(b.controller);
    expect(hub.subscriberCount()).toBe(2);

    hub.broadcast(frame('chat_1'));

    expect(a.frames).toHaveLength(1);
    expect(a.frames[0]).toContain('chat_1');
    expect(a.frames[0]).toStartWith('data: ');
    expect(b.frames).toEqual(a.frames);
  });

  test('unsubscribe stops delivery and drops the count', () => {
    const hub = createChatHub();
    const a = recorder();
    hub.subscribe(a.controller);
    hub.unsubscribe(a.controller);
    expect(hub.subscriberCount()).toBe(0);

    hub.broadcast(frame('chat_1'));
    expect(a.frames).toEqual([]);
  });

  test('a dead controller is dropped on the broadcast that fails', () => {
    const hub = createChatHub();
    const dead = recorder(true);
    const live = recorder();
    hub.subscribe(dead.controller);
    hub.subscribe(live.controller);

    hub.broadcast(frame('chat_1'));

    expect(hub.subscriberCount()).toBe(1);
    expect(live.frames).toHaveLength(1);
  });
});

describe('guest broadcast filter (#220 slice 6)', () => {
  test("a guest subscriber receives ONLY frames of chats bound to its canvas", () => {
    const hub = createChatHub();
    const guest = recorder();
    const member = recorder();
    hub.subscribe(guest.controller, 'cv_g');
    hub.subscribe(member.controller);
    hub.bindCanvas('mine', 'cv_g');
    hub.bindCanvas('theirs', 'cv_other');

    hub.broadcast(frame('theirs'));
    hub.broadcast(frame('mine'));
    hub.broadcast(frame('unbound')); // no binding at all

    expect(guest.frames).toHaveLength(1);
    expect(guest.frames[0]).toContain('mine');
    // The member subscriber is unfiltered — it sees all three.
    expect(member.frames).toHaveLength(3);
  });

  test('an unbound chat fails CLOSED for a guest, even after another chat binds to its canvas', () => {
    const hub = createChatHub();
    const guest = recorder();
    hub.subscribe(guest.controller, 'cv_g');
    hub.bindCanvas('other', 'cv_g');

    hub.broadcast(frame('unbound'));
    expect(guest.frames).toEqual([]);
  });

  test("a late binding onto the guest's canvas starts delivering that chat", () => {
    const hub = createChatHub();
    const guest = recorder();
    hub.subscribe(guest.controller, 'cv_g');

    hub.broadcast(frame('later'));
    expect(guest.frames).toEqual([]);

    hub.bindCanvas('later', 'cv_g');
    hub.broadcast(frame('later'));
    expect(guest.frames).toHaveLength(1);
  });

  test('an unsubscribed guest controller cannot leak its scope back into a broadcast', () => {
    const hub = createChatHub();
    const guest = recorder();
    hub.subscribe(guest.controller, 'cv_g');
    hub.unsubscribe(guest.controller);
    hub.bindCanvas('mine', 'cv_g');

    hub.broadcast(frame('mine'));
    expect(guest.frames).toEqual([]);
  });
});

describe('chat→canvas binding + guest ownership', () => {
  test('bindCanvas is last-write-wins; canvasOf is undefined until bound', () => {
    const hub = createChatHub();
    expect(hub.canvasOf('c')).toBeUndefined();
    hub.bindCanvas('c', 'cv_1');
    expect(hub.canvasOf('c')).toBe('cv_1');
    hub.bindCanvas('c', 'cv_2');
    expect(hub.canvasOf('c')).toBe('cv_2');
  });

  test('only marked chats are guest-started', () => {
    const hub = createChatHub();
    expect(hub.isGuestChat('c')).toBe(false);
    hub.markGuestChat('c');
    expect(hub.isGuestChat('c')).toBe(true);
  });
});

describe('turn abort plane', () => {
  test('busy tracks the injected aborters map (turn.ts writes it directly)', () => {
    const hub = createChatHub();
    expect(hub.busy('c')).toBe(false);
    hub.aborters.set('c', new AbortController());
    expect(hub.busy('c')).toBe(true);
    hub.aborters.delete('c');
    expect(hub.busy('c')).toBe(false);
  });

  test('abort signals the in-flight controller and reports whether it did', () => {
    const hub = createChatHub();
    expect(hub.abort('c')).toBe(false);
    const ac = new AbortController();
    hub.aborters.set('c', ac);
    expect(hub.abort('c')).toBe(true);
    expect(ac.signal.aborted).toBe(true);
  });
});

describe('resetForTests', () => {
  test('clears subscribers, bindings, the guest set, and the aborters', () => {
    const hub = createChatHub();
    const a = recorder();
    hub.subscribe(a.controller, 'cv_g');
    hub.bindCanvas('c', 'cv_g');
    hub.markGuestChat('c');
    hub.aborters.set('c', new AbortController());

    hub.resetForTests();

    expect(hub.subscriberCount()).toBe(0);
    expect(hub.canvasOf('c')).toBeUndefined();
    expect(hub.isGuestChat('c')).toBe(false);
    expect(hub.busy('c')).toBe(false);
  });
});
