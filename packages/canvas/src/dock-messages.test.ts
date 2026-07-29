// The dock protocol guard (docked chat panel): the Shell listens on `window`, so every
// payload is narrowed by shape before it drives UI state — foreign messages (other
// libraries, extensions) must fall out as null, never as a half-formed dock.
// `postToPad` reads window.location.origin — this suite needs a DOM, same as the .tsx specs.
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';

import { DOCK_CHAT, DOCK_CHAT_DELETED, FOCUS_CHAT, parseDockMessage, postToPad } from '../shared/dock-messages.ts';

describe('parseDockMessage: the pad→Shell message boundary', () => {
  test('accepts a dock gesture: {type: dock-chat, chatId, title}', () => {
    expect(parseDockMessage({ type: DOCK_CHAT, chatId: 'shape:c1', title: 'Fix login' })).toEqual({
      type: DOCK_CHAT,
      chatId: 'shape:c1',
      title: 'Fix login',
    });
  });

  test('accepts a card-deletion notice: {type: chat-deleted, chatId}', () => {
    expect(parseDockMessage({ type: DOCK_CHAT_DELETED, chatId: 'shape:c1' })).toEqual({
      type: DOCK_CHAT_DELETED,
      chatId: 'shape:c1',
    });
  });

  test('rejects a dock gesture missing its title', () => {
    expect(parseDockMessage({ type: DOCK_CHAT, chatId: 'shape:c1' })).toBeNull();
  });

  test('rejects an empty or non-string chatId', () => {
    expect(parseDockMessage({ type: DOCK_CHAT, chatId: '', title: 't' })).toBeNull();
    expect(parseDockMessage({ type: DOCK_CHAT_DELETED, chatId: 42 })).toBeNull();
  });

  // The first Shell→pad gesture: "center your camera on the card fronting this chat".
  // Same guard, same module — the channel is bidirectional now, still gesture-only.
  test('accepts a focus gesture: {type: focus-chat, chatId}', () => {
    expect(parseDockMessage({ type: FOCUS_CHAT, chatId: 'chat_abc' })).toEqual({
      type: FOCUS_CHAT,
      chatId: 'chat_abc',
    });
  });

  test('rejects a focus gesture with no chatId to focus', () => {
    expect(parseDockMessage({ type: FOCUS_CHAT, chatId: '' })).toBeNull();
    expect(parseDockMessage({ type: FOCUS_CHAT })).toBeNull();
  });

  test('rejects foreign payloads: unknown type, primitives, null', () => {
    expect(parseDockMessage({ type: 'webpack-dev-server', chatId: 'x' })).toBeNull();
    expect(parseDockMessage('a string')).toBeNull();
    expect(parseDockMessage(null)).toBeNull();
    expect(parseDockMessage(undefined)).toBeNull();
  });
});

describe('postToPad: the Shell→pad half of the channel', () => {
  test('posts into the frame, same-origin only', () => {
    const sent: Array<[unknown, string]> = [];
    const frame = { contentWindow: { postMessage: (m: unknown, o: string) => void sent.push([m, o]) } };

    postToPad(frame as never, { type: FOCUS_CHAT, chatId: 'chat_abc' });

    expect(sent).toEqual([[{ type: FOCUS_CHAT, chatId: 'chat_abc' }, window.location.origin]]);
  });

  test('no-ops when the pad frame is absent or not yet loaded', () => {
    expect(() => postToPad(null, { type: FOCUS_CHAT, chatId: 'chat_abc' })).not.toThrow();
    expect(() => postToPad({ contentWindow: null } as never, { type: FOCUS_CHAT, chatId: 'chat_abc' })).not.toThrow();
  });
});
