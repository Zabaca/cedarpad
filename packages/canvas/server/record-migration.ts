// The 2026-07-29 backfill (#365, ADR-0022): the surviving workspace content moves out of the
// R2 tarballs and into Records, and the three Components recovered from session transcripts
// are restored with it.
//
// AN ALLOWLIST, NEVER A DIRECTORY SWEEP. A read-only inventory of production on 2026-07-29
// found the archives are mostly e2e residue: a 44-byte `Tmp_GuestShared.tsx`, a 13-byte test
// data file, a two-file test skill, and the image's own `hello.ts`. A migration that walked
// the archives would report "6 records written" and seed the store we are building to be
// trustworthy with junk. So every artefact is named here, with the byte length and sha256 it
// was inventoried at, and anything else stays where it is. `NOT_MIGRATED` records what was
// looked at and rejected, because a decision nobody wrote down is one the next sweep undoes.
//
// WRITES GO THROUGH THE ORDINARY DOOR. Everything here moves through the platform RPC —
// `component.write`, the same call a `write_component` tool call makes — so the edge's
// validation, its ownership check and `RecordStore.put`'s append-a-version invariant all
// apply. A migration that reached past them with SQL would prove nothing about the store it
// is migrating into, and would be the one write in the system with no history.
//
// The tarballs are never written and never deleted (#366 retires them): until then they are
// the rollback.

import { createHash } from 'node:crypto';

import type { PlatformRpc } from './platform-rpc-client.ts';
import { sharedComponentsKey } from './blob-store.ts';
import { tarEntries } from './persist-guards.ts';

/** The legacy production workspace — `worker/shell-routing.ts` DEFAULT_WORKSPACE_ID. */
export const MIGRATION_WORKSPACE = 'default';

/** The canvas whose own-tier library the 09:39 flush emptied. Its `components/` directory is
 *  still in `canvas-components.tar`, present and containing nothing; that emptiness IS the
 *  incident. Registered as "Cedarpad" in the canvas registry, "Hudson Standup" in the report. */
export const HUDSON_STANDUP_CANVAS = 'cv_4bfb07e3-cd4e-4fc8-a3ed-54a4b20d483b';

/** The one archive with real content left in it. */
export const SHARED_ARCHIVE_KEY = sharedComponentsKey(MIGRATION_WORKSPACE);

/**
 * Who a migration write is attributed to: **nobody**.
 *
 * `updated_by` is documented as the Better Auth user id of the last writer, and #371 is
 * explicit that a placeholder there — a value no user query will ever match — is a history
 * that LOOKS attributed and is not, which is worse than one that admits the gap. A migration
 * is not a person, and the authors of these four files are not recoverable per-file anyway:
 * three came out of transcripts and one out of an archive. Null is the true answer, and the
 * provenance that matters (this is v1, written at time T by the backfill) is on the version
 * row already.
 */
export const MIGRATION_AUTHOR: string | null = null;

/** Where one Record's bytes come from. */
export type MigrationOrigin =
  | { kind: 'archive'; key: string; path: string }
  | { kind: 'recovered'; file: string };

/** One artefact on the allowlist, pinned to the bytes it was inventoried at. */
export interface PlannedRecord {
  /** The Record key's third coordinate — the Component name, no extension. */
  name: string;
  /** `shared` = the workspace library (`canvas_id NULL`); `own` = this canvas's library. */
  tier: 'own' | 'shared';
  /** The canvas the write is performed FROM — the edge's entitlement proof, and for an
   *  own-tier write the tier itself. A shared write names the legacy `default` canvas. */
  canvasId: string;
  bytes: number;
  sha256: string;
  origin: MigrationOrigin;
  why: string;
}

/**
 * The payload. Four files — and it is worth saying plainly that this is what a whole
 * workspace's authored content was reduced to.
 */
export const MIGRATION_PLAN: readonly PlannedRecord[] = [
  {
    name: 'Outliner',
    tier: 'shared',
    canvasId: 'default',
    bytes: 13126,
    sha256: '060a91dc1ed41f02887f0fcfe603e09f9c836b1a423a457714b5311060ccd5bb',
    origin: { kind: 'archive', key: SHARED_ARCHIVE_KEY, path: 'Outliner.tsx' },
    why: 'the only substantial survivor in R2 — the shared library never lost its archive',
  },
  {
    name: 'AudioMeeting',
    tier: 'own',
    canvasId: HUDSON_STANDUP_CANVAS,
    bytes: 13410,
    sha256: 'eac89ecdfd6c6d2fbc36ea529bef79707ae216c57cd9c61ee7942c2157b7cdb1',
    origin: { kind: 'recovered', file: 'AudioMeeting.tsx' },
    why: 'recovered from a session transcript; the committed copy is the only one that exists',
  },
  {
    name: 'ChatRoom',
    tier: 'own',
    canvasId: HUDSON_STANDUP_CANVAS,
    bytes: 16076,
    sha256: '96e443566b60eab1845ff599988551d851d7078eb1272cd3c0f627b8f525cd17',
    origin: { kind: 'recovered', file: 'ChatRoom.tsx' },
    why: 'recovered from a session transcript; the committed copy is the only one that exists',
  },
  {
    name: 'ComponentCatalog',
    tier: 'own',
    canvasId: HUDSON_STANDUP_CANVAS,
    bytes: 6947,
    sha256: 'e68a1618c4351f715349a3bb1d269180fd8ddbd70a8145b49517ab875a3c826e',
    origin: { kind: 'recovered', file: 'ComponentCatalog.tsx' },
    why: 'recovered, then REPOINTED: as written it called /api/custom/component-catalog, a handler destroyed in the same flush and a feature removed by #357',
  },
];

