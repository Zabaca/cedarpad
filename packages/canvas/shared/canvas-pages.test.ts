import { describe, expect, test } from 'bun:test';

import type { CanvasPage } from '../src/shapes.ts';
import { PageRefError, resolvePageRef } from './canvas-pages.ts';

const pages: CanvasPage[] = [
  { id: 'page:page', name: 'Page 1' },
  { id: 'page:two', name: 'Roadmap' },
];

describe('resolvePageRef', () => {
  test('resolves a name the human would have typed', () => {
    expect(resolvePageRef(pages, 'Roadmap')).toBe('page:two');
  });

  test('resolves case-insensitively, and tolerates surrounding whitespace', () => {
    expect(resolvePageRef(pages, 'roadmap')).toBe('page:two');
    expect(resolvePageRef(pages, '  Roadmap ')).toBe('page:two');
  });

  test('takes a page id too, so an agent holding a shape\'s `page` need not look it up', () => {
    expect(resolvePageRef(pages, 'page:two')).toBe('page:two');
  });

  test('an exact match wins over a case-insensitive one rather than being called ambiguous', () => {
    const both: CanvasPage[] = [{ id: 'page:a', name: 'Roadmap' }, { id: 'page:b', name: 'roadmap' }];
    expect(resolvePageRef(both, 'Roadmap')).toBe('page:a');
    expect(resolvePageRef(both, 'roadmap')).toBe('page:b');
  });

  test('an ambiguous name is refused, not resolved to the first match', () => {
    // Silently picking one is indistinguishable from data loss when the human is looking
    // at the other — the same reason applyMutation refuses an unknown page id.
    const dupes: CanvasPage[] = [{ id: 'page:a', name: 'Untitled' }, { id: 'page:b', name: 'Untitled' }];
    expect(() => resolvePageRef(dupes, 'Untitled')).toThrow(PageRefError);
    // The refusal has to carry the ids, or the caller has no way to disambiguate.
    expect(() => resolvePageRef(dupes, 'Untitled')).toThrow(/page:a, page:b/);
  });

  test('an unknown name is refused with the list of real ones', () => {
    // The caller is a model acting on a human's words; without the alternatives it can
    // only guess again.
    expect(() => resolvePageRef(pages, 'Sprint 12')).toThrow(/"Page 1", "Roadmap"/);
  });

  test('an unknown page id is refused as an id, not searched for as a name', () => {
    expect(() => resolvePageRef(pages, 'page:ghost')).toThrow(/no page with id page:ghost/);
  });

  test('an empty reference is refused rather than matching an unnamed page', () => {
    expect(() => resolvePageRef([{ id: 'page:a', name: '' }], '  ')).toThrow(PageRefError);
  });
});
