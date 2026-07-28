// Move the platform data layer's ROWS from Turso into D1 (ADR-0018, #267).
//
// This is the cutover's data half. It is deliberately three separate commands so a human
// runs them one at a time and reads the output between each:
//
//   bun run scripts/migrate-platform-data.ts dump
//   bun run scripts/migrate-platform-data.ts load   --target local|remote --dump <dir>
//   bun run scripts/migrate-platform-data.ts verify --target local|remote --dump <dir>
//
// WHAT IT IMPORTS: table rows only. Not schema (wrangler already applied all 26 drizzle
// migrations to D1 — `d1_migrations` is its ledger) and NEITHER migration ledger. Importing
// Turso's `__drizzle_migrations` on top of wrangler's `d1_migrations` would leave two
// competing ledgers in one database. `sqlite_sequence` and `_cf_KV` are SQLite/D1 internals
// and are likewise never written.
//
// It also imports only tables that exist on BOTH sides. Turso carries one legacy table
// (`poc_visits`, 4 rows, AUTOINCREMENT, referenced by no code and in no drizzle migration)
// that has no D1 counterpart; it is reported as skipped rather than silently dropped.
//
// RE-RUNNABILITY: `load` refuses to run unless every destination table is empty. That makes
// the default one-shot and guarded. To retry after a partial load, pass `--truncate`, which
// deletes every importable table (reverse dependency order) first — so a half-finished
// import is always recoverable by re-running with that flag, never a wedged database.
//
// ORDERING: rows are inserted parent-before-child, from a topological sort of the foreign
// keys read out of the source database (`PRAGMA foreign_key_list`), so D1's FK enforcement
// is satisfied without deferring anything.
//
// CONCURRENCY: D1 admits one writer, and an external write landing mid-request corrupts
// concurrent readers (#276). Run `load` while nothing serves from D1 — i.e. while
// PLATFORM_DB_ENABLED is still "false". Import first, flip second.
//
// Turso is READ-ONLY here. Nothing in this file writes to it.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

/** Ledgers and engine-internal tables. Never dumped, never loaded, never counted. */
const NEVER_IMPORT = new Set([
  '__drizzle_migrations', // drizzle's ledger (Turso's)
  'd1_migrations', // wrangler's ledger (D1's) — the schema authority since #265
  'sqlite_sequence', // SQLite internal (AUTOINCREMENT counters)
  '_cf_KV', // D1 internal
]);

const CANVAS_DIR = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(CANVAS_DIR, 'node_modules/.bin/wrangler');
const ACCOUNT_ID = '99a19e584439be0568f33aad0477372b';

type Target = 'local' | 'remote';

// ---------------------------------------------------------------------------
// destination (D1) access
// ---------------------------------------------------------------------------

/** Run one SQL command against D1 and return the first statement's rows. */
function d1Query(target: Target, sql: string): Record<string, unknown>[] {
  return d1QueryAll(target, sql)[0] ?? [];
}

/** Same, for a multi-statement command: one result set per statement, in order. */
function d1QueryAll(target: Target, sql: string): Record<string, unknown>[][] {
  const out = d1Run(target, ['--command', sql, '--json']);
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`wrangler produced no JSON:\n${out}`);
  const parsed = JSON.parse(out.slice(start)) as { results: Record<string, unknown>[] }[];
  return parsed.map((p) => p.results ?? []);
}

/** Invoke wrangler d1 against the chosen target. `--local` goes through the per-worktree
 *  dev config (scripts/wrangler-local.ts); `--remote` uses the package's real config and
 *  needs CLOUDFLARE_API_TOKEN in the environment (`sops exec-env …`). */
function d1Run(target: Target, args: string[]): string {
  if (target === 'local') {
    // wrangler-local spawns with stdio inherit, so JSON can't be captured through it.
    // Resolve the same state dir + generated config and call wrangler directly.
    const { config, stateDir } = localWranglerArgs();
    return sh(WRANGLER, ['d1', 'execute', 'PLATFORM_DB', '--local', ...args, '--config', config, '--persist-to', stateDir]);
  }
  return sh(WRANGLER, ['d1', 'execute', 'PLATFORM_DB', '--remote', ...args], {
    CI: 'true',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  });
}

let localArgsCache: { config: string; stateDir: string } | null = null;
function localWranglerArgs() {
  if (!localArgsCache) throw new Error('local target not initialised');
  return localArgsCache;
}
async function initLocal() {
  const { localD1StateDir } = await import('../server/local-d1.ts');
  const { writeDevWorkerConfig } = await import('../server/dev-worker-config.ts');
  const { webOrigin, localBridgeOrigin } = await import('./wrangler-local.ts');
  const stateDir = localD1StateDir();
  const config = await writeDevWorkerConfig(stateDir, webOrigin(), localBridgeOrigin());
  localArgsCache = { config, stateDir };
}

