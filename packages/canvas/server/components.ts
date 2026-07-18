// Scoped filesystem CRUD for agent-authored component modules. The agent can only
// touch a validated <Name>.tsx (no path escape) inside a canvas's own dir or the
// workspace shared library, so it stays in the locked sandbox while building a real,
// composable component library that vite compiles and the canvas dynamic-imports.
//
// Dirs (ADR-0007 Option B, mirrors src/component-loader.ts):
//   default canvas own dir → src/canvas-components/
//   other canvas own dir   → src/canvas-<id>/components/
//   workspace shared lib    → shared/components/   (the `@shared` alias)
// `promote` MOVES a module from a canvas's own dir into the shared lib (one live source);
// a canvas can `adopt` a shared module back into its own dir to diverge. Reads span the
// canvas's own dir + the shared lib.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_CANVAS_ID = 'default';
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared/components/', import.meta.url));
// The PLATFORM tier (ADR-0014): the image-baked seed library. Read-only at runtime —
// no tool ever writes here; editing a base module shadows it into the canvas own dir.
const BASE_DIR = `${SRC}canvas-components/`;
const NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CANVAS_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The own component dir for a canvas — uniform for every canvas, default included
 * (ADR-0014: `src/canvas-components/` is the read-only platform tier, not default's own dir). */
function ownDir(canvasId: string = DEFAULT_CANVAS_ID): string {
  if (!CANVAS_ID.test(canvasId)) throw new Error(`invalid canvas id "${canvasId}"`);
  return `${SRC}canvas-${canvasId}/components/`;
}

function fileIn(dir: string, module: string): string {
  if (!NAME.test(module)) throw new Error(`invalid component name "${module}" — use letters/digits/_/- and no extension`);
  return `${dir}${module}.tsx`;
}

function namesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => f.replace(/\.tsx$/, ''));
}

/** Names (no extension) of every module a canvas can see: own dir ∪ shared lib ∪ platform base. */
export function listComponents(canvasId: string = DEFAULT_CANVAS_ID): string[] {
  return [...new Set([...namesIn(ownDir(canvasId)), ...namesIn(SHARED_DIR), ...namesIn(BASE_DIR)])].sort();
}

