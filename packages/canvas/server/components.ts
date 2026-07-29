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
// RECORDS (ADR-0022). Since the 2026-07-29 loss both WRITABLE tiers' truth is a row, not the
// file: `writeComponent` persists the Record first and writes the file second, and a read with
// no file materializes the Record on demand. The filesystem is a rendering — a cache vite
// compiles from — so a container that comes back with an empty tree is a slow first request,
// never a data event. There is deliberately NO boot restore: the failure mode that destroyed
// the workspace cannot exist where the step does not.
//
// `promote` is therefore no longer a rename(2) but ONE change of tier at the store, and the
// disk is re-rendered from the result. That ordering is the whole point: a promote whose
// shared write was lost after the own copy had gone made placed instances resolve to a
// same-named PLATFORM component and render with the wrong props — silent substitution, worse
// than a 404, because a missing card is visible and a wrong card is not.
//
// The PLATFORM tier stays image-only, and data files still live only on disk (slice #360).

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertDataFileName, assertDataFileSource, COMPONENT_NAME_RE } from '../shared/bridge-wire.ts';
import type { ComponentTier, ComponentVersion } from '../shared/platform-rpc.ts';
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
  /** Persist the source in one of the two writable tiers. `canvasId` is always the canvas
   *  the write is performed FROM — for a shared write it is the entitlement proof, which is
   *  why it is present even though the shared library has no canvas of its own.
   *  THROWS when the store refuses or is unreachable. */
  write(tier: ComponentTier, canvasId: string, module: string, source: string): Promise<void>;
  /** The stored source, or null when that tier holds no Record for that name. */
  read(tier: ComponentTier, canvasId: string, module: string): Promise<string | null>;
  /** Every version of the Component in that tier, newest first: who changed it and when. */
  history(tier: ComponentTier, canvasId: string, module: string): Promise<ComponentVersion[]>;
  /** Make an earlier version of that tier's Component current again, returning the NEW
   *  revision — null when there is no such version. A VERSION number goes out; the source is
   *  read and re-put on the store's own side and never comes back through here. */
  restore(tier: ComponentTier, canvasId: string, module: string, version: number): Promise<number | null>;
  /** Move the Component from this canvas into the shared library — one change of tier, so it
   *  can never end up in both libraries or in neither. THROWS with the store's reason. */
  promote(canvasId: string, module: string): Promise<void>;
  /** Copy the shared Component into this canvas's own tier so it can diverge deliberately. */
  adopt(canvasId: string, module: string): Promise<void>;
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
    write: async (tier, canvasId, module, source) =>
      void (await rpc.componentWrite({ workspaceId, canvasId, tier, userId, name: module, source })),
    read: (tier, canvasId, module) => rpc.componentRead({ workspaceId, canvasId, tier, name: module }),
    history: (tier, canvasId, module) => rpc.componentHistory({ workspaceId, canvasId, tier, name: module }),
    restore: (tier, canvasId, module, version) =>
      rpc.componentRestore({ workspaceId, canvasId, tier, userId, name: module, version }),
    promote: async (canvasId, module) => void (await rpc.componentPromote({ workspaceId, canvasId, userId, name: module })),
    adopt: async (canvasId, module) => void (await rpc.componentAdopt({ workspaceId, canvasId, userId, name: module })),
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

/**
 * True when the module IS the workspace's shared source — which the Record decides, not the
 * file. After a recycle the shared file is gone while its Record is not, and answering from
 * disk alone would send the next edit into the canvas's own tier: a silent fork of the one
 * live source, exactly what promote exists to prevent.
 */
