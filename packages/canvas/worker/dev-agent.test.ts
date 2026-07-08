import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import { sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  DEV_AGENT_SANDBOX_ID,
  DEV_AGENT_SLEEP_AFTER,
  type DevAgentRunner,
  type DevAgentSeam,
  dispatchDevAgentRun,
  runDevAgent,
} from './dev-agent.ts';
import type { Env } from './index.ts';

describe('dev-agent sandbox id is distinct from every workspace container', () => {
  test('differs from the legacy/default product container', () => {
    expect(DEV_AGENT_SANDBOX_ID).not.toBe(LEGACY_SANDBOX_ID);
    expect(DEV_AGENT_SANDBOX_ID).not.toBe(resolve({ id: 'default', legacy: true }).sandboxId);
  });

  test('differs from any derived per-workspace container', () => {
    for (const wsId of ['default', 'ws_abc123', 'dev-agent', 'canvas']) {
      // Derived ids are always `workspace-<id>`, so the flat `dev-agent` key can never
      // collide even if a workspace were literally named "dev-agent".
      expect(DEV_AGENT_SANDBOX_ID).not.toBe(deriveSandboxId(wsId));
      expect(DEV_AGENT_SANDBOX_ID).not.toBe(resolve({ id: wsId }).sandboxId);
    }
  });

  test('has its OWN sleep schedule, shorter than the product 5m', () => {
    expect(DEV_AGENT_SLEEP_AFTER).toBe('2m');
  });
});

describe('runDevAgent — #63 liveness stub', () => {
  test('kicks a single liveness step on the sandbox', async () => {
    const calls: string[] = [];
    const sandbox: DevAgentRunner = {
      exec: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: 'dev-agent-alive\n' };
      },
    };
    await runDevAgent(sandbox);
    expect(calls).toEqual(['echo dev-agent-alive']);
  });
});

describe('dispatchDevAgentRun — the scheduled dispatch', () => {
  const event = { cron: '0 9 * * *', scheduledTime: Date.UTC(2026, 6, 7, 9, 0, 0) };
  const env = {} as Env;

  test('resolves the dev-agent sandbox and kicks the run through the seam', async () => {
    const order: string[] = [];
    const fakeSandbox: DevAgentRunner = { exec: async () => ({ exitCode: 0, stdout: '' }) };
    const seam: DevAgentSeam = {
      sandbox: (e) => {
        expect(e).toBe(env);
        order.push('sandbox');
        return fakeSandbox;
      },
      run: async (s) => {
        expect(s).toBe(fakeSandbox);
        order.push('run');
      },
    };
    await dispatchDevAgentRun(event, env, seam);
    expect(order).toEqual(['sandbox', 'run']);
  });

  test('a run that errors surfaces (rethrows) — not silently swallowed', async () => {
    const seam: DevAgentSeam = {
      sandbox: () => ({ exec: async () => ({ exitCode: 0, stdout: '' }) }),
      run: async () => {
        throw new Error('workflow blew up');
      },
    };
    await expect(dispatchDevAgentRun(event, env, seam)).rejects.toThrow('workflow blew up');
  });
});
