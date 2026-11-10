import { describe, expect, test } from 'bun:test';

import { GUEST_BARE_NAME, GUEST_MARK, GUEST_NAME_MAX, markGuestName } from './guest-mark.ts';

// #339: the mark is what lets a member notice a guest. tldraw cuts a long name off at its
// END, so the mark goes first and the name is cleaned and capped.

describe('markGuestName', () => {
  test('puts the mark in front of the name', () => {
    expect(markGuestName('Ada')).toBe(`${GUEST_MARK} Ada`);
  });

  test('is idempotent: a mark the browser already added is not doubled', () => {
    expect(markGuestName('(Guest) Ada')).toBe('(Guest) Ada');
    expect(markGuestName(markGuestName('Ada'))).toBe(markGuestName('Ada'));
    expect(markGuestName('(Guest) (Guest) Ada')).toBe('(Guest) Ada');
  });

  test('trims and collapses spaces, odd space characters included', () => {
    expect(markGuestName('  Ada  ')).toBe('(Guest) Ada');
    expect(markGuestName('Ada  Lovelace')).toBe('(Guest) Ada Lovelace');
  });

  test('a missing, blank, non-string or already-bare name is the bare "Guest"', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, [], 'Guest', '(Guest)', '(Guest)  ']) {
      expect(markGuestName(bad), String(bad)).toBe(GUEST_BARE_NAME);
    }
  });

  test('a name that fakes the mark further along is still marked', () => {
    expect(markGuestName('Ada (Guest)')).toBe('(Guest) Ada (Guest)');
    expect(markGuestName('Ada(Guest)')).toBe('(Guest) Ada(Guest)');
    expect(markGuestName('Ada (guest)')).toBe('(Guest) Ada (guest)');
  });

  // A name of blank-looking characters used to push a trailing mark out of the
  // 120px cursor label. They are removed, so no run of them can sit between the mark and the name,
  // and a name made only of them is no name.
  test('invisible and blank-looking characters are removed, whatever their category', () => {
    const blanks = '\u2800\u3164\u115F\u1160\uFFA0\u200B\u200D\u2060\uFEFF\u0000';
    expect(markGuestName(`James${'\u2800'.repeat(30)}`)).toBe('(Guest) James');
    expect(markGuestName(`${blanks}James${blanks}`)).toBe('(Guest) James');
    expect(markGuestName(blanks)).toBe(GUEST_BARE_NAME);
  });

  test('a long name is capped, by code point, and the mark is still first and whole', () => {
    const marked = markGuestName('x'.repeat(500));
    expect(marked).toBe(`${GUEST_MARK} ${'x'.repeat(GUEST_NAME_MAX)}`);
    // Astral characters count once, and are not cut in half.
    const emoji = markGuestName('😀'.repeat(100));
    expect(Array.from(emoji.slice(GUEST_MARK.length + 1))).toHaveLength(GUEST_NAME_MAX);
    expect(emoji.endsWith('😀')).toBe(true);
  });

  test('whatever the name, the result starts with the mark or is the bare word', () => {
    for (const name of ['Ada', 'x'.repeat(300), '\u2800'.repeat(50), '(Guest) ', 'Guest', '  ', '(Guest)'.repeat(9)]) {
      const marked = markGuestName(name);
      expect(marked === GUEST_BARE_NAME || marked.startsWith(`${GUEST_MARK} `), name.slice(0, 12)).toBe(true);
      expect(Array.from(marked).length).toBeLessThanOrEqual(GUEST_MARK.length + 1 + GUEST_NAME_MAX);
    }
  });
});
