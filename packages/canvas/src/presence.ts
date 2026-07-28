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

import { loadGuestScope } from '../shared/guest-scope';
import { currentUserSnapshot, subscribeIdentity, type CurrentUser } from './identity';

/** Our identity as a tldraw user record; `null` while identity is still resolving.
 * tldraw brands user ids (`user:…`) and rejects an unprefixed one at validation.
 *
 * `isGuest` marks a share-link guest (#320): the mark rides `userName`, which tldraw
 * already renders both on the cursor label and in the people list, so there is no second
 * visual language to keep in step. It is load-bearing rather than decorative — revoking a
 * link is a manual judgement call, so a member has to notice an outsider is editing first. */
export function tlUserFor(u: CurrentUser | null, isGuest = false): TLUser | null {
  if (!u) return null;
  // `||`, NOT `??`: a whitespace-only name trims to `''`, which is nullish-coalescing's
  // blind spot — it would render a blank, UNMARKED cursor, which is the exact case the
  // mark exists for. Every empty value falls back to the marked "Guest".
  const name = u.name?.trim();
  return UserRecordType.create({
    id: createUserId(u.id),
    name: name ? (isGuest ? `${name} (Guest)` : name) : 'Guest',
    color: u.color,
  });
}

/** The user store `useSync` broadcasts presence from, kept in step with identity
 * (which resolves asynchronously — a guest name can also land later).
 *
 * Guest-ness comes from the EDGE's answer (`/api/guest-session`), not from `kind`:
 * `kind: 'guest'` only means no Better Auth session resolved, which is also how a member
 * looks in bridge-only local dev. It lands asynchronously too, hence the same re-emit. */
export function createCanvasUserStore(): TLUserStore {
  let isGuest = false;
  const user = atom<TLUser | null>('canvas-user', tlUserFor(currentUserSnapshot(), isGuest));
  const refresh = () => user.set(tlUserFor(currentUserSnapshot(), isGuest));
  subscribeIdentity(refresh);
  void loadGuestScope().then((scope) => {
    isGuest = !!scope;
    refresh();
  });
  return { currentUser: user };
}
