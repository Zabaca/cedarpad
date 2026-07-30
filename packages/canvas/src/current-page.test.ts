import { describe, expect, test } from 'bun:test';

import { pageToSend } from './current-page';

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
