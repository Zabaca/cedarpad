// Dock-memory parsing: a corrupt or half-corrupt localStorage blob must degrade to "less
// remembered", never to a crash or a malformed dock entry reaching the panel.
import { describe, expect, test } from 'bun:test';

import { DEFAULT_DOCK_WIDTH, parseDockMemory, parseDockWidth, serializeDockMemory } from './canvas-dock';

describe('parseDockMemory', () => {
  test('round-trips a valid memory', () => {
    const mem = { cv_1: { chatId: 'shape:c1', title: 'Fix login' } };
    expect(parseDockMemory(serializeDockMemory(mem))).toEqual(mem);
  });

  test('absent or invalid JSON → empty memory', () => {
    expect(parseDockMemory(null)).toEqual({});
    expect(parseDockMemory('{ not json')).toEqual({});
    expect(parseDockMemory('[1,2]')).toEqual({});
  });

  test('a malformed entry is dropped; the other canvases keep their docks', () => {
    const raw = JSON.stringify({
      cv_ok: { chatId: 'shape:c1', title: 'Fix login' },
      cv_bad: { chatId: 42 },
      cv_empty: { chatId: '', title: 'no id' },
    });
    expect(parseDockMemory(raw)).toEqual({ cv_ok: { chatId: 'shape:c1', title: 'Fix login' } });
  });
});

describe('parseDockWidth', () => {
  test('absent or garbage → the default width', () => {
    expect(parseDockWidth(null)).toBe(DEFAULT_DOCK_WIDTH);
    expect(parseDockWidth('not-a-number')).toBe(DEFAULT_DOCK_WIDTH);
  });

  test('a persisted width is clamped to the shared pane bounds', () => {
    expect(parseDockWidth('500')).toBe(500);
    expect(parseDockWidth('10')).toBe(220); // MIN_PANE_WIDTH
    expect(parseDockWidth('5000')).toBe(900); // MAX_PANE_WIDTH
  });
});
