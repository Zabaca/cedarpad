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

  const CONN = { installationId: '145473731', repoFullName: 'Zabaca/cedarpad' };

  const record = () => {
    const calls: Array<{ path: string; method: string; token: string | null; repo: string | null; coords: SandboxCoords }> = [];
    const serve = async (req: Request, _env: Env, coords: SandboxCoords) => {
      calls.push({
        path: new URL(req.url).pathname,
        method: req.method,
        token: req.headers.get('x-dev-agent-git-token'),
        repo: req.headers.get('x-dev-agent-repo'),
        coords,
      });
      return Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 });
    };
    return { calls, serve };
  };

  test('resolves the workspace repo, mints for it, and proxies the kick with token + repo headers', async () => {
    const { calls, serve } = record();
    const minted: Array<{ installationId: string; repoFullName: string }> = [];

    const res = await kickDevAgentRun(env, {
      mint: async (_e, opts) => {
        minted.push({ installationId: opts.installationId, repoFullName: opts.repoFullName });
        return 'ghs_run';
      },
      serve,
      resolveRepo: async () => CONN,
    });

    expect(res.status).toBe(202);
    // The mint is scoped to the RESOLVED (installation, repo) — never a hardcoded repo (ADR-0015).
    expect(minted).toEqual([CONN]);
    expect(calls).toEqual([
      {
        path: DEV_AGENT_RUN_PATH,
        method: 'POST',
        token: 'ghs_run',
        repo: 'Zabaca/cedarpad',
        coords: resolve({ id: 'default', legacy: true }), // the warm default container — no separate instance
      },
    ]);
  });

  test('a failed mint (null) kicks token-less but still repo-tagged — best-effort (no open_pr)', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(env, { mint: async () => null, serve, resolveRepo: async () => CONN });

    expect(res.status).toBe(202);
    expect(calls[0]!.token).toBeNull();
    expect(calls[0]!.repo).toBe('Zabaca/cedarpad');
  });

  test('no connection resolved ⇒ token-less, repo-less kick (the run explores the default cwd)', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(env, {
      mint: async () => {
        throw new Error('mint must not be called with no repo');
      },
      serve,
      resolveRepo: async () => null,
    });

    expect(res.status).toBe(202);
    expect(calls[0]!.token).toBeNull();
    expect(calls[0]!.repo).toBeNull();
  });

  test('a job kick forwards the job (name + prompt) as the request body to the bridge (#195)', async () => {
    const bodies: unknown[] = [];
    const serve = async (req: Request, _env: Env, _coords: SandboxCoords) => {
      bodies.push(await req.json().catch(() => null));
      return Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 });
    };

    const res = await kickDevAgentRun(
      env,
      { mint: async () => 'ghs_run', serve, resolveRepo: async () => CONN },
      'Zabaca/cedarpad',
      { name: 'deps-audit', prompt: 'Audit the dependencies.' },
    );

    expect(res.status).toBe(202);
    expect(bodies).toEqual([{ job: { name: 'deps-audit', prompt: 'Audit the dependencies.' } }]);
  });

  test('an explicitly requested repo outside the selected set is a 400 — never silently re-targeted', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(
      env,
      { mint: async () => 'ghs_run', serve, resolveRepo: async (_e, requested) => (requested === 'Zabaca/cedarpad' ? CONN : null) },
      'Evil/other',
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]); // nothing proxied
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
