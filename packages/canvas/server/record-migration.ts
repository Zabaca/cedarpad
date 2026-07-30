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
// AND THE ALLOWLIST IS CHECKED AGAINST THE ARCHIVES, not trusted. The first version of this
// file said "verified against production R2 on 2026-07-29" — true when written, false four
// hours later, when `WorkflowGraph.tsx` (25,019 b of real user work) was authored in
// production and landed in `canvas-components.tar`. It was in neither list, and because
// `resolveSources` iterates the PLAN, nothing noticed: the run would have reported success
// and left it behind. So `surveyArchives` walks every source archive and classifies every
// content-bearing entry as planned or explicitly-not-migrated, and `prepareMigration` REFUSES
// TO RUN on anything else, naming the paths and byte counts it did not recognise. A pinned
// hash proves the bytes of a file we know about; only an enumeration proves we know about all
// the files. A migration that cannot enumerate what it is leaving behind is the same move
// that caused this PRD.
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
import { canvasDirsKey, sharedComponentsKey, skillsKey } from './blob-store.ts';
import { PLACEHOLDERS, tarEntries } from './persist-guards.ts';

/** The legacy production workspace — `worker/shell-routing.ts` DEFAULT_WORKSPACE_ID. */
export const MIGRATION_WORKSPACE = 'default';

/**
 * The canvas whose own-tier library the 09:39 flush emptied — the one the three recovered
 * Components go back to. Its `components/` directory is still in `canvas-components.tar`,
 * present and containing nothing; that emptiness IS the incident.
 *
 * NOTE THE NAME. #365 calls this one "Hudson Standup" throughout, but the canvas registry
 * calls it **"Cedarpad"** — and the canvas actually registered as "Hudson Standup" is
 * `WORKFLOW_CANVAS` below, a different id entirely. Whether it was renamed since the incident
 * or mislabelled in the issue is not knowable from here, so these constants are named for
 * what they hold rather than for either title, and the report prints ids.
 */
export const RESTORED_CANVAS = 'cv_4bfb07e3-cd4e-4fc8-a3ed-54a4b20d483b';

/** The canvas `WorkflowGraph.tsx` was authored on, after the incident and while this migration
 *  was being written. Registered as "Hudson Standup". Untouched by the flush — its Component
 *  is in the archive because the container is still tarring, which is the state #366 ends. */
export const WORKFLOW_CANVAS = 'cv_edd9bab6-8bae-4a7a-a694-9abfa9965db9';

export const SHARED_ARCHIVE_KEY = sharedComponentsKey(MIGRATION_WORKSPACE);
export const CANVAS_ARCHIVE_KEY = canvasDirsKey(MIGRATION_WORKSPACE);
export const SKILLS_ARCHIVE_KEY = skillsKey(MIGRATION_WORKSPACE);
/** #357 removed the custom-handler feature and its key constant with it. The OBJECT is still
 *  in the bucket, and an enumeration that skipped it would be precisely the blind spot the
 *  survey exists to close, so the key is spelled out here rather than dropped. */
export const CUSTOM_ARCHIVE_KEY = `workspaces/${MIGRATION_WORKSPACE}/custom.tar`;

/**
 * Every archive this migration is answerable for. `sessions.tar` is deliberately absent:
 * Transcripts are **Files**, not Records (ADR-0022 decision 2), they moved to per-session
 * objects in #356, and nothing here may claim to have surveyed them.
 */
