// Per-canvas runtime state. A workspace hosts N canvases (ADR-0007); each owns its
// own CanvasStore, its own persistence (BlobStore is already keyed by (ws, canvas)),
// its own SSE subscriber set, its own save-health, and its own screenshot round-trip.
// The bridge keys these by `canvasId` through `createSessionRegistry` (lazy: a session
// is built on first access and reused thereafter). The DEFAULT canvas ('default') goes
// through the very same factory the legacy single-store path used, so its behavior is
// unchanged — it is just one entry in the registry now.

import type { CanvasState } from '../src/shapes.ts';
import { type CanvasStore, createStore } from '../src/store.ts';
import { primeIdCounter } from '../src/normalize.ts';
import type { BlobStore } from './blob-store.ts';
import { CanvasPersistence } from './canvas-persistence.ts';
import { type PresenceRoom, createPresenceRoom } from './presence.ts';

const enc = new TextEncoder();
const sse = (data: unknown) => enc.encode(`data: ${JSON.stringify(data)}\n\n`);

/** Persistence health for one canvas, surfaced at /api/status and logged on every flush. */
export interface SaveHealth {
  bootAt: number;
  liveVersion: number;
  savedVersion: number;
  lastAttemptAt: number;
  lastOkAt: number;
  lastResult: 'none' | 'ok' | 'skipped' | 'failed' | 'blocked';
  lastError: string | null;
  blockedShrink: { from: number; to: number } | null;
  pending: boolean;
}

/** Everything that used to be a module-level singleton in the bridge, now per-canvas. */
export interface CanvasSession {
  readonly canvasId: string;
  readonly store: CanvasStore;
  readonly persist: CanvasPersistence;
  readonly clients: Set<ReadableStreamDefaultController>;
  readonly saveHealth: SaveHealth;
  /** Ask the browser (over this canvas's SSE) for a PNG; resolves null if nobody's connected. */
  requestScreenshot(timeoutMs?: number): Promise<string | null>;
  /** Resolve a pending screenshot (the browser POSTs the PNG back, correlated by id). */
  resolveScreenshot(id: string, url: string | null): void;
  /** Ephemeral who's-here map (#212) — never persisted; staleness is the disconnect. */
  readonly presence: PresenceRoom;
  /** Push the merged presence set to every SSE client, throttled per room (~100ms). */
  broadcastPresence(): void;
}

/**
 * Build a canvas session: load its saved state, seed the store, and wire the
 * onChange → (save-health + debounced persist + SSE broadcast) pipeline. This is the
 * per-canvas extraction of the bridge's original inline store wiring; the default
 * canvas is behavior-preserving because it runs this exact code.
 */
