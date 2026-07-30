import { describe, expect, test } from 'bun:test';

import { cameraKey, pageToSend, restorablePage, shapesOnPage } from './current-page';
import type { CanvasShape } from './shapes';

describe('pageToSend', () => {
  test('names the page when it is not the first one', () => {
    expect(pageToSend(['page:one', 'page:two'], 'page:two')).toBe('page:two');
  });

  test('omits the first page, so a single-page canvas writes exactly as it always did', () => {
    expect(pageToSend(['page:one', 'page:two'], 'page:one')).toBeUndefined();
    expect(pageToSend(['page:one'], 'page:one')).toBeUndefined();
  });

  test('omits when there is nothing to compare against', () => {
    expect(pageToSend([], 'page:one')).toBeUndefined();
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
