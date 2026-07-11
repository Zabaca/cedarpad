import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';
import { DEV_AGENT_RUN_PATH, dispatchDevAgentRun, kickDevAgentRun } from './dev-agent.ts';
import type { Env } from './index.ts';

// ADR-0011: a dev-agent run is a chat turn kicked headlessly — the edge's whole job is
// "mint the per-turn token, proxy the kick to the warm bridge." No exec, no batch env.
describe('kickDevAgentRun — mint + proxy the kick to the warm bridge', () => {
  const env = { CANVAS_USER: 'u' } as Env;

  const record = () => {
    const calls: Array<{ path: string; method: string; token: string | null; coords: SandboxCoords }> = [];
    const serve = async (req: Request, _env: Env, coords: SandboxCoords) => {
      calls.push({
        path: new URL(req.url).pathname,
        method: req.method,
        token: req.headers.get('x-dev-agent-git-token'),
        coords,
      });
      return Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 });
    };
    return { calls, serve };
  };

  test('mints and proxies POST /api/dev-agent/run to the warm default container with the token header', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(env, { mint: async () => 'ghs_run', serve });

    expect(res.status).toBe(202);
    expect(calls).toEqual([
      {
        path: DEV_AGENT_RUN_PATH,
        method: 'POST',
        token: 'ghs_run',
        coords: resolve({ id: 'default', legacy: true }), // the warm default container — no separate instance
      },
    ]);
  });

  test('a failed mint (null) kicks token-less — the run still happens, best-effort (no open_pr)', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(env, { mint: async () => null, serve });

    expect(res.status).toBe(202);
    expect(calls[0]!.token).toBeNull();
  });
});

describe('dispatchDevAgentRun — the scheduled dispatch (cron gate)', () => {
  const event = { cron: '0 9 * * *', scheduledTime: Date.UTC(2026, 6, 7, 9, 0, 0) };

  test('skips entirely when DEV_AGENT_ENABLED is not "true" (cron kill-switch)', async () => {
    let kicked = 0;
    await dispatchDevAgentRun(event, { CANVAS_USER: 'u' } as Env, async () => {
      kicked += 1;
      return new Response(null, { status: 202 });
    });
    expect(kicked).toBe(0);
  });

  test('when enabled, kicks the run and surfaces a non-2xx kick as an error', async () => {
    const env = { DEV_AGENT_ENABLED: 'true', CANVAS_USER: 'u' } as Env;
    let kicked = 0;
    await dispatchDevAgentRun(event, env, async () => {
      kicked += 1;
      return new Response(null, { status: 202 });
    });
    expect(kicked).toBe(1);

    await expect(
      dispatchDevAgentRun(event, env, async () => new Response('boom', { status: 500 })),
    ).rejects.toThrow('500');
  });
});
