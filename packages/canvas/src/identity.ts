// Who is looking at this canvas (#211). One identity source for component instances
// (and later, presence #212): the Better Auth session when logged in, else a stable
// per-browser GUEST identity. A real session always wins; the guest name is ask-once
// (setDisplayName persists it browser-wide, so no component ever re-asks).

import React from 'react';

export type CurrentUser = {
  id: string;
  name?: string;
  email?: string;
  color: string;
  kind: 'user' | 'guest';
};

/** The storage/fetch seams, injectable in tests. */
export type IdentityDeps = {
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  fetchSession: () => Promise<{ id: string; email?: string; name?: string } | null>;
};

const GUEST_ID_KEY = 'cedarpad:guest-id';
const GUEST_NAME_KEY = 'cedarpad:guest-name';

// Muted-but-distinct collaborator hues; deterministic per id so a user keeps their
// color across sessions, canvases, and browsers.
const HUES = [4, 32, 55, 95, 152, 185, 210, 245, 280, 320];
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${HUES[h % HUES.length]} 65% 52%)`;
}

/** The stable per-browser guest identity, created on first use. */
export function guestIdentity(storage: IdentityDeps['storage']): CurrentUser {
  let id = storage.getItem(GUEST_ID_KEY);
  if (!id) {
    id = `guest_${crypto.randomUUID()}`;
    storage.setItem(GUEST_ID_KEY, id);
  }
  const name = storage.getItem(GUEST_NAME_KEY) ?? undefined;
  return { id, ...(name ? { name } : {}), color: colorFor(id), kind: 'guest' };
}

/** Session user → CurrentUser: name falls back to the email local-part. */
export function sessionIdentity(user: { id: string; email?: string; name?: string }): CurrentUser {
  const name = user.name?.trim() || user.email?.split('@')[0];
  return { id: user.id, ...(name ? { name } : {}), ...(user.email ? { email: user.email } : {}), color: colorFor(user.id), kind: 'user' };
}

/** Resolve who this browser is: the Better Auth session if one exists, else the guest.
 * A fetch failure (local dev bridge without the edge, network blip) degrades to guest. */
export async function resolveIdentity(deps: IdentityDeps): Promise<CurrentUser> {
  const user = await deps.fetchSession().catch(() => null);
  return user ? sessionIdentity(user) : guestIdentity(deps.storage);
}

// ── module singleton (the browser's identity) ───────────────────────────────

const defaultDeps = (): IdentityDeps => ({
  storage: localStorage,
  fetchSession: async () => {
    // Better Auth's session endpoint, served by the edge worker; body is `null`
    // when logged out. Absent entirely in local bridge-only dev → catch → guest.
    const res = await fetch('/api/auth/get-session', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { id: string; email?: string; name?: string } } | null;
    return body?.user ?? null;
  },
});

let snapshot: CurrentUser | null = null;
let started = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function start(): void {
  if (started) return;
  started = true;
  void resolveIdentity(defaultDeps()).then((u) => {
    snapshot = u;
    notify();
  });
}

/** Set the GUEST display name (ask-once, browser-wide). No-op for a logged-in user —
 * their name comes from the account and is not override-able per component. */
export function setDisplayName(name: string): void {
  if (snapshot?.kind !== 'guest') return;
  const trimmed = name.trim();
  if (!trimmed) return;
  localStorage.setItem(GUEST_NAME_KEY, trimmed);
  snapshot = { ...snapshot, name: trimmed };
  notify();
}

/** The current identity, resolving on first use; `null` until resolved. */
export function useCurrentUser(): CurrentUser | null {
  React.useEffect(start, []);
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snapshot,
  );
}
