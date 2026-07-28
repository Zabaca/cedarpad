// Live presence (#212) after #293: the TRANSPORT is tldraw sync's own presence channel
// (ADR-0019) — no heartbeat POSTs, no SSE leg. Rendering was always tldraw-native and is
// unchanged: sync derives an `instance_presence` record from the current user and the
// collaborator machinery turns remote ones into labeled cursors, the people face-pile,
// and follow mode (`editor.startFollowingUser`).
//
// All that is left on our side is the bridge from OUR identity (#211) to tldraw's
// `TLUserStore`. The old invariant — presence must never reach persisted canvas state —
// is now the room's to keep, and `worker/sync-room.test.ts` pins it there.

import { atom, createUserId, UserRecordType, type TLUser, type TLUserStore } from 'tldraw';

import { currentUserSnapshot, subscribeIdentity, type CurrentUser } from './identity';

/** Our identity as a tldraw user record; `null` while identity is still resolving.
 * tldraw brands user ids (`user:…`) and rejects an unprefixed one at validation. */
export function tlUserFor(u: CurrentUser | null): TLUser | null {
  if (!u) return null;
  return UserRecordType.create({
    id: createUserId(u.id),
    name: u.name ?? 'Guest',
    color: u.color,
  });
}

/** The user store `useSync` broadcasts presence from, kept in step with identity
 * (which resolves asynchronously — a guest name can also land later). */
export function createCanvasUserStore(): TLUserStore {
  const user = atom<TLUser | null>('canvas-user', tlUserFor(currentUserSnapshot()));
  subscribeIdentity(() => user.set(tlUserFor(currentUserSnapshot())));
  return { currentUser: user };
}
