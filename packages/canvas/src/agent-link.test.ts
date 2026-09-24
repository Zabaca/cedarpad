// A component's reply capability (`sendToAgent` -> postMessageToChat) must behave like the
// chat card's own send: addressed to the component's canvas, queued while a turn is in
// flight, and visible in the card. These tests drive the real chat-store with a fake
// EventSource + fetch stub, the same harness shape as chat-store.test.ts.
// happy-dom first: the fallback path's stamp reads window.location. See happydom-harness.ts.
import './happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { postMessageToChat } from './agent-link';
import { CANVAS_ID_HEADER } from '../shared/bridge-wire';
import { __closeSharedStreamForTests, isSubscribed, openStream, routeChatFrame, setCanvasOverride } from '../shared/chat-store';

function frame(chatId: string, ev: Record<string, unknown>): string {
  return JSON.stringify({ chatId, ...ev });
}

type Send = { body: string; headers: Record<string, string> };

/** Fake EventSource + fetch stub: /send is accepted, everything else answers a transcript
 *  body. Returns the captured sends so a test can read their bodies and headers. */
function harness(id: string) {
  const realFetch = globalThis.fetch;
  const realES = (globalThis as Record<string, unknown>).EventSource;
  let esInstance: { onopen: (() => void) | null } | null = null;
  (globalThis as Record<string, unknown>).EventSource = class {
    onopen: (() => void) | null = null;
    onerror: unknown = null;
    onmessage: unknown = null;
    constructor(_url: string) {
      esInstance = this;
    }
    close() {}
  };
  const sends: Send[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
    if (String(url).includes('/send')) {
      sends.push({ body: init!.body!, headers: init?.headers ?? {} });
      return new Response('{"ok":true}', { status: 202 });
    }
    return new Response(JSON.stringify({ config: {}, events: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return {
    sends,

    messages: () => sends.map((s) => (JSON.parse(s.body) as { message: string }).message),
    subscribe() {
      openStream(id);
      if (!isSubscribed(id)) esInstance!.onopen!();
    },
    restore() {
      globalThis.fetch = realFetch;
      (globalThis as Record<string, unknown>).EventSource = realES;
    },
  };
}

const setPath = (pathname: string) =>
  (globalThis as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`https://poc.cedarpad.com${pathname}`);

// Another test file may have left the shared EventSource open; openStream reuses it.
beforeEach(() => __closeSharedStreamForTests());
afterEach(() => setPath('/'));

describe('postMessageToChat — a component send is a chat-store send', () => {
  test('a send while a turn is in flight is held, not thrown, and fires when the turn ends', async () => {
    const id = 'chat_component_busy';
    const h = harness(id);
    try {
      h.subscribe();
      await new Promise((r) => setTimeout(r, 0)); // let the rehydrate settle
      routeChatFrame(frame(id, { kind: 'init', sessionId: 'sess_busy' })); // a turn is running

      await postMessageToChat(id, 'from the component'); // must NOT throw
      await new Promise((r) => setTimeout(r, 0));
      expect(h.messages()).toEqual([]); // held

      routeChatFrame(frame(id, { kind: 'done', sessionId: 'sess_busy', costUsd: 0 }));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.messages()).toEqual(['from the component']); // drained on the turn's end
    } finally {
      h.restore();
    }
  });

  test("an idle send carries the chat's canvas id, so the turn runs with that canvas's tools", async () => {
    const id = 'chat_component_canvas';
    const h = harness(id);
    try {
      setCanvasOverride(id, 'canvas_x');
      h.subscribe();
      await new Promise((r) => setTimeout(r, 0));

      await postMessageToChat(id, 'hello');
      await new Promise((r) => setTimeout(r, 0));
      expect(h.messages()).toEqual(['hello']);
      expect(h.sends[0]!.headers[CANVAS_ID_HEADER]).toBe('canvas_x');
    } finally {
      h.restore();
    }
  });

  // No live session in this tab (the card isn't mounted): the direct POST still has to say
  // which canvas it came from, or the bridge runs the turn against the default canvas.
  test('a send to a chat with no live session falls back to a direct POST, still canvas-stamped', async () => {
    const h = harness('chat_component_unsubscribed');
    try {
      setPath('/w/ws_1/canvas/cv_7/pad');
      await postMessageToChat('chat_component_unsubscribed', 'offline send');
      expect(h.messages()).toEqual(['offline send']);
      expect(h.sends[0]!.headers[CANVAS_ID_HEADER]).toBe('cv_7');
    } finally {
      h.restore();
    }
  });
});
