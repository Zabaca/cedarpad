import { useEffect, useState } from 'react';

import type { GuestCapabilities } from './guest-capabilities.ts';

// #220: the pad-side guest probe. The edge answers GET /api/guest-session with the share
// link's scope for a cs_guest session, null for members; in local dev (no edge) the bridge
// 404s, which reads as "not a guest". Fetched once per page, cached — every consumer
// (chat send affordances, the new-chat fab) converges on the same answer.

export interface GuestScope {
  canvasId: string;
  workspaceId: string;
  guestChat: boolean;
  /** May this guest join the canvas's voice huddle? (ADR-0017) */
  guestHuddle?: boolean;
  /**
   * What this link permits (#320) — the SAME object the edge gate and the sync handshake
   * decided from, so the UI cannot disagree with the server about what a guest may do.
   * Advisory only: it exists so the pad can hide affordances that would be refused, never
   * so the pad can grant anything. Every one of these is enforced server-side
   * (`worker/guest-gate.ts`, the room's read-only session, `worker/guest-socket-policy.ts`).
   * Optional so a pre-#320 edge still reads as a guest.
   */
  capabilities?: GuestCapabilities;
  /** Set = component-scoped link (PRD #221): render ONLY this shape's component, fullscreen. */
  shapeId?: string;
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
