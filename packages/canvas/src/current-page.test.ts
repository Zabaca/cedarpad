import { describe, expect, test } from 'bun:test';

import { cameraKey, pageToSend, restorablePage } from './current-page';

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

describe('cameraKey', () => {
  test('is per canvas AND per page, because tldraw scopes the camera to a page', () => {
    expect(cameraKey('cv_a', 'page:one')).not.toBe(cameraKey('cv_a', 'page:two'));
    expect(cameraKey('cv_a', 'page:one')).not.toBe(cameraKey('cv_b', 'page:one'));
  });
});
