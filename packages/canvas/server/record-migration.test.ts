import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import { platformRpcToken } from '../shared/platform-rpc.ts';
import * as schema from '../web-poc/lib/db/schema.ts';
import { handlePlatformRpc } from '../worker/platform-rpc.ts';
import { platformRpc } from './platform-rpc-client.ts';
import {
  HUDSON_STANDUP_CANVAS,
  MIGRATION_PLAN,
  MIGRATION_WORKSPACE,
  NOT_MIGRATED,
  PERMANENTLY_LOST,
  SHARED_ARCHIVE_KEY,
  type MigrationSources,
  migrateRecords,
  resolveSources,
  verifyMigration,
} from './record-migration.ts';

// The 2026-07-29 backfill (#365, ADR-0022), stated as behaviour: an ALLOWLIST of four
// artefacts moves into Records, everything else in the archives stays out, and "did it all
// move?" is a check rather than a hope (PRD #354 story 36).
//
// Every test drives the REAL path — the container's platform-RPC client, the real edge
// handler, and the real row store over a real (in-memory) D1 built from the real migrations.
// A migration proven against a fake store proves nothing about the store it is migrating to,
// and this one has exactly one chance to be right.

// --- the database, and the edge in front of it -----------------------------------------

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
const SECRET = 'test-platform-rpc-secret';

/** The container's own client, wired to the real handler in this process. No HTTP, same code. */
const rpc = platformRpc({
  origin: 'http://edge.invalid',
  secret: SECRET,
  fetchImpl: (url, init) =>
    handlePlatformRpc(new Request(url, init), { BETTER_AUTH_SECRET: SECRET }, { db: db as never, send: null, origin: '' }),
})!;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  // The canvas the own-tier Components belong to. The edge checks containment before any
  // Record write, so without this row the migration is a 403 — which is the point: a
  // migration cannot mint rows for a canvas the registry does not place in the workspace.
  await db.insert(schema.canvases).values({
    id: HUDSON_STANDUP_CANVAS,
    workspaceId: MIGRATION_WORKSPACE,
    name: 'Hudson Standup',
  });
});

beforeEach(async () => {
  await client.execute('DELETE FROM component_records');
  await client.execute('DELETE FROM component_record_versions');
});

// --- the sources ------------------------------------------------------------------------

/** Build a POSIX tar in memory, as `persist-guards.test.ts` does — the real header layout,
 *  so the extractor is exercised rather than stubbed. */
