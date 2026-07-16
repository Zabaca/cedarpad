import { useEffect, useState } from 'react';

// #220: the pad-side guest probe. The edge answers GET /api/guest-session with the share
// link's scope for a cs_guest session, null for members; in local dev (no edge) the bridge
// 404s, which reads as "not a guest". Fetched once per page, cached — every consumer
// (chat send affordances, the new-chat fab) converges on the same answer.

export interface GuestScope {
  canvasId: string;
  workspaceId: string;
  guestChat: boolean;
}

let cached: Promise<GuestScope | null> | null = null;

/** Test seam: clear the once-per-page cache between renders. */
export function resetGuestScopeForTests(): void {
  cached = null;
}

export function loadGuestScope(): Promise<GuestScope | null> {
  cached ??= fetch('/api/guest-session', { credentials: 'same-origin' })
    .then((r) => (r.ok ? (r.json() as Promise<GuestScope | null>) : null))
    .catch(() => null);
  return cached;
}

/** null = member (or still resolving — sends are gated server-side either way). */
export function useGuestScope(): GuestScope | null {
  const [scope, setScope] = useState<GuestScope | null>(null);
  useEffect(() => {
    let alive = true;
    void loadGuestScope().then((s) => alive && setScope(s));
    return () => {
      alive = false;
    };
  }, []);
  return scope;
}