/** The two Components destroyed in the same flush with no surviving copy anywhere — no
 *  `write_component` call for either appears in any retained transcript, and R2 has no object
 *  versioning. Named here, and named in every report, so "three of five" is stated rather
 *  than inferred from a success message. Their placed cards stay dead; they should be removed
 *  from the canvas rather than waited on. */
export const PERMANENTLY_LOST: readonly string[] = ['HenryAccessExplorer', 'HenryScenarioMap'];

/** Everything else the archives hold, and why it stays there. Verified against production R2
 *  on 2026-07-29 — this is the list a directory sweep would have imported. */
export const NOT_MIGRATED: ReadonlyArray<{ what: string; bytes: number; why: string }> = [
  { what: 'Tmp_GuestShared.tsx', bytes: 44, why: 'e2e residue in shared-components.tar — a one-line stub from the guest-write spec' },
  { what: '.gitkeep', bytes: 0, why: 'placeholder that keeps an empty directory in the archive; carries no content' },
  { what: 'zz_test_data_cd0fc124.json', bytes: 13, why: 'e2e residue — the only file left in canvas-components.tar, and not a Component' },
  { what: 'zz-test-skill-b7acb8fa/', bytes: 24, why: 'the whole of skills.tar is one test skill; #361 built the skills path, this slice moves no real skill' },
  { what: 'hello.ts', bytes: 720, why: "custom.tar's only file is the image's own seed, byte-identical to server/custom/hello.ts; the feature is gone (#357)" },
];

/** Where the bytes are read from. Both answer null for "not there", so an absent source is a
 *  reported problem rather than an empty migration that claims success. */
export interface MigrationSources {
  /** An R2 object's bytes — the tarball, untouched and unwritten. */
  archive(key: string): Promise<Uint8Array | null>;
  /** A file in `docs/incidents/2026-07-29-empty-archive-overwrite/recovered/`. */
  recovered(file: string): Promise<string | null>;
}

/** A planned Record with its bytes in hand, verified against the pins. */
export interface ResolvedRecord {
  item: PlannedRecord;
  source: string;
}

/** One file out of a POSIX tarball, or null when the archive does not hold it. The offset of
 *  each entry's payload is the sum of the headers and padded bodies before it, which is
 *  exactly the walk `tarEntries` already does. */
export function tarFile(bytes: Uint8Array, path: string): Uint8Array | null {
  let offset = 0;
  for (const entry of tarEntries(bytes)) {
    const body = offset + 512;
    offset = body + Math.ceil(entry.size / 512) * 512;
    // Archives written by `tarSubtree` prefix entries with `./`; match on the tail.
    if (entry.name === path || entry.name.endsWith(`/${path}`)) return bytes.slice(body, body + entry.size);
  }
  return null;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Read every planned Record's source and check it against the pins.
 *
 * THROWS on anything unexpected, and deliberately before a single write: the archive is
 * mutable, the pins are the only thing that would notice it changed under us, and a partial
 * migration that reports success for the files it did find is the failure mode this whole
 * ADR exists to remove.
 */
export async function resolveSources(
  plan: readonly PlannedRecord[],
  sources: MigrationSources,
): Promise<ResolvedRecord[]> {
  const resolved: ResolvedRecord[] = [];
  for (const item of plan) {
    let source: string;
    if (item.origin.kind === 'archive') {
      const archive = await sources.archive(item.origin.key);
      if (!archive) throw new Error(`${item.name}: no archive at ${item.origin.key}`);
      const file = tarFile(archive, item.origin.path);
      if (!file) throw new Error(`${item.name}: ${item.origin.key} holds no ${item.origin.path}`);
      source = new TextDecoder().decode(file);
    } else {
      const file = await sources.recovered(item.origin.file);
      if (file === null) throw new Error(`${item.name}: no recovered file ${item.origin.file}`);
      source = file;
    }

    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes !== item.bytes) throw new Error(`${item.name}: ${bytes} bytes, expected ${item.bytes}`);
    const digest = sha256(source);
    if (digest !== item.sha256) throw new Error(`${item.name}: sha256 ${digest}, expected ${item.sha256}`);
    resolved.push({ item, source });
  }
  return resolved;
}

