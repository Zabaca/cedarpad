import { describe, expect, test } from 'bun:test';

import { type BootableSandbox, BootLock, bootCanvasStack, type CanvasBootSpec } from './canvas-boot.ts';

// The cold boot's two halves, tested apart: the SEQUENCE (what it asks of the container) and
// the LOCK (how many of those sequences are allowed to exist at once). The lock is the half
// the 2026-08-13 incident was about — see canvas-boot.ts for the account.

const SPEC: CanvasBootSpec = {
  processId: 'canvas',
  start: 'bash -lc "exec bun run scripts/container-start.ts"',
  port: 4510,
  previewToken: 'canvasproxy',
  envFilePath: '/app/agent-canvas/packages/canvas/.env',
  envVars: { R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k' },
};

interface Calls {
  started: string[];
  waited: number[];
  killed: string[];
  exposed: number[];
  files: [string, string][];
}

/** A container that behaves however the test needs: `running` decides whether a process is
 *  already up, `bindsOn` decides which start attempt (1st, 2nd) finally binds the port. */
function fakeSandbox(opts: { running?: boolean; bindsOn?: number } = {}): { sandbox: BootableSandbox; calls: Calls } {
  const calls: Calls = { started: [], waited: [], killed: [], exposed: [], files: [] };
  const bindsOn = opts.bindsOn ?? 1;
  let attempt = opts.running ? 1 : 0;
  const proc = () => {
    const mine = attempt;
    return {
      waitForPort: (port: number) => {
        calls.waited.push(port);
        return mine >= bindsOn ? Promise.resolve() : Promise.reject(new Error('Process exited with code 0 before becoming ready'));
      },
    };
  };
  const sandbox: BootableSandbox = {
    setEnvVars: () => Promise.resolve(),
    getProcess: () => Promise.resolve(opts.running ? proc() : null),
    writeFile: (path, content) => {
      calls.files.push([path, content]);
      return Promise.resolve();
    },
    startProcess: (command) => {
      attempt += 1;
      calls.started.push(command);
      return Promise.resolve(proc());
    },
    killProcess: (id) => {
      calls.killed.push(id);
      return Promise.resolve();
    },
    exposePort: (port) => {
      calls.exposed.push(port);
      return Promise.resolve();
    },
  };
  return { sandbox, calls };
}

describe('bootCanvasStack: the boot sequence', () => {
  test('a cold container is started once, waited for, and its port published', async () => {
    const { sandbox, calls } = fakeSandbox();
    await bootCanvasStack(sandbox, SPEC);
    expect(calls.started).toEqual([SPEC.start]);
    expect(calls.waited).toEqual([SPEC.port]);
    expect(calls.exposed).toEqual([SPEC.port]);
    // Creds land on disk BEFORE the bridge starts — bun auto-loads .env for it and every child.
    expect(calls.files[0][0]).toBe(SPEC.envFilePath);
    expect(calls.files[0][1]).toContain('R2_BUCKET=b');
  });

  test('an already-running process is reused, not restarted', async () => {
    const { sandbox, calls } = fakeSandbox({ running: true });
    await bootCanvasStack(sandbox, SPEC);
    expect(calls.started).toEqual([]);
    expect(calls.exposed).toEqual([SPEC.port]);
  });

  test('a process that never binds is killed and replaced once', async () => {
    const { sandbox, calls } = fakeSandbox({ bindsOn: 2 });
    await bootCanvasStack(sandbox, SPEC);
    expect(calls.started).toHaveLength(2);
    expect(calls.killed).toEqual([SPEC.processId]);
    expect(calls.exposed).toEqual([SPEC.port]);
  });

  test('a boot that never binds rejects rather than exposing a dead port', async () => {
    const { sandbox, calls } = fakeSandbox({ bindsOn: 99 });
    await expect(bootCanvasStack(sandbox, SPEC)).rejects.toThrow(/before becoming ready/);
    expect(calls.exposed).toEqual([]);
  });
});

describe('BootLock: one boot per container (incident 2026-08-13)', () => {
  test('concurrent callers share ONE boot', async () => {
    const lock = new BootLock();
    let boots = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = () =>
      lock.run(async () => {
        boots += 1;
        await gate;
      });

    const all = Promise.all([run(), run(), run(), run()]);
    release();
    await all;
    expect(boots).toBe(1);
  });

  test('a caller that walks away does not take the boot with it — the next one joins it', async () => {
    // The livelock: request A triggers a boot and is canceled; before the lock lived on the
    // DO, request B then started a RIVAL boot that killed A's. Now B awaits A's.
    const lock = new BootLock();
    let boots = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const boot = () =>
      lock.run(async () => {
        boots += 1;
        await gate;
      });

    const abandoned = boot();
    const joined = boot();
    expect(joined).toBe(abandoned); // the same boot, not a second one
    release();
    await joined;
    expect(boots).toBe(1);
  });

  test('`hold` is handed the boot so the DO can keep it alive past its caller', async () => {
    const held: Promise<unknown>[] = [];
    const lock = new BootLock({ hold: (p) => held.push(p) });
    await lock.run(() => Promise.resolve());
    expect(held).toHaveLength(1);
  });

  test('a held boot that fails does not surface as an unhandled rejection', async () => {
    const held: Promise<unknown>[] = [];
    const lock = new BootLock({ hold: (p) => held.push(p) });
    await lock.run(() => Promise.reject(new Error('boom'))).catch(() => {});
    await expect(held[0]).resolves.toBeUndefined();
  });

  test('a settled boot is not reused — the next cold cycle boots again', async () => {
    const lock = new BootLock();
    let boots = 0;
    const run = () =>
      lock.run(() => {
        boots += 1;
        return Promise.resolve();
      });
    await run();
    await run();
    expect(boots).toBe(2);
  });

  test('a FAILED boot is not retried immediately — the retry storm gets a floor', async () => {
    // 2026-08-13: ProcessExitedBeforeReadyError fails fast, so there was no natural throttle
    // and the pad's heartbeats re-fired ~2 boots/second for two minutes.
    let clock = 1_000;
    const lock = new BootLock({ cooldownMs: 5_000, now: () => clock });
    let boots = 0;
    const run = () =>
      lock.run(() => {
        boots += 1;
        return Promise.reject(new Error('Process exited with code 0 before becoming ready'));
      });

    await expect(run()).rejects.toThrow(/before becoming ready/);
    clock += 500;
    await expect(run()).rejects.toThrow(/before becoming ready/); // the remembered failure, not a new boot
    expect(boots).toBe(1);

    clock += 5_000; // past the cooldown
    await expect(run()).rejects.toThrow();
    expect(boots).toBe(2);
  });

  test('a success clears the cooldown, so a later failure/recovery cycle is unaffected', async () => {
    let clock = 1_000;
    const lock = new BootLock({ cooldownMs: 5_000, now: () => clock });
    let boots = 0;
    const run = (ok: boolean) =>
      lock.run(() => {
        boots += 1;
        return ok ? Promise.resolve() : Promise.reject(new Error('nope'));
      });

    await expect(run(false)).rejects.toThrow();
    clock += 6_000;
    await run(true);
    clock += 1; // well inside the cooldown window, but the last boot SUCCEEDED
    await run(true);
    expect(boots).toBe(3);
  });
});
