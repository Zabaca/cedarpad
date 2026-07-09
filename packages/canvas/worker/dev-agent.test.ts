import { describe, expect, test } from 'bun:test';

import { LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import type { SandboxCoords } from './sandbox-resolver.ts';
import { sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';
import { containerEnv } from './container-env.ts';
import { projectDirForCwd } from '../server/transcript-r2.ts';
import {
  DEV_AGENT_SANDBOX_ID,
  DEV_AGENT_WORKFLOW_CMD,
  type DevAgentRunner,
  type DevAgentSeam,
  devAgentBatchEnv,
  dispatchDevAgentRun,
  runDevAgent,
  runDevAgentNow,
} from './dev-agent.ts';
import type { Env } from './index.ts';

// ADR-0010: 'dev-agent' is a LOGICAL Conversation tag now, not a container key — but its
// disjointness from every product workspace id is still load-bearing (the edge mint gate and
// the routing predicate both compare against it), so pin that it can never collide.
describe('the dev-agent tag is distinct from every product workspace id', () => {
  test('differs from the legacy/default product container', () => {
    expect(DEV_AGENT_SANDBOX_ID).not.toBe(LEGACY_SANDBOX_ID);
    expect(DEV_AGENT_SANDBOX_ID).not.toBe(resolve({ id: 'default', legacy: true }).sandboxId);
  });

  test('differs from any derived per-workspace container', () => {
    for (const wsId of ['default', 'ws_abc123', 'dev-agent', 'canvas']) {
      // Derived ids are always `workspace-<id>`, so the flat `dev-agent` tag can never
      // collide even if a workspace were literally named "dev-agent".
      expect(DEV_AGENT_SANDBOX_ID).not.toBe(deriveSandboxId(wsId));
      expect(DEV_AGENT_SANDBOX_ID).not.toBe(resolve({ id: wsId }).sandboxId);
    }
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
  // The warm default container's coords — where BOTH the batch explore and the interactive
  // resume run now (ADR-0010).
  const coords: SandboxCoords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' };

  test('DEV_AGENT_WORKFLOW_CMD cd == injected CANVAS_CWD == same projectDirForCwd', () => {
    const exploreCwd = /^cd (\S+) &&/.exec(DEV_AGENT_WORKFLOW_CMD)?.[1];
    const bridgeCwd = containerEnv({} as Env, coords).CANVAS_CWD;

    expect(exploreCwd).toBeTruthy();
    expect(bridgeCwd).toBeTruthy();
    // The invariant the SDK actually cares about: identical on-disk project dir.
    expect(projectDirForCwd(exploreCwd!)).toBe(projectDirForCwd(bridgeCwd));
  });
});

describe('devAgentBatchEnv — the env the batch exec needs', () => {
  test('injects DEV_AGENT_USER_ID (=CANVAS_USER) + OAuth/Turso so dev-agent-run.ts does not throw', () => {
    const ev = devAgentBatchEnv({ CANVAS_USER: 'user_owner', CLAUDE_CODE_OAUTH_TOKEN: 'tok', TURSO_URL: 'u', TURSO_KEY: 'k' } as Env);
    expect(ev.DEV_AGENT_USER_ID).toBe('user_owner'); // the owner the promoted Conversation is filed under
    expect(ev.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok'); // the SDK query needs it
    // ADR-0010: the batch runs ON the warm default container now, so its env matches that
    // container's coords — NOT a separate 'dev-agent' workspace (the Conversation keeps the
    // 'dev-agent' tag via DEV_AGENT_USER_ID/the workflow, not via container coords).
    expect(ev.CANVAS_WORKSPACE).toBe('default');
    expect(ev.TURSO_URL).toBe('u'); // promotions reach the real remote Turso, not an ephemeral file
  });
});

describe('runDevAgentNow — single-flight: concurrent triggers collapse to ONE run (ADR-0010)', () => {
  const env = { CANVAS_USER: 'u' } as Env;

  test('two concurrent triggers share one in-flight run; a later trigger runs fresh', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seam: DevAgentSeam = {
      sandbox: okRunner,
      run: async () => {
        runs += 1;
        await gate;
      },
    };

    const p1 = runDevAgentNow(env, seam);
    const p2 = runDevAgentNow(env, seam); // cron + "Run now" clicks while one is in flight
    expect(runs).toBe(1); // collapsed — no pile-up of concurrent batch execs
    release();
    await Promise.all([p1, p2]);

    await runDevAgentNow(env, seam); // after settle, the NEXT trigger starts a fresh run
    expect(runs).toBe(2);
  });

  test('a failed run clears the flight — the next trigger is not stuck on a rejected promise', async () => {
    let calls = 0;
    const seam: DevAgentSeam = {
      sandbox: okRunner,
      run: async () => {
        calls += 1;
        throw new Error('boom');
      },
    };
    await expect(runDevAgentNow(env, seam)).rejects.toThrow('boom');
    await expect(runDevAgentNow(env, seam)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('runDevAgent — #66 workflow kick', () => {
  const env = { CANVAS_USER: 'user_owner', CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as Env;

  test('injects the batch env BEFORE it execs the workflow entrypoint', async () => {
    const order: string[] = [];
    let injected: Record<string, string> | null = null;
    const sandbox: DevAgentRunner = {
      setEnvVars: async (e) => {
        injected = e;
        order.push('setEnvVars');
      },
      exec: async (command) => {
        order.push(`exec:${command}`);
        return { exitCode: 0, stdout: 'ok\n' };
      },
    };
    await runDevAgent(sandbox, env);
    expect(order).toEqual(['setEnvVars', `exec:${DEV_AGENT_WORKFLOW_CMD}`]); // env in place first
    expect(injected!.DEV_AGENT_USER_ID).toBe('user_owner');
  });

  test('a non-zero workflow exit is surfaced (thrown)', async () => {
    const sandbox: DevAgentRunner = {
      setEnvVars: async () => {},
      exec: async () => ({ exitCode: 1, stdout: 'boom' }),
    };
    await expect(runDevAgent(sandbox, env)).rejects.toThrow('dev-agent workflow exited 1');
  });
});

const okRunner = (): DevAgentRunner => ({ setEnvVars: async () => {}, exec: async () => ({ exitCode: 0, stdout: '' }) });

describe('runDevAgentNow — the shared core (manual trigger + cron), NO enable-gate', () => {
  const env = { CANVAS_USER: 'u' } as Env;

  test('runs regardless of DEV_AGENT_ENABLED — a manual trigger is an explicit action', async () => {
    const order: string[] = [];
    const seam: DevAgentSeam = {
      sandbox: (e) => {
        expect(e).toBe(env);
        order.push('sandbox');
        return okRunner();
      },
      run: async (_s, e) => {
        expect(e).toBe(env);
        order.push('run');
      },
    };
    await runDevAgentNow(env, seam); // no flag set at all
    expect(order).toEqual(['sandbox', 'run']);
  });

  test('a run that errors surfaces (rethrows) — not silently swallowed', async () => {
    const seam: DevAgentSeam = { sandbox: okRunner, run: async () => { throw new Error('workflow blew up'); } };
    await expect(runDevAgentNow(env, seam)).rejects.toThrow('workflow blew up');
  });
});

describe('dispatchDevAgentRun — the scheduled dispatch (cron gate)', () => {
  const event = { cron: '0 9 * * *', scheduledTime: Date.UTC(2026, 6, 7, 9, 0, 0) };
  const env = { DEV_AGENT_ENABLED: 'true', CANVAS_USER: 'u' } as Env;

  test('skips entirely when DEV_AGENT_ENABLED is not "true" (cron kill-switch)', async () => {
    let touched = false;
    const seam: DevAgentSeam = {
      sandbox: () => {
        touched = true;
        return okRunner();
      },
      run: async () => {
        touched = true;
      },
    };
    await dispatchDevAgentRun(event, { CANVAS_USER: 'u' } as Env, seam); // flag unset ⇒ cron disabled
    expect(touched).toBe(false);
  });

  test('when enabled, runs through the shared core', async () => {
    const order: string[] = [];
    const seam: DevAgentSeam = {
      sandbox: () => {
        order.push('sandbox');
        return okRunner();
      },
      run: async () => {
        order.push('run');
      },
    };
    await dispatchDevAgentRun(event, env, seam);
    expect(order).toEqual(['sandbox', 'run']);
  });
});
