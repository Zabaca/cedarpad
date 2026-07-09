import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';
import { containerEnv } from './container-env.ts';
import { projectDirForCwd } from '../server/transcript-r2.ts';
import {
  DEV_AGENT_SANDBOX_ID,
  DEV_AGENT_SLEEP_AFTER,
  DEV_AGENT_WORKFLOW_CMD,
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

// #133: dev-agent session resume is correct only if the batch explore session and the
// interactive bridge run under the SAME cwd — the Agent SDK encodes cwd into the on-disk
// project-dir name (projectDirForCwd), so any drift orphans the JSONL by name ("No
// conversation found on resume"). The two cwds come from two independently-defined
// production sources; this pins that they can't drift apart:
//   • explore-session cwd — DEV_AGENT_WORKFLOW_CMD's `cd` target (dev-agent-run.ts uses
//     process.cwd() after that cd, DEV_AGENT_REPO_ROOT unset in prod).
//   • bridge resume cwd — the CANVAS_CWD injected into the container env (bridge.ts reads
//     process.env.CANVAS_CWD for `query({ resume, cwd })`).
describe('#133 — explore cwd and bridge cwd resolve to the same SDK project dir', () => {
  const coords: SandboxCoords = { sandboxId: 'dev-agent', r2Prefix: 'workspaces/dev-agent/', canvasWorkspace: 'dev-agent' };

  test('DEV_AGENT_WORKFLOW_CMD cd == injected CANVAS_CWD == same projectDirForCwd', () => {
    const exploreCwd = /^cd (\S+) &&/.exec(DEV_AGENT_WORKFLOW_CMD)?.[1];
    const bridgeCwd = containerEnv({} as Env, coords).CANVAS_CWD;

    expect(exploreCwd).toBeTruthy();
    expect(bridgeCwd).toBeTruthy();
    // The invariant the SDK actually cares about: identical on-disk project dir.
    expect(projectDirForCwd(exploreCwd!)).toBe(projectDirForCwd(bridgeCwd));
  });
});

describe('runDevAgent — #66 workflow kick', () => {
  test('execs the container workflow entrypoint', async () => {
    const calls: string[] = [];
    const sandbox: DevAgentRunner = {
      exec: async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: 'ok\n' };
      },
    };
    await runDevAgent(sandbox);
    expect(calls).toEqual([DEV_AGENT_WORKFLOW_CMD]);
  });

  test('a non-zero workflow exit is surfaced (thrown)', async () => {
    const sandbox: DevAgentRunner = {
      exec: async () => ({ exitCode: 1, stdout: 'boom' }),
    };
    await expect(runDevAgent(sandbox)).rejects.toThrow('dev-agent workflow exited 1');
  });
});

describe('dispatchDevAgentRun — the scheduled dispatch', () => {
  const event = { cron: '0 9 * * *', scheduledTime: Date.UTC(2026, 6, 7, 9, 0, 0) };
  const env = { DEV_AGENT_ENABLED: 'true' } as Env;

  test('skips entirely when DEV_AGENT_ENABLED is not "true" (kill-switch)', async () => {
    let touched = false;
    const seam: DevAgentSeam = {
      sandbox: () => {
        touched = true;
        return { exec: async () => ({ exitCode: 0, stdout: '' }) };
      },
      run: async () => {
        touched = true;
      },
    };
    await dispatchDevAgentRun(event, {} as Env, seam); // flag unset ⇒ disabled
    expect(touched).toBe(false);
  });

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
