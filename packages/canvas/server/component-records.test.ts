import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { componentStore } from '../worker/component-store.ts';
import { deleteCanvasRecords } from '../worker/record-reclaim.ts';
import { memRecordStore } from '../worker/record-store.ts';
import {
  adoptSharedComponent,
  type ComponentRecords,
  componentHistory,
  editComponent,
  isShared,
  materializeComponent,
  materializeDataFile,
  promoteComponent,
  readComponent,
  recordAuthor,
  restoreComponent,
  writeComponent,
  writeDataFile,
} from './components.ts';

// Records (ADR-0022): a Component's source is a ROW, and the file vite compiles from is a
// rendering of it. These tests drive the container half — the ordering rule (store first,
// then disk), tier resolution, and materialization on a miss — against the REAL policy layer
// over the in-memory Record port, so none of it needs D1 and none of it re-implements the
// rules it is checking. Only the network hop is faked.
//
// Built from the failure: on 2026-07-29 a write succeeded to disk, reported success, and was
// gone after the next boot. "The store accepted it" is now the thing being asserted.

const CANVAS = 'cvrecordstest';
const dirPath = fileURLToPath(new URL(`../src/canvas-${CANVAS}/`, import.meta.url));
const filePath = (name: string) => `${dirPath}components/${name}.tsx`;
const sharedDir = fileURLToPath(new URL('../shared/components/', import.meta.url));
const sharedPath = (name: string) => `${sharedDir}${name}.tsx`;

/** Shared-library files land in the real workspace library, so name them uniquely and sweep. */
const SHARED_NAMES = ['Tmp_RecordsShared', 'MarkdownCard'];

afterEach(() => {
  if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });
  for (const n of SHARED_NAMES) if (existsSync(sharedPath(n))) rmSync(sharedPath(n));
});

const WS = 'ws_records_test';

/**
 * The container's door to the store, wired to the REAL `ComponentStore` over the in-memory
 * Record port — the same policy the edge runs, minus the HTTP hop. `failMove` reproduces the
 * one failure that matters here: a promote the store refuses.
 */
function fakeRecords(opts: { failWrite?: boolean; failRead?: boolean; failMove?: boolean } = {}) {
  const port = memRecordStore();
  // Data files keep their own plain map: they are a different door with different rules
  // (#360), and this file only needs them to round-trip, not to re-test that policy.
  const rows = new Map<string, string>();
  const store = componentStore(
    opts.failMove ? { ...port, move: async () => { throw new Error('the workspace store refused this write'); } } : port,
  );
  const calls: string[] = [];
  const key = (tier: 'own' | 'shared', canvasId: string, name: string) => ({
    workspaceId: WS,
    canvasId: tier === 'shared' ? null : canvasId,
    name,
  });
  const records: ComponentRecords = {
    write: async (tier, canvasId, module, source) => {
      calls.push(`write ${tier} ${canvasId}/${module}`);
      if (opts.failWrite) throw new Error('the workspace store refused this write');
      await store.write({ ...key(tier, canvasId, module), source, userId: 'u_author' });
    },
    read: async (tier, canvasId, module) => {
      calls.push(`read ${tier} ${canvasId}/${module}`);
      return await store.read(key(tier, canvasId, module));
    },
    promote: async (canvasId, module) => {
      calls.push(`promote ${canvasId}/${module}`);
      await store.promote({ workspaceId: WS, canvasId, name: module, userId: 'u_author' });
    },
    adopt: async (canvasId, module) => {
      calls.push(`adopt ${canvasId}/${module}`);
      await store.adopt({ workspaceId: WS, canvasId, name: module, userId: 'u_author' });
    },
    history: async (tier, canvasId, module) => {
      calls.push(`history ${tier} ${canvasId}/${module}`);
      return await store.history(key(tier, canvasId, module));
    },
    restore: async (tier, canvasId, module, version) => {
      calls.push(`restore ${tier} ${canvasId}/${module}@${version}`);
      return (await store.restore({ ...key(tier, canvasId, module), version, userId: 'u_author' }))?.rev ?? null;
    },
    writeData: async (canvasId, name, source) => {
      calls.push(`writeData ${canvasId}/${name}`);
      if (opts.failWrite) throw new Error('the workspace store refused this write');
      rows.set(`${canvasId}/${name}`, source);
    },
    readData: async (canvasId, name) => {
      calls.push(`readData ${canvasId}/${name}`);
      if (opts.failRead) throw new Error('the workspace store is unreachable');
      return rows.get(`${canvasId}/${name}`) ?? null;
    },
  };
  /** What the store actually holds — the question every one of these tests is really asking. */
  const stored = (tier: 'own' | 'shared', module: string, canvasId = CANVAS) => store.read(key(tier, canvasId, module));
  return { records, stored, rows, calls, port };
}

