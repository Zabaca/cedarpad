// Move the surviving workspace content into Records (#365, ADR-0022) and restore the three
// Components recovered from session transcripts.
//
//   bun run scripts/migrate-records.ts migrate [--target local|<origin>] [--from <dir>] [--write]
//   bun run scripts/migrate-records.ts verify  [--target local|<origin>] [--from <dir>]
//
// THE DRY RUN IS THE DEFAULT. `migrate` reads the sources, checks them against the pinned
// byte lengths and hashes, asks the store what it already holds, and prints what it WOULD do.
// `--write` is the only thing that writes, and it writes only Records that do not exist yet.
//
// WHAT MOVES is an allowlist of four files, not a directory sweep — see
// `server/record-migration.ts` for the list and for what was inventoried and rejected.
//
// THE ARCHIVES ARE NEVER WRITTEN. There is no `put` in this file or anywhere below it: the
// tarballs stay exactly as they are, and until #366 retires them they are the rollback.
//
// TARGETS
//   --target local     (default) the edge handler running IN THIS PROCESS over this
//                      worktree's local D1. Nothing deployed, nothing shared — and it is the
//                      real path: the container's own RPC client, the real edge handler, the
//                      real row store. Needs `bun run webpoc:db:migrate:local` first.
//   --target <origin>  a deployed Worker, e.g. https://app.cedarpad.com. Authenticates with
//                      the platform-RPC bearer derived from BETTER_AUTH_SECRET in the
//                      ENVIRONMENT (sops provides it) — nothing on the command line.
//
// SOURCES
//   The three recovered Components are read from the repository. `Outliner.tsx` is read out
//   of `workspaces/default/shared-components.tar` in R2 (R2_* env, read-only), or from a
//   local copy of the bucket with `--from <dir>`.

import { fileURLToPath } from 'node:url';

import { fsBackend, s3Backend } from '../server/blob-store.ts';
import { requireLocalD1File } from '../server/local-d1.ts';
import { platformRpc } from '../server/platform-rpc-client.ts';
import {
  type ArchiveEntryRef,
  type ArchiveSurvey,
  MIGRATION_PLAN,
  MIGRATION_WORKSPACE,
  type MigrationReport,
  type MigrationRpc,
  type MigrationSources,
  HUDSON_STANDUP_CANVAS,
  NOT_MIGRATED,
  SOURCE_ARCHIVES,
  type VerifyReport,
  migrateRecords,
  prepareMigration,
  verifyMigration,
} from '../server/record-migration.ts';
import { createDb } from '../web-poc/lib/db/client.ts';
import { handlePlatformRpc } from '../worker/platform-rpc.ts';

const RECOVERED = new URL('../../../docs/incidents/2026-07-29-empty-archive-overwrite/recovered/', import.meta.url);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function sources(): MigrationSources {
  const from = flag('from');
  const backend = from ? fsBackend(from) : s3Backend();
  return {
    archive: (key) => backend.get(key),
    recovered: async (file) => {
      const f = Bun.file(fileURLToPath(new URL(file, RECOVERED)));
      return (await f.exists()) ? await f.text() : null;
    },
  };
}

/**
 * The store this run talks to. Both targets go through the container's OWN platform-RPC
 * client, so a migration write is the same call a `write_component` tool call makes — the
 * local one just answers it in this process instead of over the wire.
 */
