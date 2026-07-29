// Which card on this canvas fronts a given chat. The Shell's focus gesture names a chatId,
// never a shape id — the two are only the same for a card born on the canvas. A card placed
// by canvas pairing (server/inbox.ts placeChatCard) carries a fresh `shape:pair-<uuid>` id and
// names its chat in `props.chatId`, so matching on shape id alone would never find one.
import { describe, expect, test } from 'bun:test';

import { chatShapeIdFor } from './focus-chat.ts';

// A canvas holding one card born here (its shape id IS its chat) and one placed by pairing.
const shapes = [
  { id: 'shape:note', type: 'geo', props: {} },
  { id: 'shape:born', type: 'chat', props: { chatId: '' } },
  { id: 'shape:pair-9f2c', type: 'chat', props: { chatId: 'chat_from_inbox' } },
];

describe('chatShapeIdFor: the card fronting a chat', () => {
  test('finds a paired card by its chatId prop, not its shape id', () => {
    expect(chatShapeIdFor(shapes, 'chat_from_inbox')).toBe('shape:pair-9f2c');
  });

  test('finds a card born on the canvas, whose shape id IS its chat', () => {
    expect(chatShapeIdFor(shapes, 'shape:born')).toBe('shape:born');
  });

  test('a paired card is NOT reachable by its shape id — that id is not a chat', () => {
    expect(chatShapeIdFor(shapes, 'shape:pair-9f2c')).toBeNull();
  });

  test('no card for this chat on this canvas', () => {
    expect(chatShapeIdFor(shapes, 'chat_elsewhere')).toBeNull();
  });

  test('never matches a non-chat shape, and never on an empty chatId', () => {
    expect(chatShapeIdFor(shapes, 'shape:note')).toBeNull();
    expect(chatShapeIdFor(shapes, '')).toBeNull();
  });
});
