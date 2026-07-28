// #293: presence rides tldraw sync's own channel. What is left on the client is the
// bridge between OUR identity (#211) and tldraw's `TLUserStore` — sync derives the
// broadcast `instance_presence` record from that user, and the collaborator machinery
// (cursors, face-pile, follow mode) renders it as it always did.
// The tldraw import needs a DOM at module-eval — harness first.
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';

import { tlUserFor } from './presence';

describe('tlUserFor', () => {
  test('maps our identity onto a tldraw user record', () => {
    const u = tlUserFor({ id: 'u1', name: 'James', color: 'hsl(210 65% 52%)', kind: 'user' });
    expect(u).toMatchObject({
      typeName: 'user',
      // tldraw 5.2 brands user ids and REJECTS an unprefixed one at record validation
      // ("user ID must start with \"user:\"") — our ids are plain strings, so the
      // prefixing is load-bearing, not cosmetic.
      id: 'user:u1',
      name: 'James',
      color: 'hsl(210 65% 52%)',
    });
  });

  test('a nameless guest is "Guest"; no identity yet is no user', () => {
    expect(tlUserFor({ id: 'g1', color: 'red', kind: 'guest' })?.name).toBe('Guest');
    expect(tlUserFor(null)).toBeNull();
  });
});
