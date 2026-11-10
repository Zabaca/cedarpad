import { describe, expect, test } from 'bun:test';

import {
  requestBoundToken,
  REQUEST_BOUND_WINDOW_MS,
  serviceToken,
  verifyRequestBoundToken,
  verifyServiceToken,
} from './service-token.ts';

const SECRET = 'test-secret-at-least-32-characters-long!!';

describe('serviceToken (the static form — LIVE, must not change)', () => {
  // `platform-rpc/v1` and `canvas-mutate/v1` are deployed on both sides of a hop. If this
  // value ever changes, every container 401s until both ends redeploy together.
  test('still produces the same bytes for the live labels', async () => {
    expect(await serviceToken(SECRET, 'platform-rpc/v1')).toBe('6ZREm_KB6A0u4-JYopItvN3C5Cdc6x7nF_8cbVMYmXU');
    expect(await serviceToken(SECRET, 'canvas-mutate/v1')).toBe('Lq_DuFe0d2gQnbEUd5PlDCy2JTEOAT7pHHS-msBi2xY');
  });

  test('round-trips through verifyServiceToken, and separates by label', async () => {
    const t = await serviceToken(SECRET, 'a/v1');
    expect(await verifyServiceToken(SECRET, 'a/v1', t)).toBe(true);
    expect(await verifyServiceToken(SECRET, 'b/v1', t)).toBe(false);
  });
});

describe('requestBoundToken', () => {
  test('verifies for the label and subject it was minted for', async () => {
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1');
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', t)).toEqual({ ok: true });
  });

  test('is rejected under a DIFFERENT label — key separation survives the extra fields', async () => {
    const t = await requestBoundToken(SECRET, 'canvas-asset/v1', 'c1');
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', t)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('is rejected for a DIFFERENT subject — one canvas’s token cannot replay on another', async () => {
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1');
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c2', t)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('is rejected under a different secret', async () => {
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1');
    expect(await verifyRequestBoundToken(`${SECRET}x`, 'canvas-snapshot/v1', 'c1', t)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('EXPIRES: a token older than the window is rejected as skew, not as a bad signature', async () => {
    const old = Date.now() - REQUEST_BOUND_WINDOW_MS - 1000;
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', old);
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', t)).toEqual({ ok: false, reason: 'skew' });
  });

  test('a timestamp far in the FUTURE is skew too — the window is two-sided', async () => {
    const ahead = Date.now() + REQUEST_BOUND_WINDOW_MS + 1000;
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', ahead);
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', t)).toEqual({ ok: false, reason: 'skew' });
  });

  test('the timestamp is COVERED by the signature — moving it invalidates the token', async () => {
    const t = await requestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', Date.now() - REQUEST_BOUND_WINDOW_MS - 1000);
    const [, sig] = t.split('.');
    const restamped = `${Date.now()}.${sig}`;
    expect(await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', restamped)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  test('a token that is not `<ts>.<sig>` is malformed, never a crash', async () => {
    for (const bad of ['', 'nodot', 'abc.def', '.', `${Date.now()}.`]) {
      const r = await verifyRequestBoundToken(SECRET, 'canvas-snapshot/v1', 'c1', bad);
      expect(r.ok).toBe(false);
    }
  });
});