function tar(entries: Array<{ name: string; body?: string; type?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const e of entries) {
    const body = new TextEncoder().encode(e.body ?? '');
    const h = new Uint8Array(512);
    h.set(new TextEncoder().encode(e.name).slice(0, 100), 0);
    h.set(new TextEncoder().encode(`${body.length.toString(8).padStart(11, '0')}\0`), 124);
    h.set(new TextEncoder().encode(e.type ?? '0'), 156);
    blocks.push(h);
    if (body.length) {
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

const planned = (name: string) => MIGRATION_PLAN.find((p) => p.name === name)!;

/** The bytes the plan pins, so a synthetic source can satisfy its own hash. */
const filler = (name: string): string => {
  const item = planned(name);
  // Pad a recognisable prefix out to the pinned length; the hash is then whatever this is.
  const head = `// ${name}\n`;
  return head + 'x'.repeat(item.bytes - head.length);
};

/** Sources that answer with whatever the plan pins, so tests never depend on production. */
function fakeSources(over: Partial<Record<string, string>> = {}): MigrationSources {
  const text = (name: string) => over[name] ?? filler(name);
  return {
    archive: async (key) =>
      key === SHARED_ARCHIVE_KEY
        ? tar([
            { name: './', type: '5' },
            { name: './.gitkeep' },
            { name: './Tmp_GuestShared.tsx', body: 'export default () => null;\n' },
            { name: './Outliner.tsx', body: text('Outliner') },
          ])
        : null,
    recovered: async (file) => {
      const name = file.replace(/\.tsx$/, '');
      return MIGRATION_PLAN.some((p) => p.name === name) ? text(name) : null;
    },
  };
}

/** The plan with its hashes re-pinned to the synthetic bytes — everything except the two
 *  tests that are ABOUT the pinned hashes. */
const synthetic = () =>
  MIGRATION_PLAN.map((p) => ({ ...p, sha256: createHash('sha256').update(filler(p.name), 'utf8').digest('hex') }));

// --- tests --------------------------------------------------------------------------------

describe('the allowlist', () => {
  test('names the four surviving artefacts and nothing else', () => {
    expect(MIGRATION_PLAN.map((p) => p.name).sort()).toEqual([
      'AudioMeeting',
      'ChatRoom',
      'ComponentCatalog',
      'Outliner',
    ]);
  });

  test('Outliner is shared-tier; the three recovered Components are own-tier on Hudson Standup', () => {
    expect(planned('Outliner').tier).toBe('shared');
    for (const name of ['AudioMeeting', 'ChatRoom', 'ComponentCatalog']) {
      expect(planned(name).tier).toBe('own');
      expect(planned(name).canvasId).toBe(HUDSON_STANDUP_CANVAS);
    }
  });

  test('the verified residue is named as NOT migrated, so a sweep cannot creep back in', () => {
    // The archives are mostly e2e leftovers. A migration that walked the directory would
    // report success while seeding the new store with junk.
    expect(NOT_MIGRATED.map((r) => r.what)).toContain('Tmp_GuestShared.tsx');
    expect(NOT_MIGRATED.map((r) => r.what)).toContain('zz_test_data_cd0fc124.json');
    for (const residue of NOT_MIGRATED) {
      expect(MIGRATION_PLAN.some((p) => residue.what.startsWith(p.name))).toBe(false);
    }
  });
});

describe('resolving sources', () => {
  test('Outliner is extracted from the shared-components archive', async () => {
    const [outliner] = await resolveSources(synthetic().slice(0, 1), fakeSources());
    expect(outliner?.source).toBe(filler('Outliner'));
  });

  test('the three recovered Components come from the incident directory', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    expect(resolved.map((r) => r.item.name).sort()).toEqual(['AudioMeeting', 'ChatRoom', 'ComponentCatalog', 'Outliner']);
  });

  test('an absent archive is an error naming the key, never an empty migration', async () => {
    const sources: MigrationSources = { archive: async () => null, recovered: fakeSources().recovered };
    await expect(resolveSources(synthetic(), sources)).rejects.toThrow(/shared-components\.tar/);
  });

  test('an entry missing from the archive is an error naming the path', async () => {
    const sources: MigrationSources = {
      archive: async () => tar([{ name: './.gitkeep' }]),
      recovered: fakeSources().recovered,
    };
    await expect(resolveSources(synthetic().slice(0, 1), sources)).rejects.toThrow(/Outliner\.tsx/);
  });

  test('source bytes that do not match the pinned hash abort the run', async () => {
    // The pin is the migration's only defence against migrating something other than what was
    // inventoried — the archive is mutable and nothing else here would notice a change.
    const tampered = fakeSources({ Outliner: filler('Outliner').replace('//', '/*') });
    await expect(resolveSources(synthetic().slice(0, 1), tampered)).rejects.toThrow(/sha256/);
  });

  test('the real plan matches the real committed sources — the pins are current', async () => {
    // No fakes: the three recovered files as committed, hashed against what the plan claims.
    const recovered = MIGRATION_PLAN.filter((p) => p.origin.kind === 'recovered');
    const resolved = await resolveSources(recovered, {
      archive: async () => null,
      recovered: async (file) =>
        readFileSync(fileURLToPath(new URL(`../../../docs/incidents/2026-07-29-empty-archive-overwrite/recovered/${file}`, import.meta.url)), 'utf8'),
    });
    expect(resolved).toHaveLength(3);
  });
});

describe('the dry run', () => {
  test('reports every planned Record as a create and writes NOTHING', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    const report = await migrateRecords(rpc, resolved, { write: false });

    expect(report.outcomes.map((o) => o.action)).toEqual(['create', 'create', 'create', 'create']);
    expect(report.wrote).toBe(false);
    expect(report.ok).toBe(true);
    // and the store is untouched
    expect(await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: 'default', tier: 'shared', name: 'Outliner' })).toBeNull();
  });
});