// Pure: the leading line-comment (or block-comment) of a module's source, as one
// line — agents open components with a describing comment, which the gallery shows
// as the card description. Empty string when there is none.
export function leadingComment(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (out.length === 0 && l === '') continue;
    if (l.startsWith('//')) out.push(l.replace(/^\/\/\s?/, ''));
    else if (out.length === 0 && l.startsWith('/*')) out.push(l.replace(/^\/\*+\s?/, '').replace(/\*+\/\s*$/, ''));
    else if (out.length > 0 && (l.startsWith('*') || l.endsWith('*/'))) out.push(l.replace(/^\*+\s?/, '').replace(/\*+\/\s*$/, ''));
    else break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

export type ComponentInfo = { name: string; description: string; tier: 'own' | 'shared' | 'base' };

/** listComponents enriched with each module's first-comment description + tier. */
export function listComponentDetails(canvasId: string = DEFAULT_CANVAS_ID): ComponentInfo[] {
  const own = ownDir(canvasId);
  return listComponents(canvasId).map((name) => {
    const dir = existsSync(fileIn(own, name)) ? own : existsSync(fileIn(SHARED_DIR, name)) ? SHARED_DIR : BASE_DIR;
    let description = '';
    try {
      description = leadingComment(readFileSync(fileIn(dir, name), 'utf8'));
    } catch {
      /* unreadable: name-only card */
    }
    return { name, description, tier: dir === own ? 'own' : dir === SHARED_DIR ? 'shared' : 'base' };
  });
}

/** True when the module lives in the shared library (and so is the workspace source). */
export function isShared(module: string): boolean {
  return existsSync(fileIn(SHARED_DIR, module));
}

/** Resolve the on-disk path of an existing module: own dir first, then shared, then platform. */
function resolveExisting(module: string, canvasId: string): string {
  const own = fileIn(ownDir(canvasId), module);
  if (existsSync(own)) return own;
  const shared = fileIn(SHARED_DIR, module);
  if (existsSync(shared)) return shared;
  const base = fileIn(BASE_DIR, module);
  if (existsSync(base)) return base;
  throw new Error(`component "${module}" does not exist (list_components to see what does)`);
}

export function readComponent(module: string, canvasId: string = DEFAULT_CANVAS_ID): string {
  return readFileSync(resolveExisting(module, canvasId), 'utf8');
}

/** Create or overwrite a module file — in the shared lib if it already lives there, else the
 * canvas's own dir. Editing a shared module thus stays the one shared source (propagation). */
export function writeComponent(module: string, source: string, canvasId: string = DEFAULT_CANVAS_ID): void {
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('source must be non-empty');
  const dir = isShared(module) ? SHARED_DIR : ownDir(canvasId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(fileIn(dir, module), source);
}

// Data files live NEXT TO components so vite resolves `import data from "./sales.json"`.
// Non-executable extensions only — code must go through writeComponent (the registered,
// hot-reloading path); a data door that accepts .tsx would just be the bypass again.
const DATA_NAME = /^[A-Za-z][A-Za-z0-9_-]*\.(json|csv|txt|md)$/;
const DATA_MAX_BYTES = 1_048_576; // the components sink tars the whole dir on every flush

/** Create or overwrite a data file a component can import as a sibling — shared lib if it
 * already lives there (one shared source, like writeComponent), else the canvas own dir. */
export function writeDataFile(name: string, source: string, canvasId: string = DEFAULT_CANVAS_ID): void {
  if (!DATA_NAME.test(name)) {
    throw new Error(`invalid data file name "${name}" — <letters/digits/_/->.(json|csv|txt|md); use write_component for code`);
  }
  if (Buffer.byteLength(source, 'utf8') > DATA_MAX_BYTES) throw new Error('data file too large (max 1MB)');
  if (name.endsWith('.json')) {
    try {
      JSON.parse(source);
    } catch {
      throw new Error('source is not valid JSON — a broken .json import breaks every component that imports it');
    }
  }
  const dir = existsSync(`${SHARED_DIR}${name}`) ? SHARED_DIR : ownDir(canvasId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}`, source);
}

/** Per-line edit: replace a unique `oldStr` occurrence with `newStr` in a module file. */
export function editComponent(module: string, oldStr: string, newStr: string, canvasId: string = DEFAULT_CANVAS_ID): void {
  const cur = readComponent(module, canvasId);
  const first = cur.indexOf(oldStr);
  if (first === -1) throw new Error('old_string not found — read_component first and copy the exact text');
  if (cur.indexOf(oldStr, first + 1) !== -1) throw new Error('old_string is not unique — include more surrounding context');
  writeComponent(module, cur.slice(0, first) + newStr + cur.slice(first + oldStr.length), canvasId);
}

/** Move a component from a canvas's own dir into the shared library (one live source).
 * Placed instances keep referencing it by bare name; the loader falls back to shared. */
export function promoteComponent(canvasId: string, module: string): void {
  const src = fileIn(ownDir(canvasId), module);
  if (!existsSync(src)) throw new Error(`component "${module}" is not in canvas "${canvasId}" own dir to promote`);
  const dest = fileIn(SHARED_DIR, module);
  if (existsSync(dest)) throw new Error(`a shared component "${module}" already exists`);
  if (!existsSync(SHARED_DIR)) mkdirSync(SHARED_DIR, { recursive: true });
  renameSync(src, dest);
}

/** Copy a shared component back into a canvas's own dir so that canvas can diverge (its own
 * dir then wins the loader's own-first resolution, decoupling it from later shared edits). */
export function adoptSharedComponent(canvasId: string, module: string): void {
  const src = fileIn(SHARED_DIR, module);
  if (!existsSync(src)) throw new Error(`no shared component "${module}" to copy`);
  const dir = ownDir(canvasId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  copyFileSync(src, fileIn(dir, module));
}
