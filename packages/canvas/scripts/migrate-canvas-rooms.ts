// Move every canvas's persisted `canvas-state.json` blob into its tldraw sync room
// (ADR-0019, #295). Same discipline as scripts/migrate-platform-data.ts: three explicit
// verbs a human runs one at a time, reading the output between each.
//
//   bun run scripts/migrate-canvas-rooms.ts dump   [--out <dir>] [--from <blobRoot>]
//   bun run scripts/migrate-canvas-rooms.ts load   --dump <dir> --target <origin|memory> [--force] [--accept-loss]
//   bun run scripts/migrate-canvas-rooms.ts verify --dump <dir> --target <origin|memory>
//
// WHAT IT MOVES: shapes. `dump` reads the blobs (R2, or a local directory via --from) and
// writes each canvas's blob plus the room snapshot reshaped from it (worker/blob-to-snapshot.ts).
// `load` POSTs each snapshot to /api/canvas-sync/<canvas>/snapshot. `verify` GETs each room
// back, decodes it to the simplified model, and diffs it field by field against the blob.
//
// OLD BLOBS ARE NEVER TOUCHED. There is no delete path anywhere in this file, by design:
// rollback is re-running `load --force`, not restoring a backup (ADR-0019).
//
// REFUSING TO CLOBBER: the destination guard is in the room, not here — POST answers 409
// if the room already has shapes. `--force` is the only way past it, and it is per-run,
// never per-canvas-implicit.
//
// TARGETS:
//   --target <origin>  a deployed or locally-running Worker (e.g. https://app.cedarpad.com).
//                      Needs an ADMIN session cookie in --cookie or CEDARPAD_COOKIE.
//   --target memory    a real TLSocketRoom hosted in THIS process, on the same schema.
//                      Nothing is deployed and nothing persists — it is the DRY RUN, and
//                      it exercises the identical reshape, validation and diff.
//
// DO NOT point --target at production without the human gate in #298.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { InMemorySyncStorage, type RoomSnapshot } from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { canvasStateKey, s3Backend, fsBackend, type BlobBackend } from '../server/blob-store.ts';
import type { CanvasShape, CanvasState } from '../src/shapes.ts';
import {
  blobToRoomSnapshot,
  canvasRecords,
  expectedShapes,
  invalidRecords,
  snapshotToShapes,
} from '../worker/blob-to-snapshot.ts';
import { handleSnapshotRequest } from '../worker/snapshot-io.ts';
import { createCanvasSyncRoom } from '../worker/sync-room.ts';

type Entry = { workspace: string; canvas: string; shapes: number; draw: number; danglingArrows: number };
type Manifest = { dumpedAt: string; canvases: Entry[] };

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

