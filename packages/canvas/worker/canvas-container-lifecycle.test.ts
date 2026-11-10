import { describe, expect, test } from 'bun:test';

import {
  bootFingerprint,
  idleVerdict,
  inactivityTimeoutMs,
  mayRetry,
  rearmAt,
} from './canvas-container-lifecycle.ts';

const MIN = 60_000;

describe('idleVerdict', () => {
  test('never stops while a request is in flight', () => {
    expect(idleVerdict({ now: 10 * MIN, inflight: 1, lastActivity: 0, sleepAfterMs: 5 * MIN })).toEqual({
      stop: false,
      at: 15 * MIN,
    });
  });

  test('stops once sleepAfter has passed since the last request finished', () => {
    expect(idleVerdict({ now: 10 * MIN, inflight: 0, lastActivity: 5 * MIN, sleepAfterMs: 5 * MIN })).toEqual({ stop: true });
  });

  test('waits out the rest of the window when it fires early', () => {
    expect(idleVerdict({ now: 7 * MIN, inflight: 0, lastActivity: 5 * MIN, sleepAfterMs: 5 * MIN })).toEqual({
      stop: false,
      at: 10 * MIN,
    });
  });

  test('a container no request has finished on is idle', () => {
    expect(idleVerdict({ now: 1, inflight: 0, lastActivity: null, sleepAfterMs: 5 * MIN })).toEqual({ stop: true });
  });
});

describe('rearmAt', () => {
  test('moves the alarm out to sleepAfter from now', () => {
    expect(rearmAt({ now: 0, scheduled: null, sleepAfterMs: 5 * MIN })).toBe(5 * MIN);
  });

  test('leaves an alarm that is already close to the new deadline (no write per module fetch)', () => {
    expect(rearmAt({ now: 10_000, scheduled: 5 * MIN, sleepAfterMs: 5 * MIN })).toBeNull();
  });
});

describe('inactivityTimeoutMs', () => {
  test('is the idle window plus a margin, capped at the API maximum', () => {
    expect(inactivityTimeoutMs(5 * MIN)).toBe(7 * MIN);
    expect(inactivityTimeoutMs(24 * 60 * MIN)).toBe(6 * 60 * MIN);
  });
});

describe('mayRetry', () => {
  test('retries one bodiless read only', () => {
    expect(mayRetry('GET', 0)).toBe(true);
    expect(mayRetry('HEAD', 0)).toBe(true);
    expect(mayRetry('GET', 1)).toBe(false);
    expect(mayRetry('POST', 0)).toBe(false);
  });
});

describe('bootFingerprint', () => {
  test('is stable across key order', () => {
    expect(bootFingerprint('img@sha256:a', { A: '1', B: '2' })).toBe(bootFingerprint('img@sha256:a', { B: '2', A: '1' }));
  });

  test('changes when the image or any env value changes', () => {
    const base = bootFingerprint('img@sha256:a', { A: '1' });
    expect(bootFingerprint('img@sha256:b', { A: '1' })).not.toBe(base);
    expect(bootFingerprint('img@sha256:a', { A: '2' })).not.toBe(base);
    expect(bootFingerprint('img@sha256:a', { A: '1', B: '' })).not.toBe(base);
  });

  test('never contains the values it hashes', () => {
    expect(bootFingerprint('img', { SECRET: 'sk-very-secret' })).not.toContain('secret');
  });
});
