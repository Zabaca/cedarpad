import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import { platformRpcToken } from '../shared/platform-rpc.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import * as schema from '../web-poc/lib/db/schema.ts';
import { handlePlatformRpc } from '../worker/platform-rpc.ts';
import { platformRpc } from './platform-rpc-client.ts';
import {
  CANVAS_ARCHIVE_KEY,
  CUSTOM_ARCHIVE_KEY,
  MIGRATION_PLAN,
  MIGRATION_WORKSPACE,
  STANDUP_CANVAS,
  NOT_MIGRATED,
  PERMANENTLY_LOST,
  SHARED_ARCHIVE_KEY,
  SKILLS_ARCHIVE_KEY,
  SOURCE_ARCHIVES,
  type MigrationSources,
  migrateRecords,
  prepareMigration,
  resolveSources,
  surveyArchives,
  tarEntries,
  verifyMigration,
} from './record-migration.ts';

// The 2026-07-29 backfill (#365, ADR-0022), stated as behaviour: an ALLOWLIST of five
// artefacts moves into Records, everything else in the archives stays out, the archives are
// ENUMERATED so nothing can be left behind unnoticed, and "did it all move?" is a check
// rather than a hope (PRD #354 story 36).
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

/** "Cedarpad" — the canvas #365 originally aimed at, which holds none of the dead cards. */
const OTHER_CANVAS = 'cv_4bfb07e3-cd4e-4fc8-a3ed-54a4b20d483b';

/** The container's own client, wired to the real handler in this process. No HTTP, same code. */
const rpc = platformRpc({
  origin: 'http://edge.invalid',
  // The container's credential is its workspace's key (#374), not the shared secret.
  secret: await workspaceKey(SECRET, MIGRATION_WORKSPACE),
  fetchImpl: (url, init) =>
    handlePlatformRpc(new Request(url, init), { BETTER_AUTH_SECRET: SECRET }, { db: db as never }),
})!;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  // The canvases the own-tier Components belong to. The edge checks containment before any
  // Record write, so without these rows the migration is a 403 — which is the point: a
  // migration cannot mint rows for a canvas the registry does not place in the workspace.
  // Named as production names them, which is not how #365's prose names them.
  await db.insert(schema.canvases).values([
    { id: STANDUP_CANVAS, workspaceId: MIGRATION_WORKSPACE, name: 'Standup' },
    // The canvas the plan used to be aimed at, seeded so a test could write to it — it is a
    // real canvas in the same workspace, just not the one holding the cards.
    { id: OTHER_CANVAS, workspaceId: MIGRATION_WORKSPACE, name: 'Cedarpad' },
  ]);
});

beforeEach(async () => {
  await client.execute('DELETE FROM component_records');
  await client.execute('DELETE FROM component_record_versions');
});

// --- the sources ------------------------------------------------------------------------

/** Build a POSIX tar in memory — the real header layout, so the extractor is exercised
 *  rather than stubbed. */
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

/** One extra file to plant in an archive — how a test says "production changed under us". */
type Extra = { key: string; name: string; body: string };

/**
 * All four source archives, laid out as production's are: the planned files, the residue, the
 * directory entries and the `.gitkeep`. Tests never touch production, but the SHAPE has to
 * match or the survey is being proven against a world that does not exist.
 */
