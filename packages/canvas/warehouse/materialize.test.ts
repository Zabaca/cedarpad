import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { type BlobBackend, memBackend } from '../server/blob-store.ts';
import { transcriptKey } from '../server/transcript-store.ts';
import { hasDuckdbCli } from './session-events-mart.ts';
import { materializeWorkspace } from './materialize.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/sessions');

/** Seed the fixture sessions as the per-session Transcript objects the container now writes —
 * one object per session, which is the layout the warehouse reads since #356. */
async function seedTranscripts(backend: BlobBackend): Promise<void> {
  for await (const rel of new Bun.Glob('**/*.jsonl').scan({ cwd: FIXTURE_DIR })) {
    const sessionId = rel.split('/').pop()!.replace('.jsonl', '');
    await backend.put(transcriptKey(sessionId), await Bun.file(join(FIXTURE_DIR, rel)).bytes());
  }
}

// A skip must be impossible to mistake for a pass (no CI runs `bun test` — a dev's local
// machine is the sole enforcement here): warn loudly, naming exactly what didn't run.
const duckdbAvailable = hasDuckdbCli();
if (!duckdbAvailable) {
  console.warn(
    'DuckDB CLI not found — 2 warehouse tests in materialize.test.ts SKIPPED, not passed; ' +
      'install duckdb (e.g. `brew install duckdb`) to run them.',
  );
}
const maybeDescribe = duckdbAvailable ? describe : describe.skip;

maybeDescribe('materializeWorkspace — orchestration: per-session Transcripts in, mart + sidecar out', () => {
  test('returns null when no session has a stored transcript', async () => {
    const backend = memBackend();
    expect(await materializeWorkspace(backend, 'ws-empty')).toBeNull();
  });

  test('writes the mart parquet and its sidecar under workspaces/<ws>/warehouse/', async () => {
    const backend = memBackend();
    await seedTranscripts(backend);

    const result = await materializeWorkspace(backend, 'ws-1');
    expect(result).toEqual({ rowCount: 3 });

    const parquet = await backend.get('workspaces/ws-1/warehouse/mart_session_events.parquet');
    const sidecarBytes = await backend.get('workspaces/ws-1/warehouse/mart_session_events.schema.json');
    expect(parquet).not.toBeNull();
    expect(parquet!.byteLength).toBeGreaterThan(0);
    expect(sidecarBytes).not.toBeNull();

    const sidecar = JSON.parse(new TextDecoder().decode(sidecarBytes!));
    expect(sidecar.name).toBe('mart_session_events');
    expect(sidecar.rowCount).toBe(3);
    expect(sidecar.columns.length).toBeGreaterThan(0);
  });
});
