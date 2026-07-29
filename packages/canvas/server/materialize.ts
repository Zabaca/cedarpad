// On-demand materialization (ADR-0022 decision 5): the container filesystem is a RENDERING of
// the Records, produced when vite asks for a module and finds nothing there.
//
// This is what replaces the boot restore — and replacing it is the point. The 2026-07-29 loss
// began with a restore that failed and was swallowed, so the container came up with an empty
// tree and the next write tarred that empty tree over the only copy. There can be no
// "boot restored nothing" bug where there is no boot restore.
//
// Two behaviours already in the client make a miss safe rather than fatal: `componentUrls()`
// walks own → shared → base, so a 404 on one tier is normal, and `component-loader.ts` retries
// with backoff, so a transient store blip lands in a window the browser already handles.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type ComponentRecords, componentRecordStore, materializeComponent } from './components.ts';

/** The own-tier module URL `src/component-loader.ts` builds: `/src/canvas-<id>/components/<Name>.tsx`.
 *  Anchored and character-classed, so a traversing path resolves to no Component at all. */
const OWN_MODULE_PATH = /^\/src\/canvas-([A-Za-z0-9][A-Za-z0-9_-]*)\/components\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/;

/** Pure: which Component (if any) a request path names. Null for the shared library, for the
 *  platform tier (image code, never a Record), and for every ordinary app module. */
export function parseComponentModulePath(url: string): { canvasId: string; module: string } | null {
  const m = OWN_MODULE_PATH.exec(url.split('?')[0] ?? '');
  return m ? { canvasId: m[1] as string, module: m[2] as string } : null;
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Connect-style, which is all vite's middleware stack is — kept structural so this is
 *  testable by calling it, with no dev server to stand up. */
type Req = { url?: string | undefined };
type Middleware = (req: Req, res: unknown, next: () => void) => void;

/**
 * Write the Record for a requested module to disk, then hand the request on so vite compiles
 * and serves it as it always has. Every outcome — no match, no Record, an unreachable store —
 * ends in `next()`: this middleware can make a request succeed, never fail.
 */
export function componentMaterializeMiddleware(records: ComponentRecords | null): Middleware {
  return (req, _res, next) => {
    const hit = records && req.url ? parseComponentModulePath(req.url) : null;
    if (!hit || existsSync(`${SRC}canvas-${hit.canvasId}/components/${hit.module}.tsx`)) return next();
    materializeComponent(hit.module, hit.canvasId, records)
      .catch((err) => {
        // A blip, not a crash: the client retries with backoff and falls through the tiers.
        console.error(`[materialize] ${hit.canvasId}/${hit.module}:`, err);
      })
      .finally(next);
  };
}

/** The vite plugin. Registered inside `configureServer`, so it sits AHEAD of vite's own
 *  transform middleware and the file exists by the time vite looks for it. */
export function componentMaterializePlugin(records: ComponentRecords | null = componentRecordStore) {
  return {
    name: 'cedarpad:materialize-components',
    configureServer(server: { middlewares: { use: (mw: Middleware) => void } }) {
      server.middlewares.use(componentMaterializeMiddleware(records));
    },
  };
}