export async function isShared(
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<boolean> {
  if (existsSync(fileIn(SHARED_DIR, module))) return true;
  return records ? (await records.read('shared', canvasId, module)) !== null : false;
}

/** The platform tier: image code, never a Record, never written. The last thing tried. */
function baseFile(module: string): string | null {
  const base = fileIn(BASE_DIR, module);
  return existsSync(base) ? base : null;
}

/**
 * Write a Record's source to the file vite compiles from, and return it; null when that tier
 * holds no such Component. This is the ONLY restore path there is — ADR-0022 decision 5
 * deletes boot restore rather than guarding it, so there can be no "boot restored nothing"
 * bug. One Component per call: a cold container pays for what is asked for, never for the
 * whole library.
 */
async function materializeInto(
  tier: ComponentTier,
  module: string,
  canvasId: string,
  records: ComponentRecords | null,
): Promise<string | null> {
  if (!records) return null;
  const dir = tier === 'shared' ? SHARED_DIR : ownDir(canvasId);
  const file = fileIn(dir, module); // validates the name before we ask anything
  const source = await records.read(tier, canvasId, module);
  if (source === null) return null;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, source);
  // …and the data files it imports, because vite resolves those against the filesystem while
  // it transforms THIS module. A sibling that is still a row here is a broken card.
  for (const sibling of dataSiblingImports(source)) {
    if (existsSync(`${ownDir(canvasId)}${sibling}`)) continue;
    await materializeDataFile(sibling, canvasId, records);
  }
  return source;
}

