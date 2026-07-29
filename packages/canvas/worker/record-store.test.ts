import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import * as schema from '../web-poc/lib/db/schema.ts';
import { d1RecordStore, memRecordStore, type RecordStore } from './record-store.ts';

// The Record port's rules, stated as behaviour a caller depends on — never as a query
// shape (ADR-0022). The SAME suite runs against BOTH implementations: an in-memory one so
// store logic is testable with no database, and the real row-backed one built from the real
// migrations. Two implementations of one port only stay honest if one suite judges both.
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

/** A fresh workspace id per test, so both implementations can share one database. */
let n = 0;
const ws = () => `ws_${++n}`;

const implementations: Array<[string, () => RecordStore]> = [
  ['memRecordStore', () => memRecordStore()],
  ['d1RecordStore', () => d1RecordStore(db as never)],
];

describe.each(implementations)('RecordStore (%s)', (_name, make) => {
  describe('write and read back', () => {
    test('a Component put into the store reads back with its source', async () => {
      const store = make();
      const w = ws();
      await store.put({ workspaceId: w, canvasId: 'cv_1', name: 'KpiCard', kind: 'component', source: 'v1', updatedBy: 'u_1' });

      const got = await store.get({ workspaceId: w, canvasId: 'cv_1', name: 'KpiCard' });
      expect(got?.source).toBe('v1');
      expect(got?.kind).toBe('component');
    });

    test('a source larger than D1 max SQL statement round-trips — values are bound, never inlined', async () => {
      // D1's maximum SQL statement is 100 KB. A store that interpolated the source into SQL
      // would fail outright here; this is the test that pins the bound-parameter decision.
      const store = make();
      const w = ws();
      const big = 'x'.repeat(300_000);
      await store.put({ workspaceId: w, canvasId: 'cv_1', name: 'Big', kind: 'data', source: big, updatedBy: null });
      expect((await store.get({ workspaceId: w, canvasId: 'cv_1', name: 'Big' }))?.source).toBe(big);
    });

    test('a Record that was never written reads back as null, not an error', async () => {
      const store = make();
      expect(await store.get({ workspaceId: ws(), canvasId: 'cv_1', name: 'Nope' })).toBeNull();
    });

    test('the same name in another canvas is another Record — tiers do not collide', async () => {
      const store = make();
      const w = ws();
      await store.put({ workspaceId: w, canvasId: 'cv_1', name: 'Card', kind: 'component', source: 'one', updatedBy: null });
      await store.put({ workspaceId: w, canvasId: 'cv_2', name: 'Card', kind: 'component', source: 'two', updatedBy: null });
      await store.put({ workspaceId: w, canvasId: null, name: 'Card', kind: 'component', source: 'shared', updatedBy: null });

      expect((await store.get({ workspaceId: w, canvasId: 'cv_1', name: 'Card' }))?.source).toBe('one');
      expect((await store.get({ workspaceId: w, canvasId: 'cv_2', name: 'Card' }))?.source).toBe('two');
      expect((await store.get({ workspaceId: w, canvasId: null, name: 'Card' }))?.source).toBe('shared');
    });

    test('a Record is scoped to its workspace — another workspace cannot read it', async () => {
      const store = make();
      const [a, b] = [ws(), ws()];
      await store.put({ workspaceId: a, canvasId: 'cv_1', name: 'Card', kind: 'component', source: 'a', updatedBy: null });
      expect(await store.get({ workspaceId: b, canvasId: 'cv_1', name: 'Card' })).toBeNull();
    });
  });

  describe('every write appends a version', () => {
    // The 2026-07-29 loss was a full replace with no history: a bad overwrite was as final
    // as a delete. History is an invariant of the store, not a courtesy of its callers.
    test('overwriting keeps the earlier source retrievable and bumps the rev', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Card' };
      const first = await store.put({ ...key, kind: 'component' as const, source: 'v1', updatedBy: 'u_1' });
      const second = await store.put({ ...key, kind: 'component' as const, source: 'v2', updatedBy: 'u_2' });

      expect(first.rev).toBe(1);
      expect(second.rev).toBe(2);
      expect((await store.get(key))?.source).toBe('v2');
      expect((await store.listVersions(key)).map((v) => v.source)).toEqual(['v2', 'v1']);
    });

    test('overwriting the SHARED tier appends a version too (the null canvas key is real)', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: null, name: 'Card' };
      await store.put({ ...key, kind: 'component' as const, source: 'v1', updatedBy: null });
      await store.put({ ...key, kind: 'component' as const, source: 'v2', updatedBy: null });

      expect((await store.get(key))?.source).toBe('v2');
      expect((await store.listVersions(key)).map((v) => v.version)).toEqual([2, 1]);
      expect(await store.list({ workspaceId: key.workspaceId, canvasId: null })).toHaveLength(1);
    });

    test('rewriting IDENTICAL source still appends a version — a write is an event, not a diff', async () => {
      // The decision, stated where it can be broken: the store does not compare content.
      // Deduplicating would make `rev` stop counting writes, and would drop exactly the fact
      // attribution exists to record — that someone touched this Component at this moment.
      // "Nothing changed" is a question a reader of the history can answer; it is not one the
      // store gets to answer by forgetting the event.
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Card' };
      await store.put({ ...key, kind: 'component' as const, source: 'same', updatedBy: 'u_1' });
      const second = await store.put({ ...key, kind: 'component' as const, source: 'same', updatedBy: 'u_2' });

      expect(second.rev).toBe(2);
      expect((await store.listVersions(key)).map((v) => [v.version, v.createdBy])).toEqual([
        [2, 'u_2'],
        [1, 'u_1'],
      ]);
    });

    test('a version records who wrote it — an unexpected change is attributable', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Card' };
      await store.put({ ...key, kind: 'component' as const, source: 'v1', updatedBy: 'u_1' });
      expect((await store.get(key))?.updatedBy).toBe('u_1');
      expect((await store.listVersions(key))[0]?.createdBy).toBe('u_1');
    });
  });

  describe('listing a tier', () => {
    test('list returns one workspace tier, by name, and never another tier', async () => {
      const store = make();
      const [a, b] = [ws(), ws()];
      await store.put({ workspaceId: a, canvasId: 'cv_1', name: 'Beta', kind: 'component', source: 'b', updatedBy: null });
      await store.put({ workspaceId: a, canvasId: 'cv_1', name: 'Alpha', kind: 'component', source: 'a', updatedBy: null });
      await store.put({ workspaceId: a, canvasId: null, name: 'Shared', kind: 'component', source: 's', updatedBy: null });
      await store.put({ workspaceId: b, canvasId: 'cv_1', name: 'Other', kind: 'component', source: 'o', updatedBy: null });

      expect((await store.list({ workspaceId: a, canvasId: 'cv_1' })).map((r) => r.name)).toEqual(['Alpha', 'Beta']);
      expect((await store.list({ workspaceId: a, canvasId: null })).map((r) => r.name)).toEqual(['Shared']);
    });
  });

  describe('moving a Record between tiers', () => {
    // What `promote` is made of. The rule the incident wrote: a Record is in exactly ONE
    // tier at every instant — never in both, and above all never in neither. A promote that
    // lost the shared write while the own copy was already gone made placed instances fall
    // through to a same-named PLATFORM component and render a plausible, wrong card.
    test('a moved Record is live at the destination and gone from the source', async () => {
      const store = make();
      const w = ws();
      const own = { workspaceId: w, canvasId: 'cv_1', name: 'Card' };
      const shared = { workspaceId: w, canvasId: null, name: 'Card' };
      await store.put({ ...own, kind: 'component' as const, source: 'v1', updatedBy: 'u_1' });

      await store.move(own, shared, 'u_2');

      expect(await store.get(own)).toBeNull();
      expect((await store.get(shared))?.source).toBe('v1');
    });

    test('the move appends a version at the destination, attributed to whoever moved it', async () => {
      const store = make();
      const w = ws();
      const own = { workspaceId: w, canvasId: 'cv_1', name: 'Card' };
      const shared = { workspaceId: w, canvasId: null, name: 'Card' };
      await store.put({ ...own, kind: 'component' as const, source: 'v1', updatedBy: 'u_1' });
      await store.put({ ...own, kind: 'component' as const, source: 'v2', updatedBy: 'u_1' });

      const moved = await store.move(own, shared, 'u_2');

      // The history travels with the Record — a Component's past is the Component's, not the
      // tier's — and the move itself is the newest entry, so "who promoted this" is on record.
      expect(moved.rev).toBe(3);
      expect((await store.listVersions(shared)).map((v) => [v.version, v.source, v.createdBy])).toEqual([
        [3, 'v2', 'u_2'],
        [2, 'v2', 'u_1'],
        [1, 'v1', 'u_1'],
      ]);
      expect(await store.listVersions(own)).toEqual([]);
    });

    test('moving onto an occupied name is refused, and changes nothing', async () => {
      const store = make();
      const w = ws();
      const own = { workspaceId: w, canvasId: 'cv_1', name: 'Card' };
      const shared = { workspaceId: w, canvasId: null, name: 'Card' };
      await store.put({ ...own, kind: 'component' as const, source: 'mine', updatedBy: null });
      await store.put({ ...shared, kind: 'component' as const, source: 'theirs', updatedBy: null });

      await expect(store.move(own, shared, null)).rejects.toThrow();
      expect((await store.get(own))?.source).toBe('mine');
      expect((await store.get(shared))?.source).toBe('theirs');
    });

    test('moving a Record that is not there is refused rather than creating one', async () => {
      const store = make();
      const w = ws();
      await expect(
        store.move({ workspaceId: w, canvasId: 'cv_1', name: 'Ghost' }, { workspaceId: w, canvasId: null, name: 'Ghost' }, null),
      ).rejects.toThrow();
      expect(await store.get({ workspaceId: w, canvasId: null, name: 'Ghost' })).toBeNull();
    });
  });

  describe('soft delete', () => {
    test('a deleted Record disappears from get and list, but its versions survive', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Card' };
      await store.put({ ...key, kind: 'component' as const, source: 'v1', updatedBy: null });
      await store.softDelete(key);

      expect(await store.get(key)).toBeNull();
      expect(await store.list({ workspaceId: key.workspaceId, canvasId: 'cv_1' })).toEqual([]);
      expect((await store.listVersions(key)).map((v) => v.source)).toEqual(['v1']);
    });

    test('writing a deleted name brings the Record back, continuing its history', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Card' };
      await store.put({ ...key, kind: 'component' as const, source: 'v1', updatedBy: null });
      await store.softDelete(key);
      const revived = await store.put({ ...key, kind: 'component' as const, source: 'v2', updatedBy: null });

      expect(revived.rev).toBe(2);
      expect((await store.get(key))?.source).toBe('v2');
      // CONTINUING, not restarting: the buried rev is what the next version counts from, so a
      // delete-then-rewrite cannot mint a second version 1 and orphan the source before it.
      expect((await store.listVersions(key)).map((v) => v.version)).toEqual([2, 1]);
    });

    test('deleting a canvas scope hides its own tier and leaves shared alone', async () => {
      const store = make();
      const w = ws();
      await store.put({ workspaceId: w, canvasId: 'cv_1', name: 'Own', kind: 'component', source: 'o', updatedBy: null });
      await store.put({ workspaceId: w, canvasId: null, name: 'Shared', kind: 'component', source: 's', updatedBy: null });
      await store.softDeleteScope({ workspaceId: w, canvasId: 'cv_1' });

      expect(await store.list({ workspaceId: w, canvasId: 'cv_1' })).toEqual([]);
      expect((await store.list({ workspaceId: w, canvasId: null })).map((r) => r.name)).toEqual(['Shared']);
    });

    test('soft-deleting a Record that was never written is a no-op, not an error', async () => {
      const store = make();
      const key = { workspaceId: ws(), canvasId: 'cv_1', name: 'Nope' };
      await store.softDelete(key);
      expect(await store.get(key)).toBeNull();
    });
  });
});
