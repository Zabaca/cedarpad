// Scoped CRUD for agent-authored component modules. The agent can only touch a validated
// <Name>.tsx (no path escape) inside a canvas's own dir or the workspace shared library, so
// it stays in the locked sandbox while building a real, composable component library that
// vite compiles and the canvas dynamic-imports.
//
// Dirs (ADR-0007 Option B, mirrors src/component-loader.ts):
//   default canvas own dir → src/canvas-components/
//   other canvas own dir   → src/canvas-<id>/components/
//   workspace shared lib    → shared/components/   (the `@shared` alias)
// `promote` MOVES a module from a canvas's own dir into the shared lib (one live source);
// a canvas can `adopt` a shared module back into its own dir to diverge. Reads span the
// canvas's own dir + the shared lib.
//
// RECORDS (ADR-0022). Since the 2026-07-29 loss the OWN tier's truth is a row, not the file:
// `writeComponent` persists the Record first and writes the file second, and a read with no
// file materializes the Record on demand. The filesystem is a rendering — a cache vite
// compiles from — so a container that comes back with an empty tree is a slow first request,
// never a data event. There is deliberately NO boot restore: the failure mode that destroyed
// the workspace cannot exist where the step does not.
//
// The SHARED tier and data files still live only on disk; they move in later slices of #354.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertDataFileName, assertDataFileSource, COMPONENT_NAME_RE } from '../shared/bridge-wire.ts';
import type { ComponentVersion } from '../shared/platform-rpc.ts';
import { loadWebPocEnv, platformRpcFromEnv } from './platform-rpc-env.ts';

const DEFAULT_CANVAS_ID = 'default';
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared/components/', import.meta.url));
// The PLATFORM tier (ADR-0014): the image-baked seed library. Read-only at runtime —
// no tool ever writes here; editing a base module shadows it into the canvas own dir.
const BASE_DIR = `${SRC}canvas-components/`;
const NAME = COMPONENT_NAME_RE;
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

/**
 * The container's door to the Record store (ADR-0022): a Component named by its canvas and
 * module, never a row and never a query. Behind it is the platform RPC's `component.write` /
 * `component.read` — the container holds no database credential and never has.
 *
 * A default-parameter seam (the `bridge.ts` pattern), so the ordering rules below are
 * testable against a fake without a network or a D1.
 */
export interface ComponentRecords {
  /** Persist the own-tier source. THROWS when the store refuses or is unreachable. */
  write(canvasId: string, module: string, source: string): Promise<void>;
  /** The stored source, or null when the own tier holds no Record for that name. */
  read(canvasId: string, module: string): Promise<string | null>;
  /** Every version of the own-tier Component, newest first: who changed it and when. */
  history(canvasId: string, module: string): Promise<ComponentVersion[]>;
  /** Persist an own-tier DATA file (`sales.json`). Same rules, different door: the edge
   *  enforces the closed extension set and the size cap. THROWS when the store refuses. */
  writeData(canvasId: string, name: string, source: string): Promise<void>;
  /** The stored data-file content, or null when the own tier holds no Record for that name. */
  readData(canvasId: string, name: string): Promise<string | null>;
}

/**
 * Who a Record written by THIS container is attributed to (ADR-0022 decision 4). `CANVAS_USER`
 * is the deployment's single Better Auth `user.id` — see the `Env.CANVAS_USER` doc comment,
 * which is explicit that "a single static id can't represent whichever of N users is calling"
 * and that its unset fallback, the literal `'default'`, never matches a real authenticated
 * user.
 *
 * So: unset ⇒ **null**, not `'default'`. The bridge's Inbox call sites can afford a
 * placeholder because a row that matches nobody merely fails to appear; a version row is the
 * permanent answer to "who changed this", and a placeholder there is a history that LOOKS
 * attributed and is not. `updated_by`/`created_by` are nullable for exactly this state.
 */
export const recordAuthor = (env: Record<string, string | undefined>): string | null => env.CANVAS_USER || null;

/**
 * The env-wired store, or **null when there is no edge in front of this process** — local
 * dev without the Worker, and the unit suite. That is an explicit state, not a fallback: with
 * no store the filesystem is all there is, exactly as it was before this ADR.
 */