function fakeSources(opts: { over?: Partial<Record<string, string>>; extra?: Extra[] } = {}): MigrationSources {
  const text = (name: string) => opts.over?.[name] ?? filler(name);
  const extrasFor = (key: string) => (opts.extra ?? []).filter((e) => e.key === key).map((e) => ({ name: e.name, body: e.body }));
  const archives: Record<string, Array<{ name: string; body?: string; type?: string }>> = {
    [SHARED_ARCHIVE_KEY]: [
      { name: './', type: '5' },
      { name: './.gitkeep' },
      { name: './Tmp_GuestShared.tsx', body: 'export default () => null;\n' },
      { name: './Outliner.tsx', body: text('Outliner') },
    ],
    [CANVAS_ARCHIVE_KEY]: [
      // An empty components dir for the other canvas — the shape that misled #365 into
      // aiming at it. It must stay in the fixture: the survey has to ignore it as not-content.
      { name: `canvas-${OTHER_CANVAS}/`, type: '5' },
      { name: `canvas-${OTHER_CANVAS}/components/`, type: '5' },
      { name: `canvas-${STANDUP_CANVAS}/`, type: '5' },
      { name: `canvas-${STANDUP_CANVAS}/components/`, type: '5' },
      { name: `canvas-${STANDUP_CANVAS}/components/WorkflowGraph.tsx`, body: text('WorkflowGraph') },
      { name: 'canvas-default/', type: '5' },
      { name: 'canvas-default/components/', type: '5' },
      { name: 'canvas-default/components/zz_test_data_cd0fc124.json', body: '{"zz":true}\n' },
    ],
    [SKILLS_ARCHIVE_KEY]: [
      { name: './', type: '5' },
      { name: './zz-test-skill-b7acb8fa/', type: '5' },
      { name: './zz-test-skill-b7acb8fa/SKILL.md', body: '# zz test skill\n' },
      { name: './zz-test-skill-b7acb8fa/data/', type: '5' },
      { name: './zz-test-skill-b7acb8fa/data/corpus.yaml', body: 'a: 1\n' },
    ],
    [CUSTOM_ARCHIVE_KEY]: [
      { name: './', type: '5' },
      { name: './hello.ts', body: 'export default 1;\n' },
    ],
  };
  return {
    archive: async (key) => {
      const entries = archives[key];
      return entries ? tar([...entries, ...extrasFor(key)]) : null;
    },
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

// The tar header parser the survey walks archives with. It moved here from `persist-guards.ts`
// when #366 retired the empty-archive guard; these are the guard's parser tests, kept because
// the survey is now the thing that depends on them. Tolerance is the point: this reads
// production objects nobody can re-create, so a malformed or truncated one must yield what it
// read rather than abort the enumeration.
describe('tarEntries', () => {
  test('reads names, sizes and typeflags; stops at the end block', () => {
    const bytes = tar([
      { name: 'canvas-default/components/', type: '5' },
      { name: 'canvas-default/components/KpiCard.tsx', body: 'export default 1' },
    ]);
    expect(tarEntries(bytes)).toEqual([
      { name: 'canvas-default/components/', size: 0, type: '5' },
      { name: 'canvas-default/components/KpiCard.tsx', size: 16, type: '0' },
    ]);
  });

  test('a truncated archive yields what it read, never throws', () => {
    const full = tar([{ name: 'a/X.tsx', body: 'x'.repeat(600) }]);
    expect(() => tarEntries(full.slice(0, 700))).not.toThrow();
    expect(tarEntries(full.slice(0, 700))[0]?.name).toBe('a/X.tsx');
  });

  test('garbage bytes do not throw', () => {
    expect(() => tarEntries(new Uint8Array(2048).fill(0xff))).not.toThrow();
  });
});

describe('the allowlist', () => {
  test('names the five surviving artefacts and nothing else', () => {
    expect(MIGRATION_PLAN.map((p) => p.name).sort()).toEqual([
      'AudioMeeting',
      'ChatRoom',
      'ComponentCatalog',
      'Outliner',
      'WorkflowGraph',
    ]);
  });

  test('Outliner is shared-tier; the other four are own-tier on the canvas that holds the dead cards', () => {
    expect(planned('Outliner').tier).toBe('shared');
    for (const name of ['AudioMeeting', 'ChatRoom', 'ComponentCatalog', 'WorkflowGraph']) {
      expect(planned(name).tier).toBe('own');
      expect(planned(name).canvasId).toBe(STANDUP_CANVAS);
    }
  });

  test('the own tier is cv_edd9bab6, NOT the canvas #365 named — the cards decide, not the title', () => {
    // A placed card resolves against its own canvas's tier, so the shapes say where the
    // source has to live. The live rooms hold AudioMeeting, ChatRoom, ComponentCatalog and
    // both lost cards on cv_edd9bab6 and none of them on cv_4bfb07e3. Aimed at the latter, this
    // migration would have written Records nobody can see and reported success.
    expect(STANDUP_CANVAS).toBe('cv_edd9bab6-8bae-4a7a-a694-9abfa9965db9');
    expect(MIGRATION_PLAN.every((p) => p.canvasId !== OTHER_CANVAS)).toBe(true);
  });

  test('every own-tier entry justifies its canvas with placement evidence', () => {
    // A canvas id with no justification beside it is how the wrong one got written down.
    for (const item of MIGRATION_PLAN.filter((p) => p.tier === 'own')) {
      expect(item.why).toMatch(/placed instance/);
    }
  });

  test('the verified residue is named as NOT migrated, per archive, so a sweep cannot creep back in', () => {
    // The archives are mostly e2e leftovers. A migration that walked the directory would
    // report success while seeding the new store with junk. Keyed by archive AND path: a bare
    // filename would let a same-named file in another archive pass as already-decided.
    expect(NOT_MIGRATED.map((r) => r.path)).toContain('Tmp_GuestShared.tsx');
    expect(NOT_MIGRATED.map((r) => r.path)).toContain('canvas-default/components/zz_test_data_cd0fc124.json');
    for (const residue of NOT_MIGRATED) {
      expect(SOURCE_ARCHIVES).toContain(residue.key);
      expect(MIGRATION_PLAN.some((p) => p.origin.kind === 'archive' && p.origin.key === residue.key && p.origin.path === residue.path)).toBe(false);
    }
  });

  test('sessions.tar is not a source archive — Transcripts are Files, not Records', () => {
    // Surveying it would be a claim this migration has no business making (#356).
    expect(SOURCE_ARCHIVES.some((k) => k.endsWith('sessions.tar'))).toBe(false);
    expect(SOURCE_ARCHIVES).toHaveLength(4);
  });
});

describe('surveying the archives', () => {
  test('every content-bearing entry is classified, and nothing is unrecognised', async () => {
    const survey = await surveyArchives(fakeSources(), synthetic());

    expect(survey.unrecognised).toEqual([]);
    expect(survey.planned.map((p) => p.path).sort()).toEqual([
      'Outliner.tsx',
      `canvas-${STANDUP_CANVAS}/components/WorkflowGraph.tsx`,
    ]);
    // The residue is the whole test skill (both files), the guest stub, the test data file
    // and the image's hello.ts.
    expect(survey.residue).toHaveLength(5);
  });

  test('directory entries and .gitkeep are not content — an empty dir is not something left behind', async () => {
    const survey = await surveyArchives(fakeSources(), synthetic());
    const paths = [...survey.planned, ...survey.residue, ...survey.unrecognised].map((e) => e.path);

    expect(paths).not.toContain('.gitkeep');
    expect(paths.some((p) => p.endsWith('/'))).toBe(false);
  });

  test('a file in neither list is UNRECOGNISED, with its archive and byte count', async () => {
    // This is `WorkflowGraph.tsx` on 2026-07-29: real work, authored into production hours
    // after the plan was written, in neither list. The first version of this migration would
    // have reported success and left it behind.
    const sources = fakeSources({
      extra: [{ key: CANVAS_ARCHIVE_KEY, name: 'canvas-cv_new/components/SomethingNew.tsx', body: 'export default 1;\n' }],
    });

    const survey = await surveyArchives(sources, synthetic());
    expect(survey.unrecognised).toEqual([
      { key: CANVAS_ARCHIVE_KEY, path: 'canvas-cv_new/components/SomethingNew.tsx', bytes: 18 },
    ]);
  });

  test('an archive that cannot be read is an error — a survey with holes reads like a clean one', async () => {
    const blind: MigrationSources = {
      archive: async (key) => (key === CUSTOM_ARCHIVE_KEY ? null : fakeSources().archive(key)),
      recovered: fakeSources().recovered,
    };
    await expect(surveyArchives(blind, synthetic())).rejects.toThrow(/custom\.tar/);
  });
});

describe('refusing to run on a surprise', () => {
  test('an unrecognised entry fails the run BEFORE anything is written', async () => {
    const sources = fakeSources({
      extra: [{ key: SHARED_ARCHIVE_KEY, name: './Surprise.tsx', body: 'export default 2;\n' }],
    });

    await expect(prepareMigration(sources, synthetic())).rejects.toThrow(/Surprise\.tsx/);
    // and the store is untouched — the refusal happens before a single write
    expect(await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: 'default', tier: 'shared', name: 'Outliner' })).toBeNull();
  });

  test('the error names every unrecognised path and its byte count, not just a count', async () => {
    // A failure that does not say what it found makes the operator guess, and the right
    // answer differs per file: migrate it, record why it stays, or go and ask whose it is.
    const sources = fakeSources({
      extra: [
        { key: SHARED_ARCHIVE_KEY, name: './One.tsx', body: 'a' },
        { key: CUSTOM_ARCHIVE_KEY, name: './two.ts', body: 'bb' },
      ],
    });

    const err = await prepareMigration(sources, synthetic()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('One.tsx  1 b');
    expect((err as Error).message).toContain('two.ts  2 b');
  });

  test('a skill-shaped surprise is called out as a skill, not as a stray file', async () => {
    const sources = fakeSources({
      extra: [{ key: SKILLS_ARCHIVE_KEY, name: './ticket-forge/SKILL.md', body: '# ticket forge\n' }],
    });

    const err = await prepareMigration(sources, synthetic()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/SKILL-SHAPED/);
    expect((err as Error).message).toContain('ticket-forge/SKILL.md');
  });

  test('a clean survey lets the run proceed and hands back what it resolved', async () => {
    const { survey, resolved } = await prepareMigration(fakeSources(), synthetic());

    expect(survey.unrecognised).toEqual([]);
    expect(resolved).toHaveLength(5);
  });
});

describe('resolving sources', () => {
  test('Outliner is extracted from the shared-components archive', async () => {
    const [outliner] = await resolveSources(synthetic().slice(0, 1), fakeSources());
    expect(outliner?.source).toBe(filler('Outliner'));
  });

  test('the three recovered Components come from the incident directory, the other two from archives', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    expect(resolved.map((r) => r.item.name).sort()).toEqual([
      'AudioMeeting',
      'ChatRoom',
      'ComponentCatalog',
      'Outliner',
      'WorkflowGraph',
    ]);
  });

  test('WorkflowGraph is extracted from the per-canvas archive, at its full path', async () => {
    // Its tar entry has no `./` prefix (tarCanvasDirs writes src-relative paths) where
    // Outliner's does — one normalization, so a plan path is comparable by equality.
    const [workflow] = await resolveSources(synthetic().filter((p) => p.name === 'WorkflowGraph'), fakeSources());
    expect(workflow?.source).toBe(filler('WorkflowGraph'));
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
    const tampered = fakeSources({ over: { Outliner: filler('Outliner').replace('//', '/*') } });
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

    expect(report.outcomes.map((o) => o.action)).toEqual(['create', 'create', 'create', 'create', 'create']);
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
    const own = await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: STANDUP_CANVAS, tier: 'own', name: 'ChatRoom' });
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
      canvasId: STANDUP_CANVAS,
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
    expect(second.outcomes.map((o) => o.action)).toEqual(['identical', 'identical', 'identical', 'identical', 'identical']);
    expect(second.wrote).toBe(false);
    expect(second.ok).toBe(true);
    const versions = await rpc.componentHistory({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: STANDUP_CANVAS,
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
      canvasId: STANDUP_CANVAS,
      tier: 'own',
      userId: null,
      name: 'ChatRoom',
      source: '// somebody improved this\n',
    });

    const again = await migrateRecords(rpc, resolved, { write: true });
    expect(again.outcomes.find((o) => o.item.name === 'ChatRoom')?.action).toBe('differs');
    expect(again.ok).toBe(false);
    expect(await rpc.componentRead({ workspaceId: MIGRATION_WORKSPACE, canvasId: STANDUP_CANVAS, tier: 'own', name: 'ChatRoom' })).toBe(
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
    expect(report.findings.map((f) => f.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(report.findings.find((f) => f.name === 'Outliner')?.tier).toBe('shared');
  });

  test('a Record that never landed is reported missing — verification is not a formality', async () => {
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved.slice(0, 4), { write: true });

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

  test('an unplanned Record on the OTHER own tier the plan touches is reported too', async () => {
    // The plan names two canvases: Standup for the own tier, and the legacy `default`
    // canvas as the shared write's entitlement proof. `component.list` answers for a canvas's
    // own library plus the workspace's shared one, so `default`'s own tier is invisible from
    // Standup, and a check scoped to one canvas would not see this.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });
    await rpc.componentWrite({
      workspaceId: MIGRATION_WORKSPACE,
      canvasId: 'default',
      tier: 'own',
      userId: null,
      name: 'Stowaway',
      source: 'export default () => null;\n',
    });

    const report = await verifyMigration(rpc, resolved);
    expect(report.ok).toBe(false);
    expect(report.unexpected).toEqual([{ name: 'Stowaway', tier: 'own' }]);
  });

  test('a shared Record is one surprise, not one per canvas listed', async () => {
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

    // Three canvases are listed (default, and the two own tiers) and all three see it.
    expect((await verifyMigration(rpc, resolved)).unexpected).toEqual([{ name: 'Tmp_GuestShared', tier: 'shared' }]);
  });

  test('the two unrecoverable Components are named in every report, never silently absent', async () => {
    // "Three of five" has to be stated. A clean ✅ over a canvas that still shows two dead
    // cards is the report reading better than the world.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    expect((await verifyMigration(rpc, resolved)).lost).toEqual(PERMANENTLY_LOST);
    expect(PERMANENTLY_LOST).toEqual(['AccessExplorer', 'ScenarioMap']);
  });

  test('the platform tier is not mistaken for migrated content', async () => {
    // `component.list` spans all three tiers; base Components ship with the image and are
    // nobody's migration.
    const resolved = await resolveSources(synthetic(), fakeSources());
    await migrateRecords(rpc, resolved, { write: true });

    expect((await verifyMigration(rpc, resolved)).unexpected).toEqual([]);
  });
});
