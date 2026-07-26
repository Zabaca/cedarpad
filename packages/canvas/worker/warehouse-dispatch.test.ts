import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve, DEFAULT_WORKSPACE } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { kickWarehouseMaterialize } from './warehouse-dispatch.ts';
import type { Env } from './index.ts';

// ADR-0017 / #240: a materialize run is BATCH, not an agent turn. Unlike
// kickDevAgentRun, there is no mint, no headers, no bridge proxy, no prompt — just one
// exec against the Warehouse container. This proves the dispatch wakes the WAREHOUSE
// container (the coords/exec call), never the canvas container/bridge.
describe('kickWarehouseMaterialize — wakes the Warehouse container, not the bridge', () => {
  const env = {} as Env;

  const record = (success = true) => {
    const calls: Array<{ coords: SandboxCoords }> = [];
    const exec = async (_env: Env, coords: SandboxCoords) => {
      calls.push({ coords });
      return { success, stdout: success ? 'materialize: wrote mart_session_events (12 rows).' : '', stderr: success ? '' : 'boom' };
    };
    return { calls, exec };
  };

  test('execs against the default workspace\'s Warehouse container coordinates — no prompt, no mint, no headers', async () => {
    const { calls, exec } = record();
    const res = await kickWarehouseMaterialize(env, { exec });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ joined: false });
    expect(calls).toEqual([{ coords: resolve(DEFAULT_WORKSPACE) }]);
    expect(calls[0]?.coords.sandboxId).toBe(LEGACY_SANDBOX_ID); // same container id the canvas Sandbox resolves to
  });

  test('a failed exec surfaces as a non-202 — evaluateScheduledJobs treats it as a failed kick, not a joined run', async () => {
    const { exec } = record(false);
    const res = await kickWarehouseMaterialize(env, { exec });
    expect(res.status).toBe(502);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'materialize failed' });
  });
});