function target(): { rpc: MigrationRpc; label: string; detail?: string } {
  const chosen = flag('target') ?? 'local';
  if (chosen !== 'local') {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      throw new Error(
        'an origin target needs BETTER_AUTH_SECRET in the environment (sops provides it).\n' +
          '   It is never passed on the command line — the bearer is derived from it per request.',
      );
    }
    const rpc = platformRpc({ origin: chosen, secret });
    if (!rpc) throw new Error(`could not build a client for ${chosen}`);
    return { rpc, label: chosen };
  }

  const file = requireLocalD1File();
  const db = createDb({ url: `file:${file}` });
  // A secret this process invents and immediately uses: the local edge's bearer check is real
  // (it is the same handler), but there is no second party to share it with.
  const secret = crypto.randomUUID();
  const rpc = platformRpc({
    origin: 'http://local.invalid',
    secret,
    fetchImpl: (url, init) =>
      handlePlatformRpc(new Request(url, init), { BETTER_AUTH_SECRET: secret }, { db }),
  });
  if (!rpc) throw new Error('could not build the in-process client');
  return { rpc, label: 'the local D1', detail: file };
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const SYMBOL: Record<string, string> = { create: '+', identical: '=', differs: '!', ok: '✓', missing: '✗', mismatch: '✗' };

function printPlan() {
  console.log(`\nplan — ${MIGRATION_PLAN.length} Records, an allowlist (never a directory sweep)`);
  for (const p of MIGRATION_PLAN) {
    const where = p.origin.kind === 'archive' ? `${p.origin.key}!${p.origin.path}` : `recovered/${p.origin.file}`;
    console.log(`   ${p.name.padEnd(18)} ${p.tier.padEnd(6)} ${String(p.bytes).padStart(6)} b  ${where}`);
  }
  console.log(`\nnot migrated — content in the archives, deliberately left there:`);
  for (const r of NOT_MIGRATED) console.log(`   ${r.path.padEnd(52)} ${String(r.bytes).padStart(5)} b  ${r.why}`);
}

/** What the enumeration found, before anything is read or written. The counts are the point:
 *  "0 unrecognised" is the only line here that licenses the rest of the run. */
function printSurvey(survey: ArchiveSurvey) {
  console.log(`\nsurvey — every content-bearing entry in ${SOURCE_ARCHIVES.length} archives (sessions.tar is not one: Transcripts are Files)`);
  for (const key of SOURCE_ARCHIVES) {
    const inKey = (list: ArchiveEntryRef[]) => list.filter((e) => e.key === key).length;
    console.log(
      `   ${key.padEnd(46)} ${String(inKey(survey.planned)).padStart(2)} planned  ` +
        `${String(inKey(survey.residue)).padStart(2)} left behind  ${String(inKey(survey.unrecognised)).padStart(2)} unrecognised`,
    );
  }
  console.log(`   ${'TOTAL'.padEnd(46)} ${String(survey.planned.length).padStart(2)} planned  ${String(survey.residue.length).padStart(2)} left behind  ${String(survey.unrecognised.length).padStart(2)} unrecognised`);
}

function printMigration(report: MigrationReport, wrote: boolean, label: string): number {
  console.log(`\n${'record'.padEnd(20)} ${'tier'.padEnd(7)} ${'bytes'.padStart(6)}  action`);
  console.log('-'.repeat(72));
  for (const o of report.outcomes) {
    const action = o.rev !== null ? `created rev ${o.rev}` : o.action === 'create' ? 'would create' : o.action;
    console.log(`${SYMBOL[o.action]} ${o.item.name.padEnd(18)} ${o.item.tier.padEnd(7)} ${String(o.item.bytes).padStart(6)}  ${action}`);
  }
  console.log('-'.repeat(72));
  printLost(report.lost);
  if (!report.ok) {
    console.error(
      `\n❌ a Record already exists with DIFFERENT content and was NOT overwritten.\n` +
        '   That is someone\'s later edit or a source we did not expect — either way a human decides,\n' +
        '   not this script. Read it with `component_history` before doing anything else.',
    );
    return 1;
  }
  const written = report.outcomes.filter((o) => o.rev !== null).length;
  if (!wrote) console.log(`\n✅ dry run against ${label} — NOTHING was written. Re-run with --write to migrate.`);
  else if (written === 0) console.log(`\n✅ already migrated — every Record in ${label} is identical. Nothing written.`);
  else console.log(`\n✅ ${written} Record(s) written to ${label} — now run \`verify\`.`);
  return 0;
}