function containerRecords(): ComponentRecords | null {
  const env = loadWebPocEnv();
  const rpc = platformRpcFromEnv(env);
  if (!rpc) return null;
  // The container's identity, as every other container-side write already derives it
  // (worker/container-env.ts). `userId` is ATTRIBUTION — the edge decides permission itself.
  // 'default' is the legacy/prod workspace id (worker/shell-routing.ts DEFAULT_WORKSPACE_ID).
  const workspaceId = env.CANVAS_WORKSPACE || 'default';
  const userId = recordAuthor(env);
  return {
    write: async (canvasId, module, source) => void (await rpc.componentWrite({ workspaceId, canvasId, userId, name: module, source })),
    read: (canvasId, module) => rpc.componentRead({ workspaceId, canvasId, name: module }),
    history: (canvasId, module) => rpc.componentHistory({ workspaceId, canvasId, name: module }),
    writeData: async (canvasId, name, source) => void (await rpc.dataWrite({ workspaceId, canvasId, userId, name, source })),
    readData: (canvasId, name) => rpc.dataRead({ workspaceId, canvasId, name }),
  };
}

/** The store this process talks to, resolved once from env. Null = no edge in front of it. */
export const componentRecordStore = containerRecords();

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

/** The two tiers below the canvas's own: the workspace shared library, then the platform
 *  base. Both are still plain files (the shared tier becomes a Record in a later slice). */
function sharedOrBaseFile(module: string): string | null {
  const shared = fileIn(SHARED_DIR, module);
  if (existsSync(shared)) return shared;
  const base = fileIn(BASE_DIR, module);
  if (existsSync(base)) return base;
  return null;
}

/**
 * Write an own-tier Record's source to the file vite compiles from, and return it; null when
 * the store holds no such Component. This is the ONLY restore path there is — ADR-0022
 * decision 5 deletes boot restore rather than guarding it, so there can be no "boot restored
 * nothing" bug. One Component per call: a cold container pays for what is asked for, never
 * for the whole library.
 */
