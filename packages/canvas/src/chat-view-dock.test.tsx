// The card's dock affordance: <ChatView> shows a dock button only when a surface passes
// `onDock` (the embedded pad does; the Inbox thread and the Shell panel itself don't), and
// clicking it fires the gesture. The postMessage crossing itself is ChatShape's one line.
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