export const SOURCE_ARCHIVES: readonly string[] = [
  SHARED_ARCHIVE_KEY,
  CANVAS_ARCHIVE_KEY,
  SKILLS_ARCHIVE_KEY,
  CUSTOM_ARCHIVE_KEY,
];

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
 * The payload. Five files — four of which are what a whole workspace's authored content was
 * reduced to, and the fifth of which is a Component someone wrote *after* the incident, on a
 * different canvas, while this was being built. It is here because the survey found it, not
 * because anyone remembered it.
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
    canvasId: RESTORED_CANVAS,
    bytes: 13410,
    sha256: 'eac89ecdfd6c6d2fbc36ea529bef79707ae216c57cd9c61ee7942c2157b7cdb1',
    origin: { kind: 'recovered', file: 'AudioMeeting.tsx' },
    why: 'recovered from a session transcript; the committed copy is the only one that exists',
  },
  {
    name: 'ChatRoom',
    tier: 'own',
    canvasId: RESTORED_CANVAS,
    bytes: 16076,
    sha256: '96e443566b60eab1845ff599988551d851d7078eb1272cd3c0f627b8f525cd17',
    origin: { kind: 'recovered', file: 'ChatRoom.tsx' },
    why: 'recovered from a session transcript; the committed copy is the only one that exists',
  },
  {
    name: 'ComponentCatalog',
    tier: 'own',
    canvasId: RESTORED_CANVAS,
    bytes: 6947,
    sha256: 'e68a1618c4351f715349a3bb1d269180fd8ddbd70a8145b49517ab875a3c826e',
    origin: { kind: 'recovered', file: 'ComponentCatalog.tsx' },
    why: 'recovered, then REPOINTED: as written it called /api/custom/component-catalog, a handler destroyed in the same flush and a feature removed by #357',
  },
  {
    name: 'WorkflowGraph',
    tier: 'own',
    canvasId: WORKFLOW_CANVAS,
    bytes: 25019,
    sha256: 'dbe821f0413099cb129cf123e8a8e8fd71a2b602a7ea5de961ecaf90c3fe8b0c',
    origin: { kind: 'archive', key: CANVAS_ARCHIVE_KEY, path: `canvas-${WORKFLOW_CANVAS}/components/WorkflowGraph.tsx` },
    // Verified as migratable AS-IS: one import (`react`), no `fetch(`, no `/api/`, no relative
    // import — so unlike ComponentCatalog it needs no repoint. Its header comment references
    // "the skill's SCHEMA.md"; there is no `ticket-forge` skill in `skills.tar`, none in the
    // repo, and the survey finds nothing skill-shaped, so either it was never a Workspace
    // skill or it went in the same flush. Raised separately; it does not block this Component.
    why: 'authored in production on 2026-07-29 AFTER the incident — real user work, found by the survey rather than by memory',
  },
];

/** The two Components destroyed in the same flush with no surviving copy anywhere — no
 *  `write_component` call for either appears in any retained transcript, and R2 has no object
 *  versioning. Named here, and named in every report, so "three of five" is stated rather
 *  than inferred from a success message. Their placed cards stay dead; they should be removed
 *  from the canvas rather than waited on. */
export const PERMANENTLY_LOST: readonly string[] = ['HenryAccessExplorer', 'HenryScenarioMap'];

/** One archive entry deliberately left where it is. Keyed by archive AND path, because the
 *  survey classifies against this list: a bare filename would let a same-named file in a
 *  different archive pass as already-decided. A `path` ending in `/` is a directory prefix. */
export interface UnmigratedEntry {
  key: string;
  path: string;
  bytes: number;
  why: string;
}

/** Everything else the archives hold, and why it stays there. Directory entries and
 *  placeholders (`.gitkeep`) are not listed: they are not content, exactly as `tarHasContent`
 *  judges them, and the survey filters them before it classifies anything. */