export async function materializeComponent(
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string | null> {
  if (!records) return null;
  const file = fileIn(ownDir(canvasId), module); // validates the name before we ask anything
  const source = await records.read(canvasId, module);
  if (source === null) return null;
  mkdirSync(ownDir(canvasId), { recursive: true });
  writeFileSync(file, source);
  // …and the data files it imports, because vite resolves those against the filesystem while
  // it transforms THIS module. A sibling that is still a row here is a broken card.
  for (const sibling of dataSiblingImports(source)) {
    if (existsSync(`${ownDir(canvasId)}${sibling}`)) continue;
    await materializeDataFile(sibling, canvasId, records);
  }
  return source;
}

/**
 * Own tier, then shared, then platform (ADR-0014 precedence, unchanged) — but the own tier is
 * now "the file OR its Record". Consulting the Record before falling through matters: writing
 * a platform module's name shadows it into the canvas, and after a recycle the shadow file is
 * gone while the Record is not. Falling straight through to base would silently hand back the
 * platform component the user deliberately replaced.
 */
export async function readComponent(
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string> {
  const own = fileIn(ownDir(canvasId), module);
  if (existsSync(own)) return readFileSync(own, 'utf8');
  const materialized = await materializeComponent(module, canvasId, records);
  if (materialized !== null) return materialized;
  const file = sharedOrBaseFile(module);
  if (file) return readFileSync(file, 'utf8');
  throw new Error(`component "${module}" does not exist (list_components to see what does)`);
}

/**
 * Create or overwrite a module — in the shared lib if it already lives there, else the
 * canvas's own dir. Editing a shared module thus stays the one shared source (propagation).
 *
 * ORDERING IS THE POINT (ADR-0022): the Record is persisted FIRST, and only then is the file
 * written. A store write that fails throws, so the tool call fails and the agent can retry;
 * the alternative — the old one — was a disk write that reported success and evaporated at
 * the next bad boot. The file write is best-effort by comparison: under on-demand
 * materialization it is only an HMR trigger.
 */
export async function writeComponent(
  module: string,
  source: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<void> {
  if (typeof source !== 'string' || source.trim().length === 0) throw new Error('source must be non-empty');
  const shared = isShared(module);
  const dir = shared ? SHARED_DIR : ownDir(canvasId);
  const file = fileIn(dir, module); // validates the name before we ask the store anything
  // The shared tier is still filesystem-only; it becomes a Record in a later slice of #354.
  if (!shared) await records?.write(canvasId, module, source);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, source);
  } catch (err) {
    // Only forgivable because the Record already landed: the next request materializes it.
    if (shared || !records) throw err;
    console.error(`[components] ${module}.tsx did not reach disk; it will materialize on next fetch:`, err);
  }
}

/**
 * What has happened to a Component: every version, newest first, with WHO wrote it and WHEN
 * (ADR-0022 decision 4). Before Records nothing in this product recorded either, which is why
 * the 2026-07-29 loss could only be reconstructed from chat transcripts.
 *
 * The history comes from the store and nowhere else — the filesystem holds exactly one
 * revision and no author at all — so with no edge in front of this process the honest answer
 * is "none", the same explicit state every other Record path has here.
 */
export async function componentHistory(
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<ComponentVersion[]> {
  fileIn(ownDir(canvasId), module); // validates the name before we ask anything
  return records ? await records.history(canvasId, module) : [];
}

// Data files live NEXT TO components so vite resolves `import data from "./sales.json"`.
// Non-executable extensions only — code must go through writeComponent (the registered,
// hot-reloading path); a data door that accepts .tsx would just be the bypass again.
//
// The name rule, the size cap and the JSON rule are one definition in `shared/bridge-wire.ts`,
// checked here so the agent gets the message without a round trip AND at the edge, which
// never trusts the container's payload. The cap is re-derived from what the store can hold
// (ADR-0022); the old 1 MiB number was justified by a tar sink that no longer exists.

/**
 * Create or overwrite a data file a component can import as a sibling — shared lib if it
 * already lives there (one shared source, like writeComponent), else the canvas own dir.
 *
 * Same ORDERING as `writeComponent` (ADR-0022): the Record is persisted first and the file
 * written second, so a store write that fails fails the tool call instead of reporting
 * success for content that will evaporate at the next recycle.
 */
export async function writeDataFile(
  name: string,
  source: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<void> {
  assertDataFileName(name);
  assertDataFileSource(name, source);
  const shared = existsSync(`${SHARED_DIR}${name}`);
  const dir = shared ? SHARED_DIR : ownDir(canvasId);
  // The shared tier is still filesystem-only; it becomes a Record in a later slice of #354.
  if (!shared) await records?.writeData(canvasId, name, source);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(`${dir}${name}`, source);
  } catch (err) {
    // Only forgivable because the Record already landed: the next request materializes it.
    if (shared || !records) throw err;
    console.error(`[components] ${name} did not reach disk; it will materialize on next fetch:`, err);
  }
}

/**
 * Write an own-tier data-file Record to the file vite reads, and return its content; null
 * when the store holds no such data file. The data-file half of `materializeComponent`.
 */
export async function materializeDataFile(
  name: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string | null> {
  if (!records) return null;
  assertDataFileName(name); // validates before we ask anything, and before any path is built
  const dir = ownDir(canvasId);
  const source = await records.readData(canvasId, name);
  if (source === null) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}${name}`, source);
  return source;
}

/**
 * Pure: the data siblings a module's source imports (`./sales.json`, `./notes.md?raw`).
 *
 * Why a Component cannot materialize alone: vite resolves a relative import against the
 * FILESYSTEM while it transforms the importing module, so a missing sibling is a failed
 * import analysis — the browser never gets as far as requesting the data file, and the card
 * is broken. The siblings have to be on disk by the time vite reads the module that imports
 * them, which means they come down WITH it.
 */
function dataSiblingImports(source: string): string[] {
  const re = /['"]\.\/([A-Za-z][A-Za-z0-9_-]*\.(?:json|csv|txt|md))(?:\?[^'"]*)?['"]/g;
  return [...new Set([...source.matchAll(re)].map((m) => m[1] as string))];
}

/** Per-line edit: replace a unique `oldStr` occurrence with `newStr`. Reads through
 *  `readComponent`, so an edit after a recycle patches the stored source rather than
 *  racing a file that is not there. */
export async function editComponent(
  module: string,
  oldStr: string,
  newStr: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<void> {
  const cur = await readComponent(module, canvasId, records);
  const first = cur.indexOf(oldStr);
  if (first === -1) throw new Error('old_string not found — read_component first and copy the exact text');
  if (cur.indexOf(oldStr, first + 1) !== -1) throw new Error('old_string is not unique — include more surrounding context');
  await writeComponent(module, cur.slice(0, first) + newStr + cur.slice(first + oldStr.length), canvasId, records);
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