describe('write_component persists a Record before it touches disk', () => {
  test('the source lands in the store, and the file is written as the HMR trigger', async () => {
    const { records, stored } = fakeRecords();
    await writeComponent('Card', 'export default () => null;', CANVAS, records);

    expect(await stored('own', 'Card')).toBe('export default () => null;');
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('export default () => null;');
  });

  test('a store write failure FAILS the tool call and leaves no file behind', async () => {
    const { records } = fakeRecords({ failWrite: true });

    await expect(writeComponent('Card', 'v1', CANVAS, records)).rejects.toThrow(/refused this write/);
    // The whole point of store-first: the agent is not told "written" for source that is not.
    expect(existsSync(filePath('Card'))).toBe(false);
  });

  test('an invalid name is refused before anything is stored', async () => {
    const { records, calls } = fakeRecords();
    await expect(writeComponent('../escape', 'v1', CANVAS, records)).rejects.toThrow(/invalid component name/);
    expect(calls).toEqual([]);
  });
});

describe('a Component survives the container losing its filesystem', () => {
  test('read materializes the Record on a miss and leaves the file for vite to compile', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);

    // The recycle: the container comes back with an empty tree. There is no boot restore.
    rmSync(dirPath, { recursive: true, force: true });
    expect(existsSync(filePath('Card'))).toBe(false);

    expect(await readComponent('Card', CANVAS, records)).toBe('v1');
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('v1');
  });

  test('materializing asks the store for ONE Component, not the whole library', async () => {
    const { records, calls } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Other', 'v2', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });
    calls.length = 0;

    await materializeComponent('Card', CANVAS, records);
    expect(calls).toEqual([`read own ${CANVAS}/Card`]);
    expect(existsSync(filePath('Other'))).toBe(false);
  });

  test('materializing something the store has never held answers null, not an error', async () => {
    const { records } = fakeRecords();
    expect(await materializeComponent('Ghost', CANVAS, records)).toBeNull();
  });

  test('reading a Component that exists in neither place throws the same error as before', async () => {
    const { records } = fakeRecords();
    await expect(readComponent('Ghost', CANVAS, records)).rejects.toThrow(/does not exist/);
  });

  test('a shadowed platform module still resolves to the shadow, not back to base', async () => {
    // Writing a base name shadows it into the canvas's own tier. After a recycle the own FILE
    // is gone but the Record is not — and own must still beat base, or the canvas silently
    // reverts to the platform component the user deliberately replaced.
    const { records } = fakeRecords();
    await writeComponent('KpiCard', '// shadowed\n', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    expect(await readComponent('KpiCard', CANVAS, records)).toBe('// shadowed\n');
  });

  test('a file already on disk is served without asking the store', async () => {
    const { records, calls } = fakeRecords();
    mkdirSync(`${dirPath}components/`, { recursive: true });
    writeFileSync(filePath('Card'), 'from disk');

    expect(await readComponent('Card', CANVAS, records)).toBe('from disk');
    expect(calls).toEqual([]);
  });
});