export async function createCanvasSession(
  blobStore: BlobStore,
  workspace: string,
  canvasId: string,
): Promise<CanvasSession> {
  const persist = new CanvasPersistence(blobStore, workspace, canvasId);
  const clients = new Set<ReadableStreamDefaultController>();

  let restored: CanvasState | null = null;
  try {
    restored = await persist.load();
  } catch (err) {
    // Visible error (story 29): start degraded rather than silently handing back an
    // empty canvas. The guard then blocks an empty-over-known-good save.
    console.error(`[persist] canvas ${canvasId} state load failed; starting in degraded mode:`, err);
  }
  const seedShapes = restored?.shapes ?? [];
  primeIdCounter(seedShapes.map((s) => s.id));

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveHealth: SaveHealth = {
    bootAt: Date.now(),
    liveVersion: restored?.version ?? 0,
    savedVersion: restored ? (restored.version ?? 0) : -1, // best guess at what R2 holds
    lastAttemptAt: 0,
    lastOkAt: 0,
    lastResult: 'none',
    lastError: null,
    blockedShrink: null,
    pending: false,
  };

  const store = createStore(
    seedShapes,
    (state) => {
      // Save is TRIGGERED here on every real store mutation (version advanced),
      // debounced 1s so rapid edits coalesce into one R2 write.
      saveHealth.liveVersion = state.version;
      saveHealth.pending = true;
      console.log(`[persist] ${canvasId} change → v${state.version} (${state.shapes.length} shapes); flush scheduled`);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = null;
        const v = state.version;
        saveHealth.lastAttemptAt = Date.now();
        console.log(`[persist] ${canvasId} flushing v${v} → ${process.env.R2_BUCKET ? 'R2' : 'fs'}…`);
        persist
          .save(state)
          .then(async (wrote) => {
            saveHealth.pending = false;
            if (wrote) {
              saveHealth.lastResult = 'ok';
              saveHealth.savedVersion = v;
              saveHealth.lastOkAt = Date.now();
              saveHealth.blockedShrink = null;
              console.log(`[persist] ${canvasId} flush OK v${v}`);
            } else if (persist.blockedShrink) {
              // The destructive-shrink guard refused to overwrite a substantial canvas with a
              // near-empty one (a tldraw-crash nuke). The disk still holds the good state, so
              // reseed the LIVE store from it: the upsert's onChange re-broadcasts the restored
              // canvas to every browser and re-persists it, so the session self-heals with no
              // reload or restart.
              const { from, to } = persist.blockedShrink;
              saveHealth.lastResult = 'blocked';
              saveHealth.blockedShrink = persist.blockedShrink;
              console.warn(`[persist] ${canvasId} BLOCKED catastrophic shrink v${v}: ${from} → ${to} shapes (kept ${Math.round((100 * to) / from)}%). Disk preserved; reseeding live store from disk.`);
              try {
                const good = await persist.load();
                if (good) store.upsert(good.shapes);
              } catch (err) {
                console.error(`[persist] ${canvasId} reseed-from-disk failed; restart the bridge to recover the canvas:`, err);
              }
            } else {
              saveHealth.lastResult = 'skipped';
              console.log(`[persist] ${canvasId} flush SKIPPED v${v} (degraded + empty)`);
            }
          })
          .catch((err) => {
            saveHealth.pending = false;
            saveHealth.lastResult = 'failed';
            saveHealth.lastError = String((err as Error)?.message ?? err);
            console.error(`[persist] ${canvasId} flush FAILED v${v}:`, err);
          });
      }, 1000);
      for (const c of clients) {
        try {
          c.enqueue(sse(state));
        } catch {
          clients.delete(c);
        }
      }
    },
  );

  // Screenshot round-trip: the agent's view_canvas tool asks the browser (over SSE)
  // for a PNG of the live canvas; the browser renders via tldraw and POSTs it back,
  // correlated by id. Returns null if no browser is connected or it times out.
  let shotSeq = 0;
  const pendingShots = new Map<string, (url: string | null) => void>();
  function requestScreenshot(timeoutMs = 7000): Promise<string | null> {
    if (clients.size === 0) return Promise.resolve(null);
    const id = `shot${(shotSeq += 1)}`;
    const frame = enc.encode(`event: screenshot\ndata: ${JSON.stringify({ id })}\n\n`);
    for (const c of clients) {
      try {
        c.enqueue(frame);
      } catch {
        clients.delete(c);
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingShots.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingShots.set(id, (url) => {
        clearTimeout(timer);
        pendingShots.delete(id);
        resolve(url);
      });
    });
  }
  function resolveScreenshot(id: string, url: string | null): void {
    pendingShots.get(id)?.(url);
  }

  // Presence (#212): heartbeats mark the room dirty; one throttled `event: presence`
  // frame per window carries the whole merged set (N chatty clients ≠ N broadcasts).
  const presence = createPresenceRoom();
  let presenceTimer: ReturnType<typeof setTimeout> | null = null;
  function broadcastPresence(): void {
    if (presenceTimer) return; // a flush is already scheduled for this window
    presenceTimer = setTimeout(() => {
      presenceTimer = null;
      const frame = enc.encode(`event: presence\ndata: ${JSON.stringify({ entries: presence.snapshot() })}\n\n`);
      for (const c of clients) {
        try {
          c.enqueue(frame);
        } catch {
          clients.delete(c);
        }
      }
    }, 100);
  }

  return { canvasId, store, persist, clients, saveHealth, requestScreenshot, resolveScreenshot, presence, broadcastPresence };
}

/**
 * A lazy keyed registry: `get(canvasId)` builds a session on first access (via the
 * injected async factory) and returns the SAME promise on every later call, so a
 * canvasId maps to exactly one session. Distinct canvasIds get distinct sessions.
 * The factory is injected so the keying logic is unit-testable without any I/O.
 */
export function createSessionRegistry<T>(factory: (canvasId: string) => Promise<T>) {
  const map = new Map<string, Promise<T>>();
  // Values whose build promise has resolved, for a SYNCHRONOUS cross-canvas fan-out (the
  // shared-library rev-bump, #55): a settled session's store can be read without awaiting.
  const settled: T[] = [];
  return {
    get(canvasId: string): Promise<T> {
      let s = map.get(canvasId);
      if (!s) {
        s = factory(canvasId);
        map.set(canvasId, s);
        void s.then((v) => settled.push(v)).catch(() => map.delete(canvasId));
      }
      return s;
    },
    has: (canvasId: string): boolean => map.has(canvasId),
    /** Drop a canvas's session (close): the next get rebuilds it. Returns whether one existed. */
    delete: (canvasId: string): boolean => map.delete(canvasId),
    /** Sessions built so far (for cross-canvas fan-out, e.g. flush-all on idle exit). */
    resolved(): Promise<T>[] {
      return [...map.values()];
    },
    /** Sessions whose build already RESOLVED, read synchronously (cross-canvas rev-bump). */
    built(): T[] {
      return [...settled];
    },
  };
}
