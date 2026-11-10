import { describe, expect, test } from 'bun:test';

import { guestCapabilities } from '../shared/guest-capabilities.ts';
import { isInteractOnly, narrowInteractPush } from './guest-socket-policy.ts';

// #320, the write half. `guest_interact` means "use a live component"; `guest_edit` means
// "edit the canvas document". tldraw sync has ONE binary for a session — read-only — so
// the handshake can express "may push at all" and no more. This module is the rest: for a
// connection that may interact but not edit, it narrows each push to the writes a
// component interaction actually makes (`setData` → `props.data`, and the host's status
// mirror → `meta.status`; see src/ComponentShape.tsx).
//
// The narrowing is DROP-THE-DIFF, not drop-the-op: that is exactly what TLSyncRoom already
// does for a read-only session (TLSyncRoom.ts — `if (message.diff && !session?.isReadonly)`),
// so a refused push behaves like every other refused push and the client rebases.

const push = (diff: unknown, extra: Record<string, unknown> = {}) => ({ type: 'push', clientClock: 1, diff, ...extra });
/** What `setData({n: 2})` puts on the wire. */
const dataPatch = { 'shape:c1': ['patch', { props: ['patch', { data: ['put', { n: 2 }] }] }] };

describe('isInteractOnly — who gets narrowed', () => {
  test('interact WITHOUT edit is the narrowed case; every other combination is not', () => {
    expect(isInteractOnly(guestCapabilities({ guestInteract: true }))).toBe(true);
    // May edit the document outright: nothing to narrow.
    expect(isInteractOnly(guestCapabilities({ guestInteract: true, guestEdit: true }))).toBe(false);
    expect(isInteractOnly(guestCapabilities({ guestEdit: true }))).toBe(false);
    // May do neither: the session is read-only in the room, which is a stronger stop.
    expect(isInteractOnly(guestCapabilities({}))).toBe(false);
  });
});

describe('narrowInteractPush — what an interact-only guest may push', () => {
  test('a component data write passes through untouched', () => {
    const msg = push(dataPatch);
    expect(narrowInteractPush(msg)).toEqual(msg);
  });

  test("the component host's status mirror passes too (meta.status)", () => {
    const msg = push({ 'shape:c1': ['patch', { meta: ['patch', { status: ['put', 'ready'] }] }] });
    expect(narrowInteractPush(msg)).toEqual(msg);
  });

  test('presence survives even when the document diff does not — a guest still has a cursor', () => {
    const msg = push({ 'shape:c1': ['patch', { x: ['put', 400] }] }, { presence: ['patch', { cursor: ['put', {}] }] });
    expect(narrowInteractPush(msg)).toEqual({ type: 'push', clientClock: 1, presence: msg.presence });
  });

  test('MOVING a shape is an edit, not an interaction — the whole diff is dropped', () => {
    expect(narrowInteractPush(push({ 'shape:c1': ['patch', { x: ['put', 400] }] }))).not.toHaveProperty('diff');
  });

  test('creating and deleting records are edits — dropped', () => {
    expect(narrowInteractPush(push({ 'shape:new': ['put', { id: 'shape:new', typeName: 'shape' }] }))).not.toHaveProperty('diff');
    expect(narrowInteractPush(push({ 'shape:c1': ['remove'] }))).not.toHaveProperty('diff');
  });

  test('swapping the component MODULE is not interaction — that repoints the card at other code', () => {
    const msg = push({ 'shape:c1': ['patch', { props: ['patch', { module: ['put', 'Evil'] }] }] });
    expect(narrowInteractPush(msg)).not.toHaveProperty('diff');
  });

  test('a rev bump is not interaction either — it forces a hot reload on every viewer', () => {
    expect(narrowInteractPush(push({ 'shape:c1': ['patch', { props: ['patch', { rev: ['put', 99] }] }] }))).not.toHaveProperty('diff');
  });

  test('one disallowed op poisons the whole push — no partial application', () => {
    const msg = push({ ...dataPatch, 'shape:c2': ['patch', { x: ['put', 10] }] });
    expect(narrowInteractPush(msg)).not.toHaveProperty('diff');
  });

  test('non-shape records are out of scope entirely (pages, the document, assets)', () => {
    for (const id of ['page:page', 'document:document', 'asset:a1', 'instance:i1']) {
      expect(narrowInteractPush(push({ [id]: ['patch', { meta: ['patch', { status: ['put', 'x'] }] }] }))).not.toHaveProperty('diff');
    }
  });

  test('a props DELETE or whole-props PUT is not a data patch', () => {
    expect(narrowInteractPush(push({ 'shape:c1': ['patch', { props: ['put', { data: {} }] }] }))).not.toHaveProperty('diff');
    expect(narrowInteractPush(push({ 'shape:c1': ['patch', { props: ['patch', { data: ['delete'] }] }] }))).not.toHaveProperty('diff');
  });

  test('messages that are not pushes are never touched (connect, ping)', () => {
    for (const msg of [{ type: 'connect', connectRequestId: 'r' }, { type: 'ping' }]) {
      expect(narrowInteractPush(msg)).toEqual(msg);
    }
  });

  test('an unparseable or shapeless message yields a push with no diff — never a pass', () => {
    expect(narrowInteractPush({ type: 'push', clientClock: 1, diff: 'nonsense' })).not.toHaveProperty('diff');
    expect(narrowInteractPush({ type: 'push', clientClock: 1, diff: null })).not.toHaveProperty('diff');
  });
});
