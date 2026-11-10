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

import {
  type ComponentRecords,
  componentRecordStore,
  materializeComponent,
  materializeDataFile,
  materializeSharedComponent,
} from './components.ts';

/** The own-tier module URL `src/component-loader.ts` builds: `/src/canvas-<id>/components/<Name>.tsx`.
 *  Anchored and character-classed, so a traversing path resolves to no Component at all. */
const OWN_MODULE_PATH = /^\/src\/canvas-([A-Za-z0-9][A-Za-z0-9_-]*)\/components\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/;
/** The shared-library URL: `/shared/components/<Name>.tsx`, with the asking canvas in `?c=`. */
const SHARED_MODULE_PATH = /^\/shared\/components\/([A-Za-z][A-Za-z0-9_-]*)\.tsx$/;
const CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Pure: which Component (if any) a request path names, and in which tier. Null for the
 *  platform tier (image code, never a Record) and for every ordinary app module — and null
 *  for a shared request that names no canvas, because the canvas is how the edge proves the
 *  caller is entitled to that workspace's shared library. */
export function parseComponentModulePath(url: string): { tier: 'own' | 'shared'; canvasId: string; module: string } | null {
  const [path = '', query = ''] = url.split('?');
  const own = OWN_MODULE_PATH.exec(path);
  if (own) return { tier: 'own', canvasId: own[1] as string, module: own[2] as string };
  const shared = SHARED_MODULE_PATH.exec(path);
  if (!shared) return null;
  const canvasId = new URLSearchParams(query).get('c');
  return canvasId && CANVAS_ID.test(canvasId) ? { tier: 'shared', canvasId, module: shared[1] as string } : null;
}

/** The same own-tier directory, but a DATA sibling: the closed non-executable extension set,
 *  never `.tsx`. A data import is not the same request shape as a module one — vite tags it
 *  `?import` / `?raw` / `?t=` — so the query comes off before the extension is judged. */
const OWN_DATA_PATH = /^\/src\/canvas-([A-Za-z0-9][A-Za-z0-9_-]*)\/components\/([A-Za-z][A-Za-z0-9_-]*\.(?:json|csv|txt|md))$/;

/** Pure: which data file (if any) a request path names, `file` including its extension. */
export function parseDataModulePath(url: string): { canvasId: string; file: string } | null {
  const m = OWN_DATA_PATH.exec(url.split('?')[0] ?? '');
  return m ? { canvasId: m[1] as string, file: m[2] as string } : null;
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SHARED = fileURLToPath(new URL('../shared/components/', import.meta.url));

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
    if (!records || !req.url) return next();
    const mod = parseComponentModulePath(req.url);
    if (mod) {
      const file = mod.tier === 'shared' ? `${SHARED}${mod.module}.tsx` : `${SRC}canvas-${mod.canvasId}/components/${mod.module}.tsx`;
      if (existsSync(file)) return next();
      const materialize = mod.tier === 'shared' ? materializeSharedComponent : materializeComponent;
      void materialize(mod.module, mod.canvasId, records)
        .catch((err) => {
          // A blip, not a crash: the client retries with backoff and falls through the tiers.
          console.error(`[materialize] ${mod.tier} ${mod.canvasId}/${mod.module}:`, err);
        })
        .finally(next);
      return;
    }
    // A Component brings the data files it imports with it (see `materializeComponent`); a
    // data file is also servable on its own, for the request vite makes when only the
    // sibling is missing.
    const data = parseDataModulePath(req.url);
    if (!data) return next();
    if (existsSync(`${SRC}canvas-${data.canvasId}/components/${data.file}`)) return next();
    void materializeDataFile(data.file, data.canvasId, records)
      .catch((err) => {
        console.error(`[materialize] own ${data.canvasId}/${data.file}:`, err);
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