function printLost(lost: readonly string[]) {
  console.log(
    `\n⚠️  ${lost.length} Component(s) are PERMANENTLY LOST and are not part of this migration:\n` +
      `   ${lost.join(', ')}\n` +
      '   Destroyed in the same 2026-07-29 flush, with no `write_component` call in any retained\n' +
      `   transcript and no object versioning in R2. Their cards on ${HUDSON_STANDUP_CANVAS}\n` +
      '   stay dead and should be REMOVED from the canvas rather than waited on.\n' +
      '   Three of five restored, not five of five.',
  );
}

function printVerify(report: VerifyReport, label: string): number {
  console.log(`\n${'record'.padEnd(20)} ${'tier'.padEnd(7)} ${'expected'.padStart(8)} ${'actual'.padStart(8)}  result`);
  console.log('-'.repeat(72));
  for (const f of report.findings) {
    console.log(
      `${SYMBOL[f.status]} ${f.name.padEnd(18)} ${f.tier.padEnd(7)} ${String(f.expectedBytes).padStart(8)} ${String(f.actualBytes ?? '-').padStart(8)}  ${f.status}`,
    );
  }
  console.log('-'.repeat(72));
  for (const u of report.unexpected) console.error(`! ${u.name.padEnd(18)} ${u.tier.padEnd(7)} is in a migrated tier and is NOT on the allowlist`);
  printLost(report.lost);
  if (!report.ok) {
    console.error('\n❌ the store does not hold what the migration says it does.');
    return 1;
  }
  console.log(`\n✅ every planned Record is in ${label}, in its tier, byte for byte, and nothing else is.`);
  return 0;
}

// ---------------------------------------------------------------------------

const USAGE = `usage:
  migrate-records.ts migrate [--target local|<origin>] [--from <dir>] [--write]
  migrate-records.ts verify  [--target local|<origin>] [--from <dir>]

--target defaults to "local": the real edge handler in THIS process over this worktree's
         local D1. An <origin> (https://app.cedarpad.com) needs BETTER_AUTH_SECRET in the
         environment; sops provides it and nothing goes on the command line.
--from   read the archive from a local copy of the bucket instead of R2 (R2_* env).
--write  actually write. WITHOUT IT NOTHING IS WRITTEN — the dry run is the default, and it
         reads production perfectly happily.

Only Records that do not exist are written. One that exists and differs is reported and left
alone. The R2 tarballs are never written or deleted.

BOTH verbs first ENUMERATE the archives and refuse to continue if they hold any content that
is in neither the plan nor the not-migrated list. Production is in use; the allowlist is a
claim about the world that has already gone stale once.`;

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd !== 'migrate' && cmd !== 'verify') {
    console.log(USAGE);
    process.exit(1);
  }

  const write = cmd === 'migrate' && process.argv.includes('--write');
  const { rpc, label, detail } = target();
  console.log(`workspace ${MIGRATION_WORKSPACE}`);
  console.log(`canvas    ${HUDSON_STANDUP_CANVAS}  ("Hudson Standup" — where the dead cards are)`);
  console.log(`target    ${label}${write ? '   *** WRITING ***' : '   (read-only)'}`);
  if (detail) console.log(`          ${detail}`);
  if (cmd === 'migrate') printPlan();

  // The gate. Refuses — loudly, naming paths — on an archive entry nobody has decided about,
  // on an archive it could not read, and on a source whose bytes are not the pinned ones.
  // Nothing below runs until it passes. Reported as a message rather than a stack trace: the
  // operator has a decision to make, not a bug to debug.
  const prepared = await prepareMigration(sources()).catch((err: Error) => err);
  if (prepared instanceof Error) {
    console.error(`\n❌ ${prepared.message}`);
    process.exit(1);
  }
  const { survey, resolved } = prepared;
  printSurvey(survey);

  process.exit(
    cmd === 'migrate'
      ? printMigration(await migrateRecords(rpc, resolved, { write }), write, label)
      : printVerify(await verifyMigration(rpc, resolved), label),
  );
}