export const NOT_MIGRATED: readonly UnmigratedEntry[] = [
  {
    key: SHARED_ARCHIVE_KEY,
    path: 'Tmp_GuestShared.tsx',
    bytes: 44,
    why: 'e2e residue — a one-line stub from the guest-write spec',
  },
  {
    key: CANVAS_ARCHIVE_KEY,
    path: 'canvas-default/components/zz_test_data_cd0fc124.json',
    bytes: 13,
    why: 'e2e residue, and not a Component — a data file nobody imports',
  },
  {
    key: SKILLS_ARCHIVE_KEY,
    path: 'zz-test-skill-b7acb8fa/',
    bytes: 24,
    why: 'the whole of skills.tar is one test skill; #361 built the skills path, this slice moves no real skill',
  },
  {
    key: CUSTOM_ARCHIVE_KEY,
    path: 'hello.ts',
    bytes: 720,
    why: "the image's own seed, byte-identical to server/custom/hello.ts; the feature is gone (#357)",
  },
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

/** Archives written by `tarSubtree` prefix entries with `./`; `tarCanvasDirs` does not. One
 *  spelling, so a plan path and an archive entry are comparable by equality rather than by a
 *  suffix match that could quietly claim the wrong file. */
const normalize = (path: string): string => path.replace(/^\.?\//, '');

/** One entry of a tarball that actually carries content, with its payload. Directory entries
 *  and placeholders are excluded — the same judgement `tarHasContent` makes, deliberately
 *  shared, so the survey and the empty-archive guard can never disagree about what is in an
 *  archive. The offset of each payload is the sum of the headers and padded bodies before it,
 *  which is exactly the walk `tarEntries` already does. */
export function tarContents(bytes: Uint8Array): Array<{ path: string; bytes: number; body: Uint8Array }> {
  const out: Array<{ path: string; bytes: number; body: Uint8Array }> = [];
  let offset = 0;
  for (const entry of tarEntries(bytes)) {
    const start = offset + 512;
    offset = start + Math.ceil(entry.size / 512) * 512;
    if (entry.type === '5' || entry.name.endsWith('/')) continue;
    const path = normalize(entry.name);
    if (PLACEHOLDERS.has(path.split('/').pop() ?? '')) continue;
    out.push({ path, bytes: entry.size, body: bytes.slice(start, start + entry.size) });
  }
  return out;
}

/** One file out of a POSIX tarball, or null when the archive does not hold it. */
export function tarFile(bytes: Uint8Array, path: string): Uint8Array | null {
  return tarContents(bytes).find((e) => e.path === normalize(path))?.body ?? null;
}

/** One content-bearing archive entry, as the survey refers to it. */
export interface ArchiveEntryRef {
  key: string;
  path: string;
  bytes: number;
}

/** Every content-bearing entry in every source archive, classified. */
export interface ArchiveSurvey {
  /** Entries a `MIGRATION_PLAN` item reads. */
  planned: ArchiveEntryRef[];
  /** Entries `NOT_MIGRATED` explicitly leaves behind. */
  residue: ArchiveEntryRef[];
  /** Everything else — content nobody has made a decision about. */
  unrecognised: ArchiveEntryRef[];
}

/** A residue rule matches one exact path, or a whole directory when it ends in `/`. */
const covers = (rule: string, path: string): boolean => (rule.endsWith('/') ? path.startsWith(rule) : path === rule);

/**
 * Walk every source archive and classify every file in it.
 *
 * This is the question the first version of this migration never asked: not "do the files I
 * know about still have the bytes I recorded" — the pins answer that — but **"is there
 * anything here I was not told about?"**. `resolveSources` iterates the plan, so without this
 * an artefact in neither list is silently left behind and the run still reports success. That
 * is not hypothetical: `WorkflowGraph.tsx` appeared in production four hours after the plan
 * was written, and only an enumeration could have caught it.
 *
 * An archive that cannot be read is an ERROR, never an empty archive. A survey with holes
 * reads exactly like a clean one (`scripts/census-unmigratable.sh` learned this the hard way),
 * and the whole value of this function is that its "nothing unrecognised" means something.
 */
export async function surveyArchives(
  sources: MigrationSources,
  plan: readonly PlannedRecord[] = MIGRATION_PLAN,
  residue: readonly UnmigratedEntry[] = NOT_MIGRATED,
): Promise<ArchiveSurvey> {
  const survey: ArchiveSurvey = { planned: [], residue: [], unrecognised: [] };
  for (const key of SOURCE_ARCHIVES) {
    const archive = await sources.archive(key);
    if (!archive) {
      throw new Error(
        `cannot read ${key} — refusing to survey the archives over an unknown denominator.\n` +
          '   A survey with holes reads exactly like a clean one. Fix the read before migrating.',
      );
    }
    for (const entry of tarContents(archive)) {
      const ref: ArchiveEntryRef = { key, path: entry.path, bytes: entry.bytes };
      const isPlanned = plan.some((p) => p.origin.kind === 'archive' && p.origin.key === key && normalize(p.origin.path) === entry.path);
      const isResidue = residue.some((r) => r.key === key && covers(r.path, entry.path));
      (isPlanned ? survey.planned : isResidue ? survey.residue : survey.unrecognised).push(ref);
    }
  }
  return survey;
}

/**
 * Refuse to go any further while the archives hold content nobody has decided about.
 *
 * It names every path and its byte count, because a failure that does not say what it found
 * makes the operator guess — and the right response differs per file: add it to the plan, add
 * it to `NOT_MIGRATED`, or stop and ask whose it is.
 */
export function assertNothingUnrecognised(survey: ArchiveSurvey): void {
  if (survey.unrecognised.length === 0) return;
  const found = survey.unrecognised.map((u) => `   ${u.key}!${u.path}  ${u.bytes} b`);
  // Skills are called out separately because a skill is a DIRECTORY of files and would
  // otherwise arrive as several anonymous-looking paths, and because #365 has an open
  // question about a `ticket-forge` skill that no archive currently holds.
  const skillish = survey.unrecognised.filter((u) => u.key === SKILLS_ARCHIVE_KEY || u.path.endsWith('SKILL.md'));
  throw new Error(
    [
      `${survey.unrecognised.length} archive entr${survey.unrecognised.length === 1 ? 'y is' : 'ies are'} in neither MIGRATION_PLAN nor NOT_MIGRATED:`,
      ...found,
      '',
      '   Production changed under the allowlist. Decide about each one — migrate it (pin its',
      '   bytes and sha256) or record why it stays — and re-run. Nothing has been written.',
      ...(skillish.length > 0
        ? ['', `   ⚠️  ${skillish.length} of these are SKILL-SHAPED. A Workspace skill is a directory of`, '      files (#361); do not treat one as a stray file.']
        : []),
    ].join('\n'),
  );
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

/**
 * Everything that must happen before a run is allowed to write, in the order it must happen.
 *
 * Enumerate the archives, refuse any surprise, and only then read the planned sources and
 * check them against their pins. Both halves are preconditions, and both throw: the survey
 * answers "do I know about every file?", the pins answer "are the files I know about the ones
 * I recorded?", and a migration needs both to be able to say it moved everything.
 *
 * Every entry point goes through here — the CLI and the tests alike — so there is no path that
 * writes without having asked both questions.
 */
export async function prepareMigration(
  sources: MigrationSources,
  plan: readonly PlannedRecord[] = MIGRATION_PLAN,
): Promise<{ survey: ArchiveSurvey; resolved: ResolvedRecord[] }> {
  const survey = await surveyArchives(sources, plan);
  assertNothingUnrecognised(survey);
  return { survey, resolved: await resolveSources(plan, sources) };
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

  // EVERY canvas the plan touches, not one: a listing answers for the canvas's own library
  // and the workspace's shared one, so a second own tier is invisible from the first. The
  // plan grew a second canvas the moment `WorkflowGraph` joined it, and a check scoped to one
  // canvas would have stopped covering the other without saying so.
  const planned = new Set(resolved.map((r) => r.item.name));
  const seen = new Map<string, { name: string; tier: 'own' | 'shared' }>();
  for (const canvasId of new Set(resolved.map((r) => r.item.canvasId))) {
    const listed = await rpc.componentList({ workspaceId: MIGRATION_WORKSPACE, canvasId });
    for (const entry of listed) {
      // The platform tier is in there too and is nobody's migration — it ships with the image.
      if (entry.tier === 'base' || planned.has(entry.name)) continue;
      // Shared entries appear once per canvas listed; the same Record is one surprise.
      seen.set(`${entry.tier}\0${entry.name}`, { name: entry.name, tier: entry.tier as 'own' | 'shared' });
    }
  }
  const unexpected = [...seen.values()];

  return {
    findings,
    unexpected,
    lost: PERMANENTLY_LOST,
    ok: findings.every((f) => f.status === 'ok') && unexpected.length === 0,
  };
}
