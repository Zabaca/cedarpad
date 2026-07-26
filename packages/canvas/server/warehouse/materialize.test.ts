import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { memBackend } from '../blob-store.ts';
import { hasDuckdbCli } from './session-events-mart.ts';
import { materializeWorkspace } from './materialize.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/sessions');

async function tarFixture(): Promise<Uint8Array> {
  const proc = Bun.spawn(['tar', '-cf', '-', '-C', FIXTURE_DIR, '.'], { stdout: 'pipe', stderr: 'pipe' });
  const bytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) throw new Error(`tar failed: ${await new Response(proc.stderr).text()}`);
  return bytes;
}

const maybeDescribe = hasDuckdbCli() ? describe : describe.skip;

maybeDescribe('materializeWorkspace — orchestration: sessions.tar in, mart + sidecar out', () => {
  test('returns null when the workspace has no sessions.tar', async () => {
    const backend = memBackend();
    expect(await materializeWorkspace(backend, 'ws-empty')).toBeNull();
  });

  test('writes the mart parquet and its sidecar under workspaces/<ws>/warehouse/', async () => {
    const backend = memBackend();
    await backend.put('workspaces/ws-1/sessions.tar', await tarFixture());

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
