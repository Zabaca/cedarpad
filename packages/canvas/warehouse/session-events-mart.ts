// The first mart (ADR-0017, #237): read the stored session Transcripts (already in R2 for
// `resume`, no connector needed — CONTEXT.md "Data — the workspace warehouse"), parse the
// Claude Code session JSONL, and transform it via DuckDB SQL into ONE declared mart —
// mart_session_events, one row per main-agent assistant turn. Runs in the warehouse container
// (Dockerfile.warehouse), which bakes this file and the `duckdb` CLI it shells out to. Prefer
// SQL over Python (CLAUDE.md §2 + issue guidance): the transform below is one DuckDB COPY
// statement; this module is thin TS orchestration around it.
//
// #356: the source is a DIRECTORY of session JSONL, one file per session, written out by
// `materialize.ts` from the per-session Transcript objects. It used to be a sessions.tar
// extracted here.
//
// SCOPE LIMIT (state it in the mart, not just here): transcripts exist only for turns that ran
// IN THE CONTAINER (canvas chats + dev-agent runs) — local terminal sessions never reach R2,
// so any cost/usage figure derived from this mart is container-side only.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { MartColumn, MartSidecar } from '../shared/mart-contract.ts';

export const MART_NAME = 'mart_session_events';

export const MART_COLUMNS: MartColumn[] = [
  { name: 'session_id', type: 'VARCHAR', description: 'Claude Code session id (JSONL sessionId).' },
  { name: 'ts', type: 'TIMESTAMP', description: 'Timestamp of the assistant turn.' },
  { name: 'model', type: 'VARCHAR', description: 'Model that produced the turn.' },
  { name: 'cwd', type: 'VARCHAR', description: 'Container working directory the turn ran in.' },
  { name: 'input_tokens', type: 'BIGINT', description: 'Non-cached input tokens billed for the turn.' },
  { name: 'output_tokens', type: 'BIGINT', description: 'Output tokens billed for the turn.' },
  { name: 'cache_read_input_tokens', type: 'BIGINT', description: 'Input tokens served from prompt cache.' },
  { name: 'cache_creation_input_tokens', type: 'BIGINT', description: 'Input tokens spent writing the prompt cache.' },
];

export const MART_DESCRIPTION =
  'One row per main-agent assistant turn from the stored Claude Code session transcripts ' +
  '(sessions/<session_id>/transcript.jsonl). Subagent (sidechain) turns are excluded. COVERS ' +
  'ONLY TURNS THAT RAN IN THE CONTAINER — canvas chats and dev-agent runs. Local terminal ' +
  'sessions are never stored, so any cost/usage figure derived from this mart is container-side ' +
  'only, not the user’s total Claude Code usage. Transcript objects are keyed by session id ' +
  'alone, so this mart spans every session in the deployment, not only the named workspace’s.';

const run = async (cmd: string[], stdin?: Uint8Array): Promise<string> => {
  const proc = Bun.spawn(cmd, { stdin: stdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (stdin && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${stderr}`);
  return stdout;
};

/** The DuckDB SQL that IS the transform (CLAUDE.md §2: prefer SQL over Python). An explicit,
 * narrow `columns=` schema on `read_json` sidesteps the on-disk JSONL's heterogeneous record
 * types (mode/permission-mode/file-history-snapshot/user/assistant all share one file) —
 * unlisted fields per record simply read as NULL instead of blowing up auto-detection, and
 * `message` stays DuckDB's JSON type until we project the fields this mart needs. */
const transformSql = (jsonlGlob: string, parquetPath: string): string => `
COPY (
  SELECT
    sessionId AS session_id,
    CAST(timestamp AS TIMESTAMP) AS ts,
    message ->> 'model' AS model,
    cwd,
    CAST(message -> 'usage' ->> 'input_tokens' AS BIGINT) AS input_tokens,
    CAST(message -> 'usage' ->> 'output_tokens' AS BIGINT) AS output_tokens,
    CAST(message -> 'usage' ->> 'cache_read_input_tokens' AS BIGINT) AS cache_read_input_tokens,
    CAST(message -> 'usage' ->> 'cache_creation_input_tokens' AS BIGINT) AS cache_creation_input_tokens
  FROM read_json(
    '${jsonlGlob}',
    format = 'newline_delimited',
    columns = {
      type: 'VARCHAR',
      isSidechain: 'BOOLEAN',
      sessionId: 'VARCHAR',
      timestamp: 'VARCHAR',
      cwd: 'VARCHAR',
      message: 'JSON'
    },
    ignore_errors = true
  )
  WHERE type = 'assistant' AND coalesce(isSidechain, false) = false
  ORDER BY ts
) TO '${parquetPath}' (FORMAT PARQUET);
`;

/** True if the `duckdb` CLI is on PATH — present in the warehouse container image
 * (Dockerfile.warehouse), not guaranteed on every dev/CI machine running `bun test`. */
export function hasDuckdbCli(): boolean {
  return Bun.which('duckdb') !== null;
}

/**
 * Materialize mart_session_events from a directory of session JSONL files. `sessionsDir` is
 * read-only here and belongs to the caller (since #356 it is the Transcript objects written out
 * by `materializeWorkspace`); `workDir` must be a caller-owned, unique directory (e.g. `mkdtemp`)
 * — worktree-safe per CLAUDE.md §6: no fixed /tmp path, so a parallel copy of this pipeline
 * (another worktree, another workspace) never collides. Idempotent: parquet files are immutable
 * (ADR-0017), so rerunning re-derives the same rows into fresh bytes at the caller's chosen path.
 */
export async function materializeSessionEventsMart(
  sessionsDir: string,
  workDir: string,
): Promise<{ parquet: Uint8Array; sidecar: MartSidecar }> {
  if (!hasDuckdbCli()) {
    throw new Error(
      'materializeSessionEventsMart: `duckdb` CLI not found on PATH. It ships in the warehouse ' +
        'container image (Dockerfile.warehouse); install it locally (e.g. `brew install duckdb`) to run this.',
    );
  }
  const parquetPath = join(workDir, `${MART_NAME}.parquet`);
  await mkdir(workDir, { recursive: true });

  const jsonlGlob = join(sessionsDir, '**', '*.jsonl');
  await run(['duckdb', ':memory:', '-c', transformSql(jsonlGlob, parquetPath)]);

  const parquet = await Bun.file(parquetPath).bytes();
  const countJson = await run(['duckdb', ':memory:', '-json', '-c', `SELECT count(*) AS n FROM read_parquet('${parquetPath}')`]);
  const rowCount = Number(JSON.parse(countJson)[0].n);

  const sidecar: MartSidecar = {
    name: MART_NAME,
    description: MART_DESCRIPTION,
    columns: MART_COLUMNS,
    generatedAt: new Date().toISOString(),
    rowCount,
  };
  return { parquet, sidecar };
}

/** Read a materialized mart's rows back (test/verification helper — not the edge reader,
 * which is #238's pure-JS parquet path). Every column comes back JSON-safe: DuckDB CLI's
 * `-json` mode renders BIGINT as a JSON number, never a JS `bigint` (that failure mode is
 * specific to a native/WASM parquet decoder, exercised directly in mart-contract.test.ts). */
export async function readMartParquet(parquetPath: string): Promise<Record<string, unknown>[]> {
  const json = await run(['duckdb', ':memory:', '-json', '-c', `SELECT * FROM read_parquet('${parquetPath}') ORDER BY ts, session_id`]);
  return JSON.parse(json);
}
