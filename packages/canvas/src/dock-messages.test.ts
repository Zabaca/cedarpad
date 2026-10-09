// The dock protocol guard (docked chat panel): the Shell listens on `window`, so every
// payload is narrowed by shape before it drives UI state — foreign messages (other
// libraries, extensions) must fall out as null, never as a half-formed dock.
import { describe, expect, test } from 'bun:test';

import { DOCK_CHAT, DOCK_CHAT_DELETED, parseDockMessage } from '../shared/dock-messages.ts';

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

  test('rejects foreign payloads: unknown type, primitives, null', () => {
    expect(parseDockMessage({ type: 'webpack-dev-server', chatId: 'x' })).toBeNull();
    expect(parseDockMessage('a string')).toBeNull();
    expect(parseDockMessage(null)).toBeNull();
    expect(parseDockMessage(undefined)).toBeNull();
  });
});
