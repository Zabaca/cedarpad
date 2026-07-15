// Load an agent-authored component module from disk, in the browser, via vite.
//
// The agent writes real React files under src/canvas-components/; vite compiles
// each on demand (resolving its imports — react, other components, mermaid, data
// modules — exactly like any app module). We dynamic-import the file with a `rev`
// cache-bust so editing the file and bumping rev re-imports the recompiled module.
//
// This replaces the old in-browser sucrase + new Function path: components are now
// real, composable, editable source files rather than opaque code strings.

import type { ComponentType } from 'react';

export type AgentComponent = ComponentType<Record<string, unknown>>;

// Compiled module per (canvas, module, rev). A new rev = a new key = a fresh import.
const cache = new Map<string, Promise<AgentComponent>>();

// Every canvas — default included — owns its own dir under `src/canvas-<id>/components/`
// (ADR-0014: uniform canvas dirs; `src/canvas-components/` is the read-only PLATFORM tier
// every canvas resolves as its last fallback). #55 layers the `@shared` alias in between.
export const DEFAULT_CANVAS_ID = 'default';

/** The vite dev-server URL that serves a component module for a given canvas. Pure so
 * the per-canvas path resolution is unit-testable in isolation. `nonce` cache-busts a
 * failed first import; `rev` re-imports an edited module. */
export function componentUrl(module: string, rev: number, nonce: number, canvasId: string = DEFAULT_CANVAS_ID): string {
  return `/src/canvas-${canvasId}/components/${module}.tsx?r=${rev}&n=${nonce}`;
}

/** The platform (image-baked) library — the final fallback for every canvas. */
export function baseComponentUrl(module: string, rev: number, nonce: number): string {
  return `/src/canvas-components/${module}.tsx?r=${rev}&n=${nonce}`;
}

// The workspace shared library lives at `shared/components/` (vite root-relative), the same
// dir the `@shared` alias points at. #55: a placed instance references a shared module by
// its BARE name — unchanged by promote — and the loader resolves own-dir first, then here.
// So `promote` is a pure file MOVE with no store rewrite, and a component placed on another
// canvas by the same bare name resolves to the one shared source.
export function sharedComponentUrl(module: string, rev: number, nonce: number): string {
  return `/shared/components/${module}.tsx?r=${rev}&n=${nonce}`;
}

/** The URLs to try, in order, to resolve a placed module for a canvas: its own per-canvas
 * dir first, then the shared library, then the platform base (ADR-0014). A bare module name
 * is thus own-first with `@shared` and platform fallbacks — the "live single source,
 * promote = move" model (ADR-0007). Pure, so the resolution order is unit-testable. */
export function componentUrls(
  module: string,
  rev: number,
  ownNonce: number,
  sharedNonce: number,
  canvasId: string = DEFAULT_CANVAS_ID,
  baseNonce: number = sharedNonce + 1,
): string[] {
  return [
    componentUrl(module, rev, ownNonce, canvasId),
    sharedComponentUrl(module, rev, sharedNonce),
    baseComponentUrl(module, rev, baseNonce),
  ];
}

// The browser caches dynamic-import results by full URL, so a failed first import
// (file not ready) must NOT be retried at the same URL or it returns the cached
// failure. Give every attempt a unique query.
let attemptNonce = 0;

// Backoff between import retries (~total 4.5s). One initial attempt, then one more
// after each delay, so the total attempt budget is delays + 1.
const RETRY_DELAYS_MS = [200, 500, 900, 1500, 1500];

/** Total import attempts `importWithRetry` makes before it gives up. The per-host
 * load budget: when a load ultimately rejects, the ComponentHost reports this as the
 * `attempts` count on its `load_error` status. Single source of truth so the reported
 * count can't drift from the actual retry loop. */
export const LOAD_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

async function importWithRetry(module: string, rev: number, canvasId: string): Promise<AgentComponent> {
  // A just-placed component whose file landed a moment ago — or one caught in
  // vite's brief dep re-optimization window — can fail the first import. Retry a
  // few times with backoff (~total 4.5s) so a new component renders on its own,
  // no page refresh. (Caching a single failed import was the "had to refresh" bug.)
  // NB: param is `r`, NOT `v`. Vite reserves `?v=` for its dep-optimizer version
  // hashes and serves anything carrying it `Cache-Control: immutable` (1 year).
  // Using `?v=` made the browser cache an old compile of a component forever, so a
  // source edit that didn't bump rev kept re-serving the stale (often throwing)
  // module on every normal reload — only a hard refresh cleared it. Any non-`v`
  // param gets `no-cache` (etag revalidation), so reloads always pick up fresh source.
  const importFrom = async (url: string): Promise<AgentComponent> => {
    const m = await import(/* @vite-ignore */ url);
    const C = (m as { default?: unknown }).default;
    if (typeof C !== 'function') throw new Error(`Component "${module}" must \`export default\` a React component.`);
    return C as AgentComponent;
  };
  let lastErr: unknown;
  for (let i = 0; i < LOAD_ATTEMPTS; i++) {
    try {
      // Resolve own-dir first, then shared, then the platform base (#55, ADR-0014). A
      // promoted module is gone from the own dir, so that import 404s and the shared
      // source loads; a platform module 404s twice and lands on base. A canvas's own
      // module resolves on the first try and never touches the fallbacks.
      const urls = componentUrls(module, rev, (attemptNonce += 1), (attemptNonce += 1), canvasId, (attemptNonce += 1));
      let inner: unknown;
      for (const url of urls) {
        try {
          return await importFrom(url);
        } catch (e) {
          inner = e;
        }
      }
      throw inner;
    } catch (e) {
      lastErr = e;
      if (i < RETRY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
  }
  throw lastErr;
}

export function loadComponent(module: string, rev: number, canvasId: string = DEFAULT_CANVAS_ID): Promise<AgentComponent> {
  const key = `${canvasId}/${module}@${rev}`;
  let p = cache.get(key);
  if (!p) {
    p = importWithRetry(module, rev, canvasId);
    // Never leave a rejected promise cached — evict on failure so a later render
    // or rev bump retries from scratch instead of being permanently stuck.
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    cache.set(key, p);
  }
  return p;
}
