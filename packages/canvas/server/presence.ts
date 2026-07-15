// Per-canvas presence (#212): who is looking, where their cursor is, what their
// camera sees. Ephemeral by design — an in-memory map per canvas, never persisted,
// entries expire by heartbeat staleness (a closed tab just stops beating). The
// bridge broadcasts the merged set over the EXISTING canvas SSE stream as
// `event: presence` frames, throttled per room so N chatty clients cost one
// broadcast per window, not N.

// One contract, both sides (guideline 7): the wire type lives in src/presence.ts
// (the client authors beats and parses broadcasts); parseHeartbeat below is the
// bridge-side runtime guard of the same shape. Type-only import — erased at
// runtime, so the bridge never evaluates the client module (which pulls tldraw).
import type { PresenceEntry } from '../src/presence.ts';

export type { PresenceEntry };

const STALE_MS = 10_000;

export type PresenceRoom = ReturnType<typeof createPresenceRoom>;

export function createPresenceRoom(now: () => number = Date.now) {
  const entries = new Map<string, PresenceEntry & { updatedAt: number }>();
  return {
    /** Merge one client heartbeat. */
    beat(e: PresenceEntry): void {
      entries.set(e.userId, { ...e, updatedAt: now() });
    },
    /** The live set (prunes stale entries as it reads). */
    snapshot(): PresenceEntry[] {
      const cutoff = now() - STALE_MS;
      const live: PresenceEntry[] = [];
      for (const [id, e] of entries) {
        if (e.updatedAt < cutoff) entries.delete(id);
        else {
          const { updatedAt: _, ...rest } = e;
          live.push(rest);
        }
      }
      return live;
    },
  };
}

/** Parse one heartbeat body; null when malformed (the route answers 400). */
export function parseHeartbeat(body: unknown): PresenceEntry | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.userId !== 'string' || !b.userId || typeof b.color !== 'string') return null;
  const point = (v: unknown): { x: number; y: number } | null =>
    typeof v === 'object' && v !== null && typeof (v as { x: unknown }).x === 'number' && typeof (v as { y: unknown }).y === 'number'
      ? { x: (v as { x: number }).x, y: (v as { y: number }).y }
      : null;
  const cam = (v: unknown): { x: number; y: number; z: number } | null => {
    const p = point(v);
    return p && typeof (v as { z: unknown }).z === 'number' ? { ...p, z: (v as { z: number }).z } : null;
  };
  return {
    userId: b.userId,
    ...(typeof b.name === 'string' && b.name ? { name: b.name } : {}),
    color: b.color,
    cursor: point(b.cursor),
    camera: cam(b.camera),
  };
}