describe('the shared library is a Record too — own, then shared, then platform', () => {
  const SH = 'Tmp_RecordsShared';

  test('a shared Component resolves for a canvas that does not shadow it, after a recycle', async () => {
    const { records } = fakeRecords();
    await writeComponent(SH, 'own source', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    rmSync(dirPath, { recursive: true, force: true });
    rmSync(sharedPath(SH));

    // Nothing on disk anywhere, and still every canvas in the workspace resolves it.
    expect(await readComponent(SH, CANVAS, records)).toBe('own source');
    expect(await readComponent(SH, 'cvsomeothercanvas', records)).toBe('own source');
    expect(readFileSync(sharedPath(SH), 'utf8')).toBe('own source'); // materialized where vite looks
  });

  test("a canvas's own Component shadows a shared one of the same name", async () => {
    const { records } = fakeRecords();
    await writeComponent(SH, 'shared source', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    await adoptSharedComponent(CANVAS, SH, records);
    await writeComponent(SH, 'diverged', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });
    rmSync(sharedPath(SH));

    expect(await readComponent(SH, CANVAS, records)).toBe('diverged');
    expect(await readComponent(SH, 'cvsomeothercanvas', records)).toBe('shared source');
  });

  test('editing a promoted Component writes back to the shared Record, not a new own copy', async () => {
    const { records, stored } = fakeRecords();
    await writeComponent(SH, 'const v = "v1";', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    rmSync(dirPath, { recursive: true, force: true });
    rmSync(sharedPath(SH));

    await editComponent(SH, 'v1', 'v2', CANVAS, records);

    expect(await stored('shared', SH)).toBe('const v = "v2";');
    expect(await stored('own', SH)).toBeNull();
  });

  test('the tier a name lives in is decided by the Record, not by whether a file survived', async () => {
    const { records } = fakeRecords();
    await writeComponent(SH, 'v1', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    rmSync(sharedPath(SH));

    expect(await isShared(SH, CANVAS, records)).toBe(true);
  });
});

describe('promote moves a Component to the shared library, atomically', () => {
  const SH = 'Tmp_RecordsShared';

  test('promote leaves no own-tier copy, and the shared library holds the source', async () => {
    const { records, stored } = fakeRecords();
    await writeComponent(SH, 'promote me', CANVAS, records);

    await promoteComponent(CANVAS, SH, records);

    expect(await stored('shared', SH)).toBe('promote me');
    expect(await stored('own', SH)).toBeNull();
    expect(existsSync(filePath(SH))).toBe(false); // MOVED, not copied
    expect(readFileSync(sharedPath(SH), 'utf8')).toBe('promote me');
  });

  // The reported incident, end to end. `promote_component` reported success while the shared
  // write never landed; because promote removes the own copy, resolution fell through to the
  // read-only PLATFORM tier, where a same-named component rendered with entirely different
  // props — three cards went blank with no error anywhere. A missing card is visible; a wrong
  // card is not. So a promote the store refuses must leave the canvas exactly as it was.
  test('a promote the store refuses does not fall through to the platform component of the same name', async () => {
    const { records, stored } = fakeRecords({ failMove: true });
    await writeComponent('MarkdownCard', '// my markdown card\n', CANVAS, records);

    await expect(promoteComponent(CANVAS, 'MarkdownCard', records)).rejects.toThrow(/refused this write/);

    expect(await stored('own', 'MarkdownCard')).toBe('// my markdown card\n');
    expect(await stored('shared', 'MarkdownCard')).toBeNull();
    // The resolution that actually renders the card: still the canvas's own component, NOT
    // the platform module that happens to share its name.
    expect(await readComponent('MarkdownCard', CANVAS, records)).toBe('// my markdown card\n');
    // …and that is a real collision, not a hypothetical one.
    expect(existsSync(fileURLToPath(new URL('../src/canvas-components/MarkdownCard.tsx', import.meta.url)))).toBe(true);
  });

  test('promote refuses a Component this canvas does not own, and a name the library holds', async () => {
    const { records } = fakeRecords();
    await expect(promoteComponent(CANVAS, 'Tmp_RecordsShared', records)).rejects.toThrow(/not in canvas/);

    await writeComponent(SH, 'mine', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    await adoptSharedComponent(CANVAS, SH, records);
    await expect(promoteComponent(CANVAS, SH, records)).rejects.toThrow(/already exists/);
  });

  test('adopt copies the shared Component into this canvas and leaves the shared one intact', async () => {
    const { records, stored } = fakeRecords();
    await writeComponent(SH, 'shared source', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    rmSync(dirPath, { recursive: true, force: true });

    await adoptSharedComponent(CANVAS, SH, records);

    expect(await stored('own', SH)).toBe('shared source');
    expect(await stored('shared', SH)).toBe('shared source');
    expect(readFileSync(filePath(SH), 'utf8')).toBe('shared source');
  });

  test('adopt refuses a Component the shared library does not hold', async () => {
    const { records } = fakeRecords();
    await expect(adoptSharedComponent(CANVAS, 'Tmp_RecordsShared', records)).rejects.toThrow(/no shared component/);
  });
});

describe('edit_component applies against the stored source', () => {
  test('an edit after a recycle patches the Record, not a stale or missing file', async () => {
    const { records, stored } = fakeRecords();
    await writeComponent('Card', 'const label = "v1";', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    await editComponent('Card', 'v1', 'v2', CANVAS, records);
    expect(await stored('own', 'Card')).toBe('const label = "v2";');
  });
});

describe('the author a container stamps on a Record', () => {
  // Attribution is only worth having if it is TRUE. `CANVAS_USER` is this deployment's single
  // Better Auth user.id (worker/index.ts: "a single static id can't represent whichever of N
  // users is calling"), and when it is unset the bridge's other call sites fall back to the
  // literal string 'default' — which, as that same doc comment says, never matches a real
  // authenticated user. Writing it into `created_by` would be a fake author: a history that
  // LOOKS attributed and is not, which is worse than one that admits it does not know.
  test('a configured CANVAS_USER is the author', () => {
    expect(recordAuthor({ CANVAS_USER: 'user_james' })).toBe('user_james');
  });

  test('no CANVAS_USER ⇒ no author, rather than a string that is not one', () => {
    expect(recordAuthor({})).toBeNull();
    expect(recordAuthor({ CANVAS_USER: '' })).toBeNull();
  });
});

describe('a Component can be asked what has happened to it', () => {
  // User story 3: "who last changed a Component and when". Nothing in this product could
  // answer that before Records — the 2026-07-29 loss had to be reconstructed from chat
  // transcripts. The history comes from the STORE, never from the filesystem, because the
  // filesystem holds exactly one revision and no author at all.
  test('the history is the store’s, newest first, with who and when', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Card', 'v2', CANVAS, records);

    const history = await componentHistory('Card', CANVAS, records);
    expect(history.map((v) => v.version)).toEqual([2, 1]);
    expect(history[0]?.createdBy).toBe('u_author');
    expect(history[0]?.createdAt).toBeInstanceOf(Date);
  });

  test('the history survives the container losing its filesystem', async () => {
    // The recycle, again: the disk holds exactly one revision and no author, so a history
    // that came from it would be destroyed by the same event Records exist to survive.
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Card', 'v2', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    expect((await componentHistory('Card', CANVAS, records)).map((v) => v.version)).toEqual([2, 1]);
  });

  test('a Component the store never held has an empty history, not an error', async () => {
    const { records } = fakeRecords();
    expect(await componentHistory('Ghost', CANVAS, records)).toEqual([]);
  });

  test('with no edge in front of the container there is no history to give — the disk keeps none', async () => {
    await writeComponent('Card', 'v1', CANVAS, null);
    expect(await componentHistory('Card', CANVAS, null)).toEqual([]);
  });
});

describe('write_data persists a data file as a Record', () => {
  const dataPath = (name: string) => `${dirPath}components/${name}`;

  test('the content lands in the store, and the file is written as the HMR trigger', async () => {
    const { records, rows } = fakeRecords();
    await writeDataFile('sales.json', '{"rows":[1]}', CANVAS, records);

    expect(rows.get(`${CANVAS}/sales.json`)).toBe('{"rows":[1]}');
    expect(readFileSync(dataPath('sales.json'), 'utf8')).toBe('{"rows":[1]}');
  });

  test('a store write failure FAILS the tool call and leaves no file behind', async () => {
    const { records } = fakeRecords({ failWrite: true });

    await expect(writeDataFile('sales.json', '[]', CANVAS, records)).rejects.toThrow(/refused this write/);
    expect(existsSync(dataPath('sales.json'))).toBe(false);
  });

  test('an invalid name is refused before anything is stored', async () => {
    const { records, calls } = fakeRecords();
    await expect(writeDataFile('evil.tsx', 'x', CANVAS, records)).rejects.toThrow(/invalid data file name/);
    expect(calls).toEqual([]);
  });

  test('a data file survives the container losing its filesystem', async () => {
    const { records } = fakeRecords();
    await writeDataFile('sales.json', '{"rows":[1]}', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    expect(await materializeDataFile('sales.json', CANVAS, records)).toBe('{"rows":[1]}');
    expect(readFileSync(dataPath('sales.json'), 'utf8')).toBe('{"rows":[1]}');
  });

  test('materializing a data file the store has never held answers null, not an error', async () => {
    const { records } = fakeRecords();
    expect(await materializeDataFile('ghost.csv', CANVAS, records)).toBeNull();
  });
});

describe('a Component materializes together with the data files it imports', () => {
  // The failure this closes: vite resolves `./sales.json` against the FILESYSTEM while it
  // transforms the module that imports it. A Component that materialized alone would fail
  // import analysis before the browser ever asked for the data file — a broken card, which
  // is precisely the failure mode this PRD exists to remove.
  test('materializing a Component brings its imported siblings with it', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'import rows from "./sales.json";\nimport notes from "./notes.md?raw";\n', CANVAS, records);
    await writeDataFile('sales.json', '{"rows":[1]}', CANVAS, records);
    await writeDataFile('notes.md', '# hi', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    await materializeComponent('Card', CANVAS, records);

    expect(readFileSync(`${dirPath}components/sales.json`, 'utf8')).toBe('{"rows":[1]}');
    expect(readFileSync(`${dirPath}components/notes.md`, 'utf8')).toBe('# hi');
  });

  test('a Component that imports nothing asks the store for nothing else', async () => {
    const { records, calls } = fakeRecords();
    await writeComponent('Card', 'export default () => null;', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });
    calls.length = 0;

    await materializeComponent('Card', CANVAS, records);
    expect(calls).toEqual([`read own ${CANVAS}/Card`]);
  });

  test('an import of a sibling the store has never held still materializes the Component', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'import rows from "./missing.json";\n', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    expect(await materializeComponent('Card', CANVAS, records)).toContain('missing.json');
  });
});

describe('a Component can be put back the way it was', () => {
  // User story 2, and the slice that would have made 2026-07-29 a five-minute fix: recovery
  // through the same door as every other Component action, rather than production credentials
  // and a database fork at a timestamp.
  test('the restored source becomes the file vite compiles, so the card renders the old version', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Card', 'the bad edit', CANVAS, records);
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('the bad edit');

    expect(await restoreComponent('Card', 1, CANVAS, records)).toBe(3);

    // Both halves matter: the store is what survives a recycle, and the FILE is what vite
    // compiles right now. A restore that only moved the row would leave the canvas rendering
    // the bad edit until the next container recycle.
    expect(await readComponent('Card', CANVAS, records)).toBe('v1');
    expect(readFileSync(filePath('Card'), 'utf8')).toBe('v1');
  });

  test('the container names a version and never carries the source — the edge does the reading', async () => {
    // The shape this verb exists for. If the container fetched v1 and wrote it back, the old
    // text would cross the hop twice and a container could "restore" a Component to anything
    // it liked. What crosses is a NUMBER; the source is resolved on the side that owns the rows.
    const { records, calls } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Card', 'v2', CANVAS, records);
    calls.length = 0;

    await restoreComponent('Card', 1, CANVAS, records);

    // One restore, then the ordinary render path. No `write` — the container never re-sent it.
    expect(calls).toEqual([`restore own ${CANVAS}/Card@1`, `read own ${CANVAS}/Card`]);
  });

  test('a restore appends to the history rather than truncating it, so it is itself undoable', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);
    await writeComponent('Card', 'v2', CANVAS, records);
    await restoreComponent('Card', 1, CANVAS, records);

    expect((await componentHistory('Card', CANVAS, records)).map((v) => v.version)).toEqual([3, 2, 1]);
    // And back again: the version the restore replaced is still there to return to.
    await restoreComponent('Card', 2, CANVAS, records);
    expect(await readComponent('Card', CANVAS, records)).toBe('v2');
  });

  test('a version that does not exist is a clean error, and changes nothing', async () => {
    const { records } = fakeRecords();
    await writeComponent('Card', 'v1', CANVAS, records);

    await expect(restoreComponent('Card', 7, CANVAS, records)).rejects.toThrow(/no version 7/);
    expect(await readComponent('Card', CANVAS, records)).toBe('v1');
  });

  test('an invalid name is refused before anything is asked of the store', async () => {
    const { records, calls } = fakeRecords();
    await expect(restoreComponent('../escape', 1, CANVAS, records)).rejects.toThrow(/invalid component name/);
    expect(calls).toEqual([]);
  });

  test('restoring a PROMOTED Component acts on the shared library, not a new own-tier fork', async () => {
    // The tier a restore acts on is the one the canvas RESOLVES — the same walk
    // `component_history` uses, so a restore always targets the Component whose history the
    // caller was just shown. Rebuilding it in the own tier instead would fork the one live
    // source, which is exactly what promote exists to prevent.
    const SH = 'Tmp_RecordsShared';
    const { records, stored } = fakeRecords();
    await writeComponent(SH, 'v1', CANVAS, records);
    await promoteComponent(CANVAS, SH, records);
    await writeComponent(SH, 'the bad shared edit', CANVAS, records);

    const rev = await restoreComponent(SH, 1, CANVAS, records);

    expect(await stored('shared', SH)).toBe('v1');
    expect(await stored('own', SH)).toBeNull();
    expect(readFileSync(sharedPath(SH), 'utf8')).toBe('v1');
    expect(rev).toBeGreaterThan(1);
  });

  test('with no edge in front of the container there is nothing to restore FROM, and it says so', async () => {
    // The disk holds exactly one revision. Silently succeeding here would be a "recovery"
    // that recovered nothing — the shape this whole ADR exists to remove.
    await writeComponent('Card', 'v1', CANVAS, null);
    await expect(restoreComponent('Card', 1, CANVAS, null)).rejects.toThrow(/no version history/);
  });
});

