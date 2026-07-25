import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realPushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import type { GateUser } from './auth-gate.ts';

// The push subscription API (#87): the device registry behind the shell's opt-in toggle.
// Edge-only — it never wakes a container. Delivery lives in the bridge (server/push-notify.ts).

let saved: Array<{ userId: string; endpoint: string; p256dh: string; auth: string }> = [];
let removed: Array<{ userId: string; endpoint: string }> = [];

// Delegate + restore (see worker/mcp-tokens-api.test.ts): bun's mock.module rebinds the module
// for every LATER test file in this process, so the canned impls hand back to the real ones after.
const realSave = realPushStore.save;
const realRemove = realPushStore.remove;
let saveImpl: typeof realSave = (_db, userId, sub) => {
  saved.push({ userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  return Promise.resolve();
};
let removeImpl: typeof realRemove = (_db, userId, endpoint) => {
  removed.push({ userId, endpoint });
  return Promise.resolve();
};

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/push-subscriptions.ts', () => ({
  ...realPushStore,
  save: (...args: Parameters<typeof realSave>) => saveImpl(...args),
  remove: (...args: Parameters<typeof realRemove>) => removeImpl(...args),
}));
afterAll(() => {
  saveImpl = realSave;
  removeImpl = realRemove;
});

const { handlePushApi } = await import('./push.ts');

const user: GateUser = { id: 'u_1' } as GateUser;
const other: GateUser = { id: 'u_2' } as GateUser;

const call = (
  action: string,
  init: RequestInit = {},
  env: Record<string, string> = { VAPID_PUBLIC_KEY: 'PUBKEY' },
  as: GateUser = user,
) => handlePushApi(new Request(`https://app.cedarpad.com/api/push/${action}`, init), env as never, as, action);

const post = (action: string, body: unknown, as: GateUser = user) =>
  call(action, { method: 'POST', body: JSON.stringify(body) }, { VAPID_PUBLIC_KEY: 'PUBKEY' }, as);

const sub = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
  keys: { p256dh: 'p256', auth: 'auth' },
};

beforeEach(() => {
  saved = [];
  removed = [];
});

describe('GET /api/push/key', () => {
  test('hands back the configured VAPID public key', async () => {
    const res = await call('key');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: 'PUBKEY' });
  });

  test('unconfigured push returns an empty key rather than an error (the client just stays off)', async () => {
    const res = await call('key', {}, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ publicKey: '' });
  });
});

describe('POST /api/push/subscribe', () => {
  test('stores the device against the AUTHENTICATED user, not anything in the body', async () => {
    const res = await post('subscribe', { ...sub, userId: 'u_someone_else' });
    expect(res.status).toBe(204);
    expect(saved).toEqual([{ userId: 'u_1', endpoint: sub.endpoint, p256dh: 'p256', auth: 'auth' }]);
  });

  test('a malformed subscription is rejected at the boundary (400), nothing stored', async () => {
    const res = await post('subscribe', { endpoint: 'not-a-url', keys: {} });
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test('a non-JSON body is rejected, not thrown', async () => {
    const res = await call('subscribe', { method: 'POST', body: 'garbage' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/push/unsubscribe', () => {
  test('forgets the device, scoped to the caller', async () => {
    const res = await post('unsubscribe', { endpoint: sub.endpoint }, other);
    expect(res.status).toBe(204);
    expect(removed).toEqual([{ userId: 'u_2', endpoint: sub.endpoint }]);
  });

  test('a malformed body is rejected (400)', async () => {
    const res = await post('unsubscribe', {});
    expect(res.status).toBe(400);
    expect(removed).toHaveLength(0);
  });
});

describe('routing', () => {
  test('an unknown action is 404', async () => {
    expect((await call('nope')).status).toBe(404);
  });

  test('the wrong method is 405', async () => {
    expect((await call('subscribe')).status).toBe(405);
    expect((await call('key', { method: 'POST' })).status).toBe(405);
  });
});
