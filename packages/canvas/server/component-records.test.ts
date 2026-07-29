import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { type ComponentRecords, editComponent, materializeComponent, readComponent, writeComponent } from './components.ts';

// Records (ADR-0022): a Component's source is a ROW, and the file vite compiles from is a
// rendering of it. These tests drive the container half — the ordering rule (store first,
// then disk), and materialization on a miss — against a fake store, so none of it needs D1.
//
// Built from the failure: on 2026-07-29 a write succeeded to disk, reported success, and was
// gone after the next boot. "The store accepted it" is now the thing being asserted.

const CANVAS = 'cvrecordstest';
const dirPath = fileURLToPath(new URL(`../src/canvas-${CANVAS}/`, import.meta.url));
const filePath = (name: string) => `${dirPath}components/${name}.tsx`;

afterEach(() => {
  if (existsSync(dirPath)) rmSync(dirPath, { recursive: true, force: true });
});

/** A store that remembers what it was told, and can be made to fail. */
function fakeRecords(opts: { failWrite?: boolean; failRead?: boolean } = {}) {
  const rows = new Map<string, string>();
  const calls: string[] = [];
  const records: ComponentRecords = {
    write: async (canvasId, name, source) => {
      calls.push(`write ${canvasId}/${name}`);
      if (opts.failWrite) throw new Error('the workspace store refused this write');
      rows.set(`${canvasId}/${name}`, source);
    },
    read: async (canvasId, name) => {
      calls.push(`read ${canvasId}/${name}`);
      if (opts.failRead) throw new Error('the workspace store is unreachable');
      return rows.get(`${canvasId}/${name}`) ?? null;
    },
  };
  return { records, rows, calls };
}

describe('write_component persists a Record before it touches disk', () => {
  test('the source lands in the store, and the file is written as the HMR trigger', async () => {
    const { records, rows } = fakeRecords();
    await writeComponent('Card', 'export default () => null;', CANVAS, records);

    expect(rows.get(`${CANVAS}/Card`)).toBe('export default () => null;');
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
    expect(calls).toEqual([`read ${CANVAS}/Card`]);
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

describe('edit_component applies against the stored source', () => {
  test('an edit after a recycle patches the Record, not a stale or missing file', async () => {
    const { records, rows } = fakeRecords();
    await writeComponent('Card', 'const label = "v1";', CANVAS, records);
    rmSync(dirPath, { recursive: true, force: true });

    await editComponent('Card', 'v1', 'v2', CANVAS, records);
    expect(rows.get(`${CANVAS}/Card`)).toBe('const label = "v2";');
  });
});

describe('with no edge in front of the container, the filesystem is all there is', () => {
  // Local dev without the edge Worker, and the unit suite: an explicit state, not a fallback.
  test('write then read still round-trips through the file', async () => {
    await writeComponent('Card', 'v1', CANVAS, null);
    expect(await readComponent('Card', CANVAS, null)).toBe('v1');
  });
});