describe('writing', () => {
  test('each Record lands byte-for-byte at rev 1, in its own tier', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    const report = await migrateRecords(rpc, resolved, { write: true });

    expect(report.ok).toBe(true);
    expect(report.outcomes.every((o) => o.rev === 1)).toBe(true);
    const shared = await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: 'default', tier: 'shared', name: 'Outliner' });
    expect(shared).toBe(filler('Outliner'));
    const own = await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: HUDSON_STANDUP_CANVAS, tier: 'own', name: 'ChatRoom' });
    expect(own).toBe(filler('ChatRoom'));
  });

  test('a migrated Record carries an initial version, attributed to nobody', async () => {
    // `updated_by` is documented as a Better Auth user id (#371). A migration is not a
    // person, and a placeholder that matches no user is the failure that issue names — so
    // the honest value is null, and the timestamp on v1 is the provenance.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    const versions = await rpc.componentHistory({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: HUDSON_STANDUP_CANVAS,
      tier: 'own',
      name: 'AudioMeeting',
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);
    expect(versions[0]?.createdBy).toBeNull();
  });
});

describe('idempotence', () => {
  test('a second run finds every Record identical and writes nothing', async () => {
    // `put` bumps rev and appends a version, so a blind re-run would leave a spurious v2 in
    // the history of every Component — noise in the one record that says what changed.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    const second = await migrateRecords(rpc, resolved, { write: true });
    expect(second.outcomes.map((o) => o.action)).toEqual(['identical', 'identical', 'identical', 'identical']);
    expect(second.wrote).toBe(false);
    expect(second.ok).toBe(true);
    const versions = await rpc.componentHistory({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: HUDSON_STANDUP_CANVAS,
      tier: 'own',
      name: 'AudioMeeting',
    });
    expect(versions).toHaveLength(1);
  });

  test('a Record edited since the migration is reported as diverged and NOT overwritten', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });
    await rpc.componentWrite({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: HUDSON_STANDUP_CANVAS,
      tier: 'own',
      userId: null,
      name: 'ChatRoom',
      source: '// somebody improved this\n',
    });

    const again = await migrateRecords(rpc, resolved, { write: true });
    expect(again.outcomes.find((o) => o.item.name === 'ChatRoom')?.action).toBe('differs');
    expect(again.ok).toBe(false);
    expect(await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: HUDSON_STANDUP_CANVAS, tier: 'own', name: 'ChatRoom' })).toBe(
      '// somebody improved this\n',
    );
  });
});

describe('verification', () => {
  test('after a migration every Record is present, in the right tier, at the right length', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    const report = await verifyMigration(rpc, resolved);
    expect(report.ok).toBe(true);
    expect(report.findings.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(report.findings.find((f) => f.name === 'Outliner')?.tier).toBe('shared');
  });

  test('a Record that never landed is reported missing — verification is not a formality', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved.slice(0, 3), { write: true });

    const report = await verifyMigration(rpc, resolved);
    expect(report.ok).toBe(false);
    expect(report.findings.filter((f) => f.status === 'missing')).toHaveLength(1);
  });

  test('a Record whose content drifted is a mismatch, not a pass — presence is not enough', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });
    await rpc.componentWrite({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: 'default',
      tier: 'shared',
      userId: null,
      name: 'Outliner',
      source: `${filler('Outliner')} `,
    });

    const report = await verifyMigration(rpc, resolved);
    expect(report.ok).toBe(false);
    expect(report.findings.find((f) => f.name === 'Outliner')?.status).toBe('mismatch');
  });

  test('a Record the migration never planned is reported, so junk cannot arrive unnoticed', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });
    await rpc.componentWrite({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: 'default',
      tier: 'shared',
      userId: null,
      name: 'Tmp_GuestShared',
      source: 'export default () => null;\n',
    });

    const report = await verifyMigration(rpc, resolved);
    expect(report.ok).toBe(false);
    expect(report.unexpected).toEqual([{ name: 'Tmp_GuestShared', tier: 'shared' }]);
  });

  test('the two unrecoverable Components are named in every report, never silently absent', async () => {
    // "Three of five" has to be stated. A clean ✅ over a canvas that still shows two dead
    // cards is the report reading better than the world.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    expect((await verifyMigration(rpc, resolved)).lost).toEqual(PERMANENTLY_LOST);
    expect(PERMANENTLY_LOST).toEqual(['HenryAccessExplorer', 'HenryScenarioMap']);
  });

  test('the platform tier is not mistaken for migrated content', async () => {
    // `component.list` spans all three tiers; base Components ship with the image and are
    // nobody's migration.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    expect((await verifyMigration(rpc, resolved)).unexpected).toEqual([]);
  });
});
