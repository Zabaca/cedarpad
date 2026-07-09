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