/** Every `workspaces/<ws>/canvases/<canvas>/canvas-state.json` the backend can see. */
function listCanvasBlobs(root: string): Array<{ workspace: string; canvas: string }> {
  const out: Array<{ workspace: string; canvas: string }> = [];
  for (const ws of readdirSync(join(root, 'workspaces'), { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    const canvasesDir = join(root, 'workspaces', ws.name, 'canvases');
    let canvases: string[];
    try {
      canvases = readdirSync(canvasesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // a workspace with no canvases yet
    }
    for (const canvas of canvases) out.push({ workspace: ws.name, canvas });
  }
  return out;
}

async function dump(outDir: string, from: string | undefined) {
  // --from is a local copy of the bucket; without it, R2 itself (read-only either way —
  // nothing in this file ever calls put/delete).
  const backend: BlobBackend = from ? fsBackend(from) : s3Backend();
  const pairs = from ? listCanvasBlobs(from) : await listFromR2(backend);

  mkdirSync(join(outDir, 'blobs'), { recursive: true });
  mkdirSync(join(outDir, 'snapshots'), { recursive: true });

  const canvases: Entry[] = [];
  for (const { workspace, canvas } of pairs) {
    const bytes = await backend.get(canvasStateKey(workspace, canvas));
    if (!bytes) continue;
    const state = JSON.parse(new TextDecoder().decode(bytes)) as CanvasState;
    const { dropped, dangling } = canvasRecords(state);
    const snapshot = blobToRoomSnapshot(state);

    // Validate HERE, at dump time, against the app's real schema. `loadSnapshot` does not
    // validate (see `invalidRecords`), so without this a bad record would be discovered
    // only when a client failed to open the room — after the cutover.
    const problems = invalidRecords(snapshot);
    if (problems.length > 0) {
      console.error(`\n❌ ${workspace}/${canvas}: ${problems.length} record(s) fail the canvas schema:`);
      for (const p of problems.slice(0, 10)) console.error(`   ${p}`);
      throw new Error('refusing to write a dump that cannot be loaded');
    }

    writeFileSync(join(outDir, 'blobs', `${workspace}__${canvas}.json`), JSON.stringify(state));
    writeFileSync(join(outDir, 'snapshots', `${workspace}__${canvas}.json`), JSON.stringify(snapshot));
    canvases.push({
      workspace,
      canvas,
      shapes: state.shapes.length,
      draw: dropped.filter((s) => s.type === 'draw').length,
      danglingArrows: dropped.filter((s) => s.type === 'arrow').length,
    });
    for (const d of dangling) {
      console.warn(`   ! ${canvas}: ${d.arrowId} ${d.terminal} was bound to ${d.toId}, which is not on this canvas`);
    }
  }

  const manifest: Manifest = { dumpedAt: new Date().toISOString(), canvases };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  report(canvases);
  console.log(`\n✅ dumped ${canvases.length} canvas(es) → ${outDir}`);
  console.log('   The source blobs are UNTOUCHED. Rollback is re-running `load --force`.');
}

/** R2 is flat, so the canvas list comes from the key layout itself. */
async function listFromR2(backend: BlobBackend): Promise<Array<{ workspace: string; canvas: string }>> {
  const keys = await backend.list('workspaces/');
  const out: Array<{ workspace: string; canvas: string }> = [];
  for (const key of keys) {
    const m = /^workspaces\/([^/]+)\/canvases\/([^/]+)\/canvas-state\.json$/.exec(key);
    if (m) out.push({ workspace: m[1] as string, canvas: m[2] as string });
  }
  return out;
}

function report(canvases: Entry[]) {
  console.log(
    `\n${'workspace / canvas'.padEnd(58)} ${'shapes'.padStart(7)} ${'draw'.padStart(6)} ${'badArrow'.padStart(9)}`,
  );
  console.log('-'.repeat(84));
  for (const c of canvases) {
    const name = `${c.workspace} / ${c.canvas}`;
    console.log(
      `${name.padEnd(58)} ${String(c.shapes).padStart(7)} ${String(c.draw).padStart(6)} ${String(c.danglingArrows).padStart(9)}`,
    );
  }
  console.log('-'.repeat(84));
  const shapes = canvases.reduce((a, c) => a + c.shapes, 0);
  const dropped = canvases.reduce((a, c) => a + c.draw, 0);
  const dangling = canvases.reduce((a, c) => a + c.danglingArrows, 0);
  console.log(
    `${'TOTAL'.padEnd(58)} ${String(shapes).padStart(7)} ${String(dropped).padStart(6)} ${String(dangling).padStart(9)}`,
  );
  if (dropped > 0) {
    console.log(
      `\n⚠️  ${dropped} freehand \`draw\` shape(s) are NOT migrated. The simplified blob keeps\n` +
        '   only flattened points, never tldraw\'s segments/pressure, so they cannot be rebuilt\n' +
        '   as records. They stay in the (retained) blob. See worker/blob-to-snapshot.ts.',
    );
  }
  if (dangling > 0) {
    console.log(
      `\n⚠️  ${dangling} arrow(s) are bound to a shape that is NOT on their canvas — the blob was\n` +
        '   already inconsistent. The WHOLE arrow is dropped, not just the binding: a bound\n' +
        '   terminal stores {0,0}, so keeping the arrow would draw a line to the origin, which\n' +
        '   looks like a rendering bug rather than like missing data.',
    );
  }
  if (dropped + dangling > 0) {
    console.log('\n   `load` will REFUSE this dump unless you pass --accept-loss.');
  }
}

// ---------------------------------------------------------------------------
// the destination
// ---------------------------------------------------------------------------

/** Both targets answer the same two requests, so `load`/`verify` have one code path. */
interface Destination {
  put(canvas: string, snapshot: RoomSnapshot, force: boolean): Promise<Response>;
  get(canvas: string): Promise<Response>;
}

function httpDestination(origin: string, cookie: string): Destination {
  const url = (canvas: string, q = '') => `${origin}/api/canvas-sync/${canvas}/snapshot${q}`;
  return {
    put: (canvas, snapshot, force) =>
      fetch(url(canvas, force ? '?force=1' : ''), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      }),
    get: (canvas) => fetch(url(canvas), { headers: { cookie } }),
  };
}

/** The dry run: one real `TLSocketRoom` per canvas, in this process, on the app schema.
 *  Same handler the Durable Object calls, so the 409-on-non-empty guard is exercised too. */
function memoryDestination(): Destination {
  const rooms = new Map<string, ReturnType<typeof createCanvasSyncRoom>>();
  const roomFor = (canvas: string) => {
    let room = rooms.get(canvas);
    if (!room) {
      room = createCanvasSyncRoom({ storage: new InMemorySyncStorage<TLRecord>() });
      rooms.set(canvas, room);
    }
    return room;
  };
  const req = (canvas: string, init?: RequestInit, q = '') =>
    new Request(`https://memory.invalid/api/canvas-sync/${canvas}/snapshot${q}`, init);
  return {
    put: (canvas, snapshot, force) =>
      handleSnapshotRequest(
        roomFor(canvas),
        req(canvas, { method: 'POST', body: JSON.stringify(snapshot) }, force ? '?force=1' : ''),
      ),
    get: (canvas) => handleSnapshotRequest(roomFor(canvas), req(canvas)),
  };
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

async function load(dest: Destination, dumpDir: string, force: boolean, acceptLoss: boolean): Promise<number> {
  const manifest = readManifest(dumpDir);

  // The unmigratable shapes are a DATA-LOSS decision, not a detail, and the retained blob
  // is their only remaining copy. An operator who does not read the dump output would
  // otherwise lose them silently, so the loss has to be acknowledged in the command line.
  const lost = manifest.canvases.filter((c) => c.draw + c.danglingArrows > 0);
  if (lost.length > 0 && !acceptLoss) {
    console.error('\n❌ this dump contains shapes that CANNOT be migrated — refusing to load.');
    for (const c of lost) {
      console.error(`   ${`${c.workspace} / ${c.canvas}`.padEnd(58)} ${c.draw} draw, ${c.danglingArrows} bad arrow(s)`);
    }
    console.error(
      '\n   They stay in the (retained, untouched) blob and will NOT appear in the room.\n' +
        '   Re-run with --accept-loss once that is what you intend.',
    );
    return 1;
  }

  let bad = 0;
  for (const c of manifest.canvases) {
    const snapshot = readJson<RoomSnapshot>(join(dumpDir, 'snapshots', `${c.workspace}__${c.canvas}.json`));
    const res = await dest.put(c.canvas, snapshot, force);
    const body = await res.text();
    if (res.ok) {
      console.log(`✓ ${c.canvas.padEnd(44)} ${body}`);
    } else {
      bad++;
      console.error(`✗ ${c.canvas.padEnd(44)} ${res.status} ${body}`);
    }
  }
  if (bad > 0) {
    console.error(`\n❌ ${bad} canvas(es) did not load. A 409 means the room already has content —`);
    console.error('   re-run with --force ONLY if replacing it is what you intend.');
    return 1;
  }
  console.log('\n✅ every canvas loaded — now run `verify`');
  return 0;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

/** Key-order-independent, so a field-order difference is never reported as a mismatch. */
const canonical = (s: CanvasShape): string =>
  JSON.stringify(Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))));

async function verify(dest: Destination, dumpDir: string): Promise<number> {
  const manifest = readManifest(dumpDir);
  let bad = 0;

  console.log(`\n${'canvas'.padEnd(46)} ${'blob'.padStart(6)} ${'room'.padStart(6)}  result`);
  console.log('-'.repeat(76));

  for (const c of manifest.canvases) {
    const state = readJson<CanvasState>(join(dumpDir, 'blobs', `${c.workspace}__${c.canvas}.json`));
    const res = await dest.get(c.canvas);
    if (!res.ok) {
      bad++;
      console.log(`${c.canvas.padEnd(46)} ${String(state.shapes.length).padStart(6)} ${'-'.padStart(6)}  ✗ ${res.status}`);
      continue;
    }
    const roomShapes = snapshotToShapes((await res.json()) as RoomSnapshot);

    // The two known-unmigratable cases (`draw`, and bindings to shapes that aren't on the
    // canvas) are normalized out by `expectedShapes` — they were counted and NAMED at dump
    // time. Everything else must match exactly, field for field.
    const expected = expectedShapes(state);
    const inRoom = new Map(roomShapes.map((s) => [s.id, s]));
    const problems: string[] = [];
    for (const want of expected) {
      const got = inRoom.get(want.id);
      if (!got) problems.push(`missing ${want.id} (${want.type})`);
      else if (canonical(got) !== canonical(want)) problems.push(`differs ${want.id} (${want.type})`);
    }
    for (const got of roomShapes) if (!expected.some((s) => s.id === got.id)) problems.push(`extra ${got.id}`);

    const ok = problems.length === 0;
    if (!ok) bad++;
    console.log(
      `${c.canvas.padEnd(46)} ${String(expected.length).padStart(6)} ${String(roomShapes.length).padStart(6)}  ` +
        `${ok ? '✓' : `✗ ${problems.length} problem(s)`}` +
        `${c.draw ? ` (+${c.draw} draw not migrated)` : ''}` +
        `${c.danglingArrows ? ` (+${c.danglingArrows} arrow(s) with dangling bindings dropped)` : ''}`,
    );
    for (const p of problems.slice(0, 10)) console.error(`      ${p}`);
    if (problems.length > 10) console.error(`      … ${problems.length - 10} more`);
  }

  console.log('-'.repeat(76));
  if (bad > 0) {
    console.error(`\n❌ ${bad} canvas(es) did not match. DO NOT cut over.`);
    return 1;
  }
  console.log('\n✅ every canvas matches its blob, shape for shape');
  return 0;
}

// ---------------------------------------------------------------------------

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const readManifest = (dir: string): Manifest => readJson<Manifest>(join(dir, 'manifest.json'));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function destination(): Destination {
  const target = flag('target') ?? 'memory';
  if (target === 'memory') return memoryDestination();
  const cookie = flag('cookie') ?? process.env.CEDARPAD_COOKIE;
  if (!cookie) throw new Error('an origin target needs --cookie <session cookie> (or CEDARPAD_COOKIE)');
  return httpDestination(target.replace(/\/$/, ''), cookie);
}

const USAGE = `usage:
  migrate-canvas-rooms.ts dump   [--out <dir>] [--from <blobRoot>]
  migrate-canvas-rooms.ts load   --dump <dir> [--target memory|<origin>] [--force] [--accept-loss]
  migrate-canvas-rooms.ts verify --dump <dir> [--target memory|<origin>] [--accept-loss]

--force       replace a room that already has content (the room answers 409 otherwise).
--accept-loss acknowledge that draw shapes and arrows with dangling bindings will NOT be
              migrated. Without it, load refuses any dump that contains them.
--target defaults to "memory": a real room in THIS process. That is the dry run.
An <origin> target needs an ADMIN session cookie (--cookie / CEDARPAD_COOKIE).
dump reads R2 (R2_* env) unless --from names a local copy of the bucket, and writes
OUTSIDE the repo by default: ~/cedarpad-canvas-dumps/<timestamp>/
Old blobs are never written or deleted.`;

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'dump') {
    const out =
      flag('out') ?? join(homedir(), 'cedarpad-canvas-dumps', new Date().toISOString().replace(/[:.]/g, '-'));
    await dump(out, flag('from'));
  } else if (cmd === 'load' || cmd === 'verify') {
    const dir = flag('dump');
    if (!dir) throw new Error(`${cmd} needs --dump <dir>`);
    const dest = destination();
    // memory: `verify` alone would read empty rooms, so it loads first — the dry run is
    // load+verify in one process, which is exactly the round trip it is meant to prove.
    if ((flag('target') ?? 'memory') === 'memory' && cmd === 'verify') {
      const code = await load(dest, dir, false, process.argv.includes('--accept-loss'));
      if (code !== 0) process.exit(code);
    }
    process.exit(
      cmd === 'load'
        ? await load(dest, dir, process.argv.includes('--force'), process.argv.includes('--accept-loss'))
        : await verify(dest, dir),
    );
  } else {
    console.log(USAGE);
    process.exit(1);
  }
}