/** Materialize the canvas's OWN copy of a module (the vite middleware's path). */
export const materializeComponent = (
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string | null> => materializeInto('own', module, canvasId, records);

/** Materialize the workspace SHARED copy. `canvasId` is the canvas asking — the edge proves
 *  entitlement to the workspace's library through it, so a shared read still names one. */
export const materializeSharedComponent = (
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string | null> => materializeInto('shared', module, canvasId, records);

/**
 * Own tier, then shared, then platform (ADR-0014 precedence, unchanged) — but each writable
 * tier is now "the file OR its Record". Consulting the Record before falling through matters:
 * writing a platform module's name shadows it into the canvas, and after a recycle the shadow
 * file is gone while the Record is not. Falling straight through to base would silently hand
 * back the platform component the user deliberately replaced — the substitution that made
 * three promoted cards render blank with no error anywhere.
 */
export async function readComponent(
  module: string,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<string> {
  const own = fileIn(ownDir(canvasId), module);
  if (existsSync(own)) return readFileSync(own, 'utf8');
  const ownRecord = await materializeComponent(module, canvasId, records);
  if (ownRecord !== null) return ownRecord;

  const shared = fileIn(SHARED_DIR, module);
  if (existsSync(shared)) return readFileSync(shared, 'utf8');
  const sharedRecord = await materializeSharedComponent(module, canvasId, records);
  if (sharedRecord !== null) return sharedRecord;

  const base = baseFile(module);
  if (base) return readFileSync(base, 'utf8');
  throw new Error(`component "${module}" does not exist (list_components to see what does)`);
}

/**
 * Which writable tier a canvas resolves a module in — the SAME first-match-wins walk a read
 * does, own before shared. An overwrite therefore edits the source that canvas actually
 * resolves: editing a shared module stays the one shared source (propagation), unless this
 * canvas adopted it, which is what adopting is FOR. Falls back to own, which is where a new
 * module is born, and it is also the tier whose history a canvas is asking about.
 *
 * Files first, Records second: on a live container the file answers for free, and only a
 * container that has lost its tree pays for the round trips.
 */
async function resolvedTier(module: string, canvasId: string, records: ComponentRecords | null): Promise<ComponentTier> {
  if (existsSync(fileIn(ownDir(canvasId), module))) return 'own';
  if (existsSync(fileIn(SHARED_DIR, module))) return 'shared';
  if (records) {
    if ((await records.read('own', canvasId, module)) !== null) return 'own';
    if ((await records.read('shared', canvasId, module)) !== null) return 'shared';
  }
  return 'own';
}

/**
 * Create or overwrite a module — in the tier that canvas already resolves it from, else the
 * canvas's own library.
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
  const shared = (await resolvedTier(module, canvasId, records)) === 'shared';
  const dir = shared ? SHARED_DIR : ownDir(canvasId);
  const file = fileIn(dir, module); // validates the name before we ask the store anything
  await records?.write(shared ? 'shared' : 'own', canvasId, module, source);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, source);
  } catch (err) {
    // Only forgivable because the Record already landed: the next request materializes it.
    if (!records) throw err;
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
  if (!records) return [];
  // The history of the Component this canvas RESOLVES: a promoted module's past lives under
  // the shared key, and asking the own tier for it would answer "no history" about a
  // Component that has one.
  return await records.history(await resolvedTier(module, canvasId, records), canvasId, module);
}

/**
 * Put a Component back the way it was at an earlier version (#362), returning the NEW revision
 * the restore created. This is what turns history into recovery: before Records, undoing a bad
 * edit meant production credentials and a database fork at a timestamp.
 *
 * A restore is a FORWARD WRITE. It appends a version rather than truncating the ones after the
 * chosen point, so nothing is erased and the restore is itself undoable — a "recover" that
 * destroyed history would just be a second way to lose work.
 *
 * WHERE THE SOURCE LIVES: not here. This sends a version NUMBER; the store reads that version
 * and re-puts it on its own side. What comes back is a revision. The `materializeComponent`
 * that follows is the ORDINARY render path — the same call any read after a recycle makes —
 * and it exists because the stale file on disk is what vite compiles until something replaces
 * it. Moving the row alone would leave the canvas rendering the bad edit.
 */
export async function restoreComponent(
  module: string,
  version: number,
  canvasId: string = DEFAULT_CANVAS_ID,
  records: ComponentRecords | null = componentRecordStore,
): Promise<number> {
  fileIn(ownDir(canvasId), module); // validates the name before we ask anything
  // No edge in front of this process ⇒ no version rows anywhere. Succeeding here would be a
  // recovery that recovered nothing, which is precisely the silent shape ADR-0022 removes.
  if (!records) throw new Error(`no version history for "${module}" — this workspace has no Record store in front of it`);
  // The SAME walk `componentHistory` uses, and that is the point: a restore must act on the
  // Component whose history the caller was just shown. Choosing the tiers differently would
  // let `component_history` list a promoted module's past while the restore quietly rebuilt
  // it in the canvas's own library — a fork of the one live source, which promote exists to
  // prevent.
  const tier = await resolvedTier(module, canvasId, records);
  const rev = await records.restore(tier, canvasId, module, version);
  if (rev === null) throw new Error(`no version ${version} of "${module}" — component_history lists the versions that exist`);
  await (tier === 'shared' ? materializeSharedComponent : materializeComponent)(module, canvasId, records);
  return rev;
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

/**
 * Move a component from a canvas's own library into the workspace shared library (one live
 * source). Placed instances keep referencing it by bare name; the loader falls back to shared.
 *
 * The STORE performs the move — one change of tier, so the Component is never in both
 * libraries and never in neither — and only then is the disk re-rendered from the result, in
 * the order that keeps a half-finished render harmless: the shared file lands BEFORE the own
 * file goes, so no instant exists where the name resolves past both writable tiers and onto a
 * same-named platform component.
 */
export async function promoteComponent(
  canvasId: string,
  module: string,
  records: ComponentRecords | null = componentRecordStore,
): Promise<void> {
  const src = fileIn(ownDir(canvasId), module); // validates the name before anything else
  const dest = fileIn(SHARED_DIR, module);
  if (!records) {
    // No edge in front of this process (local dev without the Worker, the unit suite): the
    // filesystem is the only truth there is, so the move IS the promote.
    if (!existsSync(src)) throw new Error(`component "${module}" is not in canvas "${canvasId}" own dir to promote`);
    if (existsSync(dest)) throw new Error(`a shared component "${module}" already exists`);
    if (!existsSync(SHARED_DIR)) mkdirSync(SHARED_DIR, { recursive: true });
    renameSync(src, dest);
    return;
  }
  await records.promote(canvasId, module); // throws → nothing moved, the own copy is untouched
  await materializeSharedComponent(module, canvasId, records);
  if (existsSync(src)) rmSync(src);
}

/** Copy a shared component back into a canvas's own library so that canvas can diverge (its
 * own tier then wins own-first resolution, decoupling it from later shared edits). */
export async function adoptSharedComponent(
  canvasId: string,
  module: string,
  records: ComponentRecords | null = componentRecordStore,
): Promise<void> {
  const src = fileIn(SHARED_DIR, module);
  if (!records) {
    if (!existsSync(src)) throw new Error(`no shared component "${module}" to copy`);
    const dir = ownDir(canvasId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(src, fileIn(dir, module));
    return;
  }
  await records.adopt(canvasId, module);
  await materializeComponent(module, canvasId, records);
}
