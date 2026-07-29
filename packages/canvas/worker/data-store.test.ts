import { describe, expect, test } from 'bun:test';

import { D1_MAX_VALUE_BYTES, DATA_MAX_BYTES } from '../shared/bridge-wire.ts';
import { dataStore } from './data-store.ts';
import { memRecordStore } from './record-store.ts';

// Data-file policy over the Record port (ADR-0022): what `write_data` MEANS, independent of
// where the rows live. Driven against the in-memory port, so none of this needs a database.

describe('DataStore — a data file round-trips', () => {
  test('a written data file reads back with its source', async () => {
    const store = dataStore(memRecordStore());
    await store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'sales.json', source: '{"rows":[1]}', userId: 'u_1' });

    expect(await store.read({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'sales.json' })).toBe('{"rows":[1]}');
  });

  test('a data file this canvas never wrote reads back as null', async () => {
    const store = dataStore(memRecordStore());
    expect(await store.read({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'absent.csv' })).toBeNull();
  });

  test('it is stored as a data Record — the same table as a Component, a different kind', async () => {
    const records = memRecordStore();
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'notes.md' };
    await dataStore(records).write({ ...key, source: '# hi', userId: null });

    expect((await records.get(key))?.kind).toBe('data');
  });

  test('rewriting a data file appends a version, exactly as a Component does', async () => {
    const records = memRecordStore();
    const store = dataStore(records);
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'sales.csv' };
    await store.write({ ...key, source: 'a,b', userId: 'u_1' });
    const second = await store.write({ ...key, source: 'c,d', userId: 'u_2' });

    expect(second.rev).toBe(2);
    expect((await records.listVersions(key)).map((v) => [v.source, v.createdBy])).toEqual([
      ['c,d', 'u_2'],
      ['a,b', 'u_1'],
    ]);
  });
});

describe('DataStore — the data door cannot be used to author code', () => {
  // The closed extension set is the whole reason `write_data` is a separate tool: a data door
  // that accepted `.tsx` would just be the ungated authoring bypass the QABoard incident was
  // about, only now with a row behind it.
  test.each([['evil.tsx'], ['evil.ts'], ['evil.js'], ['evil.mjs'], ['evil.html'], ['noext'], ['../escape.json'], ['a/b.json'], ['.json'], ['']])(
    'rejects the name %p',
    async (name) => {
      const store = dataStore(memRecordStore());
      await expect(store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name, source: 'x', userId: null })).rejects.toThrow(
        /invalid data file name/,
      );
    },
  );

  test('a rejected write stores nothing', async () => {
    const records = memRecordStore();
    await expect(
      dataStore(records).write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'evil.tsx', source: 'x', userId: null }),
    ).rejects.toThrow();
    expect(await records.get({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'evil.tsx' })).toBeNull();
  });

  test('rejects unparseable JSON — a broken .json import breaks every component importing it', async () => {
    const store = dataStore(memRecordStore());
    await expect(
      store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'sales.json', source: '{nope', userId: null }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test('rejects an empty source rather than storing a blank data file', async () => {
    const store = dataStore(memRecordStore());
    await expect(store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'notes.md', source: '', userId: null })).rejects.toThrow(
      /non-empty/,
    );
  });
});

describe('DataStore — the size cap comes from what the store can actually hold', () => {
  // User story 40. The old 1 MiB cap was justified by a sink that re-tarred the whole
  // directory on every flush; that sink is gone, so the number is re-derived from D1's own
  // ceiling — 2,000,000 bytes for a single value or row (ADR-0022 decision 3) — with room
  // left for the key columns and for the identical copy every write appends to history.
  test('the cap sits under D1\'s real ceiling, with headroom', () => {
    expect(DATA_MAX_BYTES).toBeLessThan(D1_MAX_VALUE_BYTES);
    expect(DATA_MAX_BYTES).toBe(D1_MAX_VALUE_BYTES / 2);
  });

  test('a data file right at the cap is accepted', async () => {
    const store = dataStore(memRecordStore());
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'big.txt' };
    await store.write({ ...key, source: 'x'.repeat(DATA_MAX_BYTES), userId: null });

    expect((await store.read(key))?.length).toBe(DATA_MAX_BYTES);
  });

  test('one byte over the cap is a clean error, and nothing is stored', async () => {
    const records = memRecordStore();
    const key = { workspaceId: 'ws_a', canvasId: 'cv_1', name: 'big.txt' };
    await expect(dataStore(records).write({ ...key, source: 'x'.repeat(DATA_MAX_BYTES + 1), userId: null })).rejects.toThrow(/too large/);
    expect(await records.get(key)).toBeNull();
  });

  test('the cap is measured in UTF-8 BYTES — the unit the store is limited in', async () => {
    // Half as many characters, two bytes each: a cap counted in `length` would let this
    // through and hand the store a value a byte-limited row may refuse.
    const store = dataStore(memRecordStore());
    await expect(
      store.write({ workspaceId: 'ws_a', canvasId: 'cv_1', name: 'big.txt', source: 'é'.repeat(DATA_MAX_BYTES / 2 + 1), userId: null }),
    ).rejects.toThrow(/too large/);
  });
});