function sh(cmd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync(cmd, args, {
    cwd: CANVAS_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout ?? '';
}

// ---------------------------------------------------------------------------
// SQL literal encoding
// ---------------------------------------------------------------------------

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    let hex = '';
    for (const b of bytes) hex += b.toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(v).replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

type Manifest = {
  dumpedAt: string;
  tables: string[];
  skipped: { table: string; reason: string }[];
  counts: Record<string, number>;
};

async function dump(outDir: string, target: Target) {
  const url = required('TURSO_URL');
  const token = required('TURSO_KEY');
  const src = createClient({ url, authToken: token });

  const srcTables = (
    await src.execute("select name from sqlite_master where type='table' order by name")
  ).rows.map((r) => String(r.name));

  // The destination decides what is importable: a source table with no D1 counterpart is
  // reported, not guessed at. Reading the schema is a read; it writes nothing.
  const dstTables = new Set(
    d1Query(target, "select name from sqlite_master where type='table'").map((r) => String(r.name)),
  );

  const skipped: Manifest['skipped'] = [];
  const importable: string[] = [];
  for (const t of srcTables) {
    if (NEVER_IMPORT.has(t)) skipped.push({ table: t, reason: 'ledger or engine-internal — never imported' });
    else if (!dstTables.has(t)) skipped.push({ table: t, reason: 'no such table in D1 (not in the drizzle schema)' });
    else importable.push(t);
  }

  const ordered = await topoSort(src, importable);

  const counts: Record<string, number> = {};
  const chunks: string[] = [
    `-- platform data layer: Turso -> D1 (ADR-0018 #267)`,
    `-- dumped ${new Date().toISOString()} — ROWS ONLY, no schema, no migration ledger`,
    `-- insertion order is parent-before-child (foreign keys)`,
    '',
  ];

  for (const table of ordered) {
    const rs = await src.execute(`select * from "${table}"`);
    counts[table] = rs.rows.length;
    chunks.push(`-- ${table}: ${rs.rows.length} row(s)`);
    if (rs.rows.length === 0) continue;
    const cols = rs.columns.map((c) => `"${c}"`).join(', ');
    for (const row of rs.rows) {
      const values = rs.columns.map((c) => literal((row as Record<string, unknown>)[c])).join(', ');
      chunks.push(`INSERT INTO "${table}" (${cols}) VALUES (${values});`);
    }
    chunks.push('');
  }

  mkdirSync(outDir, { recursive: true });
  const sqlPath = join(outDir, 'data.sql');
  writeFileSync(sqlPath, `${chunks.join('\n')}\n`);
  const manifest: Manifest = { dumpedAt: new Date().toISOString(), tables: ordered, skipped, counts };
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n✅ dumped ${ordered.length} table(s), ${sum(counts)} row(s) → ${sqlPath}`);
  for (const t of ordered) console.log(`   ${t.padEnd(38)} ${counts[t]}`);
  if (skipped.length) {
    console.log('\n   skipped (by design):');
    for (const s of skipped) console.log(`   ${s.table.padEnd(38)} ${s.reason}`);
  }
  console.log(`\n   KEEP THIS DIRECTORY. It is the pre-cutover copy: ${outDir}`);
}

/** Order tables parent-before-child from the source's foreign keys. */
async function topoSort(
  src: ReturnType<typeof createClient>,
  tables: string[],
): Promise<string[]> {
  const deps = new Map<string, string[]>();
  for (const t of tables) {
    const fks = await src.execute(`PRAGMA foreign_key_list("${t}")`);
    const refs = new Set(
      fks.rows
        .map((r) => String(r.table))
        .filter((r) => r !== t && tables.includes(r)), // self-refs can't be ordered away
    );
    deps.set(t, [...refs]);
  }
  const out: string[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (t: string) => {
    const s = state.get(t);
    if (s === 'done') return;
    if (s === 'visiting') {
      // A cycle among tables — SQLite tolerates it, we can't order it. Emit and warn.
      console.warn(`⚠️  foreign-key cycle involving "${t}" — falling back to source order for it`);
      return;
    }
    state.set(t, 'visiting');
    for (const d of deps.get(t) ?? []) visit(d);
    state.set(t, 'done');
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

// ---------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------

function load(target: Target, dumpDir: string, truncate: boolean) {
  const manifest = readManifest(dumpDir);
  const dest = destCounts(target, manifest.tables);
  const nonEmpty = manifest.tables.filter((t) => (dest[t] ?? 0) > 0);

  if (nonEmpty.length > 0) {
    if (!truncate) {
      console.error('\n❌ destination is not empty — refusing to load.');
      for (const t of nonEmpty) console.error(`   ${t.padEnd(38)} ${dest[t]} row(s)`);
      console.error(
        '\n   If this is a retry after a partial load, re-run with --truncate: it deletes every\n' +
          '   importable table (reverse dependency order) and loads from scratch. It never touches\n' +
          '   d1_migrations or any table outside the dump.',
      );
      process.exit(1);
    }
    console.log('→ --truncate: clearing importable tables (reverse dependency order)');
    const sql = [...manifest.tables].reverse().map((t) => `DELETE FROM "${t}";`).join('\n');
    // Not into dumpDir: the retained dump copy stays exactly as it was written.
    const f = join(mkdtempSync(join(tmpdir(), 'platform-truncate-')), 'truncate.sql');
    writeFileSync(f, `${sql}\n`);
    d1Run(target, ['--file', f, '--yes']);
  }

  console.log(`→ loading ${sum(manifest.counts)} row(s) into D1 (${target})`);
  d1Run(target, ['--file', join(dumpDir, 'data.sql'), '--yes']);
  console.log('✅ load applied — now run `verify`');
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function verify(target: Target, dumpDir: string): number {
  const manifest = readManifest(dumpDir);
  const dest = destCounts(target, manifest.tables);

  console.log(`\n${'table'.padEnd(38)} ${'turso'.padStart(7)} ${'d1'.padStart(7)}`);
  console.log('-'.repeat(56));
  let bad = 0;
  for (const t of manifest.tables) {
    const a = manifest.counts[t] ?? 0;
    const b = dest[t] ?? 0;
    const ok = a === b;
    if (!ok) bad++;
    console.log(`${t.padEnd(38)} ${String(a).padStart(7)} ${String(b).padStart(7)}  ${ok ? '✓' : '✗ MISMATCH'}`);
  }
  console.log('-'.repeat(56));
  console.log(`${'TOTAL'.padEnd(38)} ${String(sum(manifest.counts)).padStart(7)} ${String(sum(dest)).padStart(7)}`);

  // The ledger must be untouched by the import: wrangler's 26, drizzle's absent.
  const ledger = Number(d1Query(target, 'select count(*) as n from d1_migrations')[0]?.n ?? -1);
  const drizzleLedger = d1Query(
    target,
    "select count(*) as n from sqlite_master where type='table' and name='__drizzle_migrations'",
  );
  const strayLedger = Number(drizzleLedger[0]?.n ?? 0);
  console.log(`\nd1_migrations rows: ${ledger} (expected 26 — wrangler's ledger, not imported)`);
  console.log(`__drizzle_migrations present in D1: ${strayLedger > 0 ? 'YES ✗' : 'no ✓'}`);
  if (ledger !== 26) {
    console.error("✗ d1_migrations is not 26 — the schema ledger is not what the deploy applied");
    bad++;
  }
  if (strayLedger > 0) {
    console.error("✗ drizzle's ledger reached D1 — two competing ledgers");
    bad++;
  }

  if (bad > 0) {
    console.error(`\n❌ ${bad} check(s) failed — DO NOT flip PLATFORM_DB_ENABLED`);
    return 1;
  }
  console.log('\n✅ every table matches and the ledger is intact');
  return 0;
}

function destCounts(target: Target, tables: string[]): Record<string, number> {
  if (tables.length === 0) return {};
  // One statement per table rather than a UNION ALL: SQLite caps the number of terms in a
  // compound SELECT well below our table count. wrangler returns one result set per
  // statement, in order, so this is still a single round trip.
  const sql = tables.map((t) => `select count(*) as n from "${t}";`).join('\n');
  const sets = d1QueryAll(target, sql);
  if (sets.length !== tables.length) {
    throw new Error(`expected ${tables.length} count result(s), got ${sets.length}`);
  }
  const out: Record<string, number> = {};
  tables.forEach((t, i) => {
    out[t] = Number(sets[i]?.[0]?.n ?? 0);
  });
  return out;
}

// ---------------------------------------------------------------------------

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
}
const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run under \`sops exec-env …/production/secrets.yaml\``);
  return v;
}
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const USAGE = `usage:
  migrate-platform-data.ts dump   [--out <dir>] [--target local|remote]
  migrate-platform-data.ts load   --dump <dir> [--target local|remote] [--truncate]
  migrate-platform-data.ts verify --dump <dir> [--target local|remote]

--target defaults to "local". "remote" is production D1 and requires CLOUDFLARE_API_TOKEN.
dump reads Turso (TURSO_URL/TURSO_KEY) and writes OUTSIDE the repo by default:
  ~/cedarpad-platform-dumps/<timestamp>/`;

if (import.meta.main) {
  const cmd = process.argv[2];
  const target = (flag('target') ?? 'local') as Target;
  if (target !== 'local' && target !== 'remote') throw new Error(`bad --target: ${target}`);
  if (target === 'local') await initLocal();

  if (cmd === 'dump') {
    const out =
      flag('out') ??
      join(homedir(), 'cedarpad-platform-dumps', new Date().toISOString().replace(/[:.]/g, '-'));
    await dump(out, target);
  } else if (cmd === 'load') {
    const dir = flag('dump');
    if (!dir) throw new Error('load needs --dump <dir>');
    load(target, dir, process.argv.includes('--truncate'));
  } else if (cmd === 'verify') {
    const dir = flag('dump');
    if (!dir) throw new Error('verify needs --dump <dir>');
    process.exit(verify(target, dir));
  } else {
    console.log(USAGE);
    process.exit(1);
  }
}
