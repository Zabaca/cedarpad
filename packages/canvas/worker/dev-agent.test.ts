import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';
import { DEV_AGENT_RUN_PATH, kickDevAgentRun, triggerDevAgentRun } from './dev-agent.ts';
import type { Env } from './index.ts';

// ADR-0011: a dev-agent run is a chat turn kicked headlessly — the edge's whole job is
// "mint the per-turn token, proxy the kick to the warm bridge." No exec, no batch env.
describe('kickDevAgentRun — mint + proxy the kick to the warm bridge', () => {
  const env = { CANVAS_USER: 'u' } as Env;

  const CONN = { installationId: '145473731', repoFullName: 'Zabaca/cedarpad' };
  // Every kick carries a job now (#100): there is no built-in task to fall back to.
  const JOB_ARG = { name: 'deps-audit', prompt: 'Audit the dependencies.' };

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

    const res = await kickDevAgentRun(
      env,
      {
        mint: async (_e, opts) => {
          minted.push({ installationId: opts.installationId, repoFullName: opts.repoFullName });
          return 'ghs_run';
        },
        serve,
        resolveRepo: async () => CONN,
      },
      undefined,
      JOB_ARG,
    );

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

    const res = await kickDevAgentRun(env, { mint: async () => null, serve, resolveRepo: async () => CONN }, undefined, JOB_ARG);

    expect(res.status).toBe(202);
    expect(calls[0]!.token).toBeNull();
    expect(calls[0]!.repo).toBe('Zabaca/cedarpad');
  });

  test('no connection resolved ⇒ token-less, repo-less kick (the run explores the default cwd)', async () => {
    const { calls, serve } = record();

    const res = await kickDevAgentRun(
      env,
      {
        mint: async () => {
          throw new Error('mint must not be called with no repo');
        },
        serve,
        resolveRepo: async () => null,
      },
      undefined,
      JOB_ARG,
    );

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
      JOB_ARG,
    );

    expect(res.status).toBe(400);
    expect(calls).toEqual([]); // nothing proxied
  });
});

// The one manual-trigger core behind BOTH the /api/jobs/dev-agent/run route and the MCP
// run_dev_agent tool: validate the optional repo/job request, then kick.
describe('triggerDevAgentRun — validate the repo/job request, then kick', () => {
  const env = { CANVAS_USER: 'u' } as Env;
  const CONN = { installationId: '145473731', repoFullName: 'Zabaca/cedarpad' };
  const JOB = { name: 'deps-audit', repo: 'Zabaca/cedarpad', prompt: 'Audit the dependencies.' };

  const record = () => {
    const kicks: Array<{ repo: string | null; body: unknown }> = [];
    const serve = async (req: Request, _env: Env, _coords: SandboxCoords) => {
      kicks.push({ repo: req.headers.get('x-dev-agent-repo'), body: await req.json().catch(() => null) });
      return Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 });
    };
    return { kicks, serve };
  };

  // #100: one mechanism. A jobless kick used to silently run a built-in prompt against an
  // arbitrary repo; it is now a 400 that names where jobs come from.
  test('a jobless trigger is a 400 naming .claude/jobs/ — nothing kicked', async () => {
    const { kicks, serve } = record();
    const deps = { mint: async () => 'ghs_run', serve, resolveRepo: async () => CONN, discover: async () => [JOB] };

    for (const body of [null, {}, { repo: 'Zabaca/cedarpad' }, { job: '  ' }] as Array<{ repo?: string; job?: string } | null>) {
      const res = await triggerDevAgentRun(env, deps, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('.claude/jobs/');
    }
    expect(kicks).toEqual([]);
  });

  test('a named job is re-read off the selected repos (never caller-supplied prompt) and forwarded', async () => {
    const { kicks, serve } = record();
    const res = await triggerDevAgentRun(
      env,
      { mint: async () => 'ghs_run', serve, resolveRepo: async (_e, r) => (r === JOB.repo ? CONN : null), discover: async () => [JOB] },
      { job: 'deps-audit' },
    );
    expect(res.status).toBe(202);
    expect(kicks).toEqual([{ repo: 'Zabaca/cedarpad', body: { job: { name: 'deps-audit', prompt: 'Audit the dependencies.' } } }]);
  });

  test('a MANUAL trigger forwards its human initiator as x-inbox-assign; absent (cron) sends none', async () => {
    const assigns: Array<string | null> = [];
    const serve = async (req: Request, _env: Env, _coords: SandboxCoords) => {
      assigns.push(req.headers.get('x-inbox-assign'));
      return Response.json({ chatId: 'dev-agent-run-x', joined: false }, { status: 202 });
    };
    const deps = { mint: async () => 'ghs_run', serve, resolveRepo: async () => CONN, discover: async () => [JOB] };

    await triggerDevAgentRun(env, deps, { job: 'deps-audit' }, 'user_james');
    await triggerDevAgentRun(env, deps, { job: 'deps-audit' });
    expect(assigns).toEqual(['user_james', null]);
  });

  test('an unknown job (or a repo mismatch) is a 404 — nothing kicked', async () => {
    const { kicks, serve } = record();
    const deps = { mint: async () => 'ghs_run', serve, resolveRepo: async () => CONN, discover: async () => [JOB] };
    expect((await triggerDevAgentRun(env, deps, { job: 'nope' })).status).toBe(404);
    expect((await triggerDevAgentRun(env, deps, { job: 'deps-audit', repo: 'Other/repo' })).status).toBe(404);
    expect(kicks).toEqual([]);
  });

  // #240: a `target: warehouse` job is a materialize run, dispatched by the scheduler's
  // own kick branch (worker/index.ts) — not this dev-agent manual trigger. Reject rather
  // than silently running it as a chat turn against a repo.
  test('a target: warehouse job cannot be manually triggered as a dev-agent run', async () => {
    const { kicks, serve } = record();
    const WAREHOUSE_JOB = { ...JOB, name: 'materialize-mart', target: 'warehouse' as const };
    const deps = { mint: async () => 'ghs_run', serve, resolveRepo: async () => CONN, discover: async () => [WAREHOUSE_JOB] };
    const res = await triggerDevAgentRun(env, deps, { job: 'materialize-mart' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('warehouse');
    expect(kicks).toEqual([]);
  });
});
