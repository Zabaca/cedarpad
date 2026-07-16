// The shared chat module (ADR-0009 slice #120) must be importable from the edge Shell
// side with ZERO tldraw pulled in — the tldraw coupling stays in the canvas app's
// `src/ChatShape.tsx`. This test locks that boundary: the Shell can import `<ChatView>`
// and the chat-store, and neither the shared UI nor its transitive deps touch tldraw.
import '../../src/happydom-harness.ts';

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { ChatView } from '../../shared/ChatView';
import { EFFORTS, MODELS, ensureSession, getSnapshot, interrupt, openStream, send, subscribe } from '../../shared/chat-store';

const sharedDir = new URL('../../shared/', import.meta.url);

describe('shared chat module is importable from the Shell', () => {
  test('ChatView + chat-store resolve from shell/ (cross-package import works)', () => {
    expect(typeof ChatView).toBe('function');
    for (const fn of [ensureSession, getSnapshot, subscribe, openStream, send, interrupt]) {
      expect(typeof fn).toBe('function');
    }
    expect(MODELS).toContain('sonnet');
    expect(EFFORTS).toContain('default');
  });

  // Grep-verify the invariant at the source: no file the Shell reaches through the shared
  // chat module may import tldraw. If someone re-couples the shared UI to tldraw, this fails.
  test('the shared chat module and its deps are tldraw-free', () => {
    const files = ['ChatView.tsx', 'chat-store.ts', 'MarkdownMessage.tsx'];
    for (const f of files) {
      const src = readFileSync(new URL(f, sharedDir), 'utf8');
      expect(src).not.toMatch(/from ['"]@?tldraw/);
    }
  });
});

// #220: a guest without the link's guestChat grant sees chats VIEW-ONLY — the composer
// (form + Send) is not rendered at all. Members (guest probe answers null) keep it.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { resetGuestScopeForTests } from '../../shared/guest-scope';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom provides no EventSource; ChatView's stream effect needs one to exist.
class FakeEventSource {
  onmessage: unknown;
  onerror: unknown;
  addEventListener() {}
  close() {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource ??= FakeEventSource;

async function renderChatWithGuestProbe(answer: unknown): Promise<HTMLDivElement> {
  resetGuestScopeForTests();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/guest-session')) return Response.json(answer);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(<ChatView chatId={`c_${Math.random()}`} title="t" />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20)); // let the probe resolve
  });
  globalThis.fetch = realFetch;
  return el;
}

describe('guest view-only chat (#220)', () => {
  test('a guest WITHOUT guestChat gets no composer', async () => {
    const el = await renderChatWithGuestProbe({ canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: false });
    expect(el.querySelector('.chat-input')).toBeNull();
  });

  test('a guest WITH guestChat — and a member (null) — keep the composer', async () => {
    const chatty = await renderChatWithGuestProbe({ canvasId: 'cv_g', workspaceId: 'ws_g', guestChat: true });
    expect(chatty.querySelector('.chat-input')).not.toBeNull();
    const member = await renderChatWithGuestProbe(null);
    expect(member.querySelector('.chat-input')).not.toBeNull();
  });
});
