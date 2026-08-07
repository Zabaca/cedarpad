import { describe, expect, test } from 'bun:test';

import { cameraKey, pageToSend, restorablePage, shapesOnPage } from './current-page';
import type { CanvasShape } from './shapes';

describe('pageToSend', () => {
  test('names the page when it is not the first one', () => {
    expect(pageToSend(['page:one', 'page:two'], 'page:two')).toBe('page:two');
  });

  test('omits on a single-page canvas, so it writes exactly as it always did', () => {
    expect(pageToSend(['page:one'], 'page:one')).toBeUndefined();
  });

  test('omits when there is nothing to compare against', () => {
    expect(pageToSend([], 'page:one')).toBeUndefined();
  });

  /**
   * The 2026-08-07 bug. tldraw sorts pages by its own fractional index and reorders them as
   * you drag them, so on a reordered canvas `getPages()[0]` is NOT the canvas's first page.
   * The open page then looked like page one, nothing was sent, and the server put the card on
   * ITS first page. Naming the page unconditionally is what makes the disagreement harmless.
   */
  test('names the open page even when it sorts FIRST in the editor', () => {
    // "Focus" leads tldraw's order while the canvas's own first page is "page:page".
    expect(pageToSend(['page:focus', 'page:page', 'page:other'], 'page:focus')).toBe('page:focus');
  });

  test('names the first page explicitly on a multi-page canvas, rather than implying it', () => {
    expect(pageToSend(['page:one', 'page:two'], 'page:one')).toBe('page:one');
  });
});

describe('restorablePage', () => {
  test('restores the page you were on', () => {
    expect(restorablePage('page:two', ['page:one', 'page:two'])).toBe('page:two');
  });

  test('refuses a page the canvas no longer has, rather than landing somewhere else', () => {
    // Another client can delete the page between the reload and the visit. Falling back
    // to "no restore" leaves tldraw on its own default; guessing a neighbour would open
    // a page the human never asked for.
    expect(restorablePage('page:gone', ['page:one'])).toBeUndefined();
  });

  test('nothing stored means nothing to restore', () => {
    expect(restorablePage(null, ['page:one'])).toBeUndefined();
  });
});

describe('shapesOnPage', () => {
  const box = (id: string, page?: string): CanvasShape => ({ id, type: 'rectangle', x: 0, y: 0, w: 1, h: 1, color: 'black', text: '', ...(page ? { page } : {}) });
  const pages = [
    { id: 'page:one', name: 'Page 1' },
    { id: 'page:two', name: 'Page 2' },
  ];
  const shapes = [box('shape:a'), box('shape:b', 'page:two'), box('shape:c', 'page:one')];

  test('naming no page keeps everything, so existing readers are unchanged', () => {
    expect(shapesOnPage(shapes, pages, undefined)).toEqual(shapes);
  });

  test('the first page collects the shapes that name no page', () => {
    // ABSENT MEANS THE FIRST PAGE (src/shapes.ts). A filter that matched only the explicit
    // id would report page one as empty on every canvas written before pages existed.
    expect(shapesOnPage(shapes, pages, 'page:one').map((s) => s.id)).toEqual(['shape:a', 'shape:c']);
  });

  test('a later page collects only what names it', () => {
    expect(shapesOnPage(shapes, pages, 'page:two').map((s) => s.id)).toEqual(['shape:b']);
  });

  test('a page the canvas does not have is refused, not answered as empty', () => {
    // Same rule the write path already follows: an empty answer is indistinguishable from
    // "your shapes are gone", so say which pages exist instead.
    expect(() => shapesOnPage(shapes, pages, 'page:nope')).toThrow(/page:one.*page:two/s);
  });
});

describe('cameraKey', () => {
  test('is per canvas AND per page, because tldraw scopes the camera to a page', () => {
    expect(cameraKey('cv_a', 'page:one')).not.toBe(cameraKey('cv_a', 'page:two'));
    expect(cameraKey('cv_a', 'page:one')).not.toBe(cameraKey('cv_b', 'page:one'));
  });
});
