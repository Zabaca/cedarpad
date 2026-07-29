// The card's two cross-surface affordances, both gated on a prop the hosting surface passes:
//   dock  — `onDock`: the embedded pad passes it; the Inbox thread and the Shell panel don't.
//   focus — `onFocus`: the Inbox thread passes it (linked canvas + pane showing); the pad's
//           own card never does, since focusing the card you are reading is a no-op.
// The postMessage crossings themselves are one line each (ChatShape / Inbox).
import './happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ChatView } from '../shared/ChatView';

// <ChatView> opens the shared SSE stream on mount; happy-dom has no EventSource.
class StubEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }
  close() {}
}
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const realFetch = globalThis.fetch;

let container: HTMLDivElement;
let root: Root;

async function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(el);
  });
}

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = StubEventSource as unknown;
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  globalThis.fetch = realFetch;
});

describe('the chat card dock button', () => {
  test('renders when onDock is passed, and clicking it fires the gesture', async () => {
    let docked = 0;
    await mount(<ChatView chatId="shape:dockbtn" title="Fix login" onDock={() => (docked += 1)} />);

    const btn = container.querySelector<HTMLButtonElement>('.chat-dock');
    expect(btn).not.toBeNull();
    await act(async () => btn!.click());
    expect(docked).toBe(1);
  });

  test('absent when no onDock is passed (Inbox thread, the Shell panel itself)', async () => {
    await mount(<ChatView chatId="shape:nodock" title="Fix login" />);

    expect(container.querySelector('.chat-dock')).toBeNull();
  });
});

describe('the chat card focus button', () => {
  test('renders a labelled button when onFocus is passed, and clicking it fires the gesture', async () => {
    let focused = 0;
    await mount(<ChatView chatId="chat_focusbtn" title="Refactor the auth flow" onFocus={() => (focused += 1)} />);

    const btn = container.querySelector<HTMLButtonElement>('.chat-focus');
    expect(btn).not.toBeNull();
    // Concept 2: the affordance names itself rather than relying on a bare glyph's tooltip.
    expect(btn!.textContent).toContain('On canvas');
    await act(async () => btn!.click());
    expect(focused).toBe(1);
  });

  test('absent when no onFocus is passed (the pad card, a conversation with no linked canvas)', async () => {
    await mount(<ChatView chatId="chat_nofocus" title="Refactor the auth flow" />);

    expect(container.querySelector('.chat-focus')).toBeNull();
  });
});