/** What the migration found for one Record. `differs` is the only one that stops the run. */
export type MigrationAction = 'create' | 'identical' | 'differs';

export interface MigrationOutcome {
  item: PlannedRecord;
  action: MigrationAction;
  /** The revision the write created; null when nothing was written (a dry run, or a skip). */
  rev: number | null;
}

export interface MigrationReport {
  outcomes: MigrationOutcome[];
  /** Did this run write anything? False for every dry run, and for a re-run that found
   *  everything already in place. */
  wrote: boolean;
  ok: boolean;
  lost: readonly string[];
}

/** The three RPC verbs this needs — the container's own client satisfies it. */
export type MigrationRpc = Pick<PlatformRpc, 'componentWrite' | 'componentRead' | 'componentList'>;

const key = (item: PlannedRecord) => ({
  workspaceId: MIGRATION_WORKSPACE,
  canvasId: item.canvasId,
  tier: item.tier,
  name: item.name,
});

/**
 * The migration. **Reads by default; writes only when told to** — the dry run is not a mode,
 * it is what happens unless someone asks for the other thing.
 *
 * IDEMPOTENCE IS SKIP-IF-IDENTICAL, not overwrite. `put` bumps `rev` and appends a version,
 * so a blind re-run would leave a spurious v2 in the history of every Component — noise in
 * the one record that answers "what changed here", and a second run that looks exactly like
 * a real edit. A Record that is byte-identical to what we would write is already migrated.
 *
 * A Record that exists and DIFFERS is never overwritten. That is either someone's later edit
 * or a source we did not expect, and both are decisions for a human — the shape this ADR is
 * a response to is a write that assumed it knew better than what was already there.
 */
export async function migrateRecords(
  rpc: MigrationRpc,
  resolved: readonly ResolvedRecord[],
  opts: { write: boolean },
): Promise<MigrationReport> {
  const outcomes: MigrationOutcome[] = [];
  for (const { item, source } of resolved) {
    const current = await rpc.componentRead(key(item));
    const action: MigrationAction = current === null ? 'create' : current === source ? 'identical' : 'differs';
    const rev =
      action === 'create' && opts.write ? (await rpc.componentWrite({ ...key(item), userId: MIGRATION_AUTHOR, source })).rev : null;
    outcomes.push({ item, action, rev });
  }
  return {
    outcomes,
    wrote: outcomes.some((o) => o.rev !== null),
    ok: !outcomes.some((o) => o.action === 'differs'),
    lost: PERMANENTLY_LOST,
  };
}

export interface VerifyFinding {
  name: string;
  tier: 'own' | 'shared';
  status: 'ok' | 'missing' | 'mismatch';
  expectedBytes: number;
  /** Null when the Record is absent. */
  actualBytes: number | null;
}

export interface VerifyReport {
  findings: VerifyFinding[];
  /** Records in a migrated tier that the plan does not name. Immediately after a migration
   *  there should be none; each one is either junk a sweep imported or a write that arrived
   *  from somewhere else, and both deserve a human look. */
  unexpected: Array<{ name: string; tier: 'own' | 'shared' }>;
  lost: readonly string[];
  ok: boolean;
}

/**
 * "Did everything move?" as a check rather than a hope (PRD #354 story 36) — re-runnable, and
 * deliberately independent of the run that did the moving: it asks the store what is there and
 * compares it to the pinned bytes, so a migration that reported success and wrote nothing is
 * caught. Content, not presence: a Record of the right name and the wrong text is a mismatch.
 */
export async function verifyMigration(rpc: MigrationRpc, resolved: readonly ResolvedRecord[]): Promise<VerifyReport> {
  const findings: VerifyFinding[] = [];
  for (const { item, source } of resolved) {
    const current = await rpc.componentRead(key(item));
    findings.push({
      name: item.name,
      tier: item.tier,
      status: current === null ? 'missing' : current === source ? 'ok' : 'mismatch',
      expectedBytes: item.bytes,
      actualBytes: current === null ? null : Buffer.byteLength(current, 'utf8'),
    });
  }

  // One listing answers for both migrated tiers: a canvas sees its own library and the
  // workspace's. The platform tier is in there too and is nobody's migration — it ships with
  // the image, so it is filtered out rather than reported as a surprise.
  const listed = await rpc.componentList({ workspaceId: MIGRATION_WORKSPACE, canvasId: HUDSON_STANDUP_CANVAS });
  const planned = new Set(resolved.map((r) => r.item.name));
  const unexpected = listed
    .filter((e) => e.tier !== 'base' && !planned.has(e.name))
    .map((e) => ({ name: e.name, tier: e.tier as 'own' | 'shared' }));

  return {
    findings,
    unexpected,
    lost: PERMANENTLY_LOST,
    ok: findings.every((f) => f.status === 'ok') && unexpected.length === 0,
  };
}
