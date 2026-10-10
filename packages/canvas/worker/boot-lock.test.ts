import { describe, expect, test } from 'bun:test';

import { BootLock } from './boot-lock.ts';

// The lock the 2026-08-13 incident was about — see boot-lock.ts for the account.

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
