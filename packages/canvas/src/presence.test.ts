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

  // #320 slice 2: revocation is a manual judgement call, so a member has to NOTICE an
  // outsider is editing before they can act. The marking rides `userName` — the field
  // tldraw already renders on the cursor label AND in the people list — so an
  // unlabelled guest is impossible without also being invisible.
  test('a share-link guest is marked, named or not', () => {
    expect(tlUserFor({ id: 'g1', name: 'Sam', color: 'red', kind: 'guest' }, true)?.name).toBe('Sam (Guest)');
    expect(tlUserFor({ id: 'g1', color: 'red', kind: 'guest' }, true)?.name).toBe('Guest');
  });

  // The nullish-coalescing blind spot: `'' ?? 'Guest'` is `''`, so a whitespace-only name
  // would have rendered a blank AND unmarked cursor — an unidentified outsider editing a
  // member's canvas, which is precisely what the mark is for.
  test('a whitespace-only name is no name: still marked, never blank', () => {
    expect(tlUserFor({ id: 'g1', name: '   ', color: 'red', kind: 'guest' }, true)?.name).toBe('Guest');
    expect(tlUserFor({ id: 'u1', name: '   ', color: 'red', kind: 'user' }, false)?.name).toBe('Guest');
  });

  test('a member is not marked, whatever the browser thinks it is', () => {
    // `kind: 'guest'` only means "no Better Auth session resolved" (local bridge-only dev
    // reads that way); the marking follows the share-link scope, which is the edge's answer.
    expect(tlUserFor({ id: 'u1', name: 'James', color: 'red', kind: 'guest' }, false)?.name).toBe('James');
  });
});