describe('a deleted canvas stops being rendered at all', () => {
  // User story 18. Before Records, NOTHING removed a deleted canvas's component directory:
  // the registry row went, the source stayed, and it leaked forever with no way to reclaim it.
  // The two halves of the fix meet here — the Record is soft-deleted, and there is no boot
  // restore — so a container that has lost its tree has nothing to put back.
  test('a Component whose canvas was deleted does not materialize into a fresh container', async () => {
    const { records, port } = fakeRecords();
    await writeComponent('Card', 'export default () => null;', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true }); // the recycle: the rendering is gone

    await deleteCanvasRecords(port, { workspaceId: WS, canvasId: CANVAS });

    expect(await materializeComponent('Card', CANVAS, records)).toBeNull();
    expect(existsSync(filePath('Card'))).toBe(false);
    // And the history is still there, which is what makes the deletion recoverable.
    expect((await records.history('own', CANVAS, 'Card')).map((v) => v.version)).toEqual([1]);
  });
});

describe('with no edge in front of the container, the filesystem is all there is', () => {
  // Local dev without the edge Worker, and the unit suite: an explicit state, not a fallback.
  test('write then read still round-trips through the file', async () => {
    await writeComponent('Card', 'v1', CANVAS, null);
    expect(await readComponent('Card', CANVAS, null)).toBe('v1');
  });

  test('promote is still the file move it always was', async () => {
    const SH = 'Tmp_RecordsShared';
    await writeComponent(SH, 'v1', CANVAS, null);
    await promoteComponent(CANVAS, SH, null);

    expect(existsSync(filePath(SH))).toBe(false);
    expect(readFileSync(sharedPath(SH), 'utf8')).toBe('v1');
  });
});
