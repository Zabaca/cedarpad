import { describe, expect, test } from 'bun:test';

import { disablePush, enablePush, pushState, urlBase64ToUint8Array, type PushDeps } from './push.ts';

// The shell's push opt-in (#87). Every browser global is injected, so this runs headlessly.

type Call = { url: string; body?: unknown };

/** A structurally valid VAPID public key: 65 raw bytes, base64url, unpadded. */
const FAKE_VAPID_KEY = 'BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A';

function harness(opts: {
  publicKey?: string | null;
  permission?: NotificationPermission;
  /** What requestPermission() resolves to (defaults to 'granted'). */
  grant?: NotificationPermission;
  /** An already-live subscription on this device. */
  subscribed?: boolean;
  supported?: boolean;
  subscribeFails?: boolean;
}) {
  const calls: Call[] = [];
  let unsubscribed = false;
  let registered: string | null = null;
  let permission = opts.permission ?? 'default';

  const subscription = {
    endpoint: 'https://push.example.com/dev1',
    toJSON: () => ({ endpoint: 'https://push.example.com/dev1', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      unsubscribed = true;
      return true;
    },
  };
  let current: typeof subscription | null = opts.subscribed ? subscription : null;

  const pushManager = {
    getSubscription: async () => current,
    subscribe: async (o: { applicationServerKey: Uint8Array; userVisibleOnly: boolean }) => {
      calls.push({ url: 'pushManager.subscribe', body: { userVisibleOnly: o.userVisibleOnly, keyBytes: o.applicationServerKey.length } });
      current = subscription;
      return subscription;
    },
  };
  const registration = { pushManager } as unknown as ServiceWorkerRegistration;

  const serviceWorker = {
    register: async (path: string) => {
      registered = path;
      return registration;
    },
    getRegistration: async () => (registered || opts.subscribed ? registration : undefined),
  } as unknown as ServiceWorkerContainer;

  const deps: PushDeps = {
    serviceWorker: opts.supported === false ? undefined : serviceWorker,
    notification:
      opts.supported === false
        ? undefined
        : {
            get permission() {
              return permission;
            },
            requestPermission: async () => {
              permission = opts.grant ?? 'granted';
              return permission;
            },
          },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/push/key') {
        if (opts.publicKey === null) return new Response('nope', { status: 500 });
        // A real VAPID public key is 65 raw bytes, base64url-encoded.
        return Response.json({ publicKey: opts.publicKey ?? FAKE_VAPID_KEY });
      }
      if (url === '/api/push/subscribe') return new Response(null, { status: opts.subscribeFails ? 500 : 204 });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };

  return { deps, calls, get unsubscribed() { return unsubscribed; }, get registered() { return registered; } };
}

describe('urlBase64ToUint8Array', () => {
  test('decodes unpadded base64url (the VAPID wire form) to raw bytes', () => {
    // 'hello' → base64 'aGVsbG8=' → base64url unpadded 'aGVsbG8'
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  test('maps the url-safe alphabet back to standard base64', () => {
    // bytes [251, 255, 190] → base64 '+/++' → base64url '-_--'
    expect(Array.from(urlBase64ToUint8Array('-_--'))).toEqual([251, 255, 190]);
  });
});

describe('pushState', () => {
  test('unsupported when the browser has no service worker / Notification', async () => {
    expect(await pushState(harness({ supported: false }).deps)).toBe('unsupported');
  });

  test('unconfigured when the deployment has no VAPID key', async () => {
    expect(await pushState(harness({ publicKey: '' }).deps)).toBe('unconfigured');
  });

  test('unconfigured when the key endpoint errors (never throws at the caller)', async () => {
    expect(await pushState(harness({ publicKey: null }).deps)).toBe('unconfigured');
  });

  test('denied when the user has blocked notifications', async () => {
    expect(await pushState(harness({ permission: 'denied' }).deps)).toBe('denied');
  });

  test('off when supported and configured but this device is not subscribed', async () => {
    expect(await pushState(harness({}).deps)).toBe('off');
  });

  test('on when this device already has a subscription', async () => {
    expect(await pushState(harness({ subscribed: true, permission: 'granted' }).deps)).toBe('on');
  });

  test('reading state never prompts and never registers the worker', async () => {
    const h = harness({});
    await pushState(h.deps);
    expect(h.registered).toBeNull();
    expect(h.calls.map((c) => c.url)).toEqual(['/api/push/key']);
  });
});

describe('enablePush', () => {
  test('registers /sw.js, subscribes with userVisibleOnly, and POSTs the subscription', async () => {
    const h = harness({});
    expect(await enablePush(h.deps)).toBe('on');
    expect(h.registered).toBe('/sw.js');

    const subscribeCall = h.calls.find((c) => c.url === 'pushManager.subscribe');
    expect(subscribeCall?.body).toMatchObject({ userVisibleOnly: true });

    const post = h.calls.find((c) => c.url === '/api/push/subscribe');
    expect(post?.body).toEqual({ endpoint: 'https://push.example.com/dev1', keys: { p256dh: 'p', auth: 'a' } });
  });

  test('a refused permission prompt leaves push off and stores nothing', async () => {
    const h = harness({ grant: 'denied' });
    expect(await enablePush(h.deps)).toBe('denied');
    expect(h.calls.some((c) => c.url === '/api/push/subscribe')).toBe(false);
  });

  test('an already-subscribed device re-registers its existing endpoint rather than re-subscribing', async () => {
    const h = harness({ subscribed: true, permission: 'granted' });
    expect(await enablePush(h.deps)).toBe('on');
    expect(h.calls.some((c) => c.url === 'pushManager.subscribe')).toBe(false);
    expect(h.calls.some((c) => c.url === '/api/push/subscribe')).toBe(true);
  });

  test('a failed registration POST reports off, not a false "on"', async () => {
    const h = harness({ subscribeFails: true });
    expect(await enablePush(h.deps)).toBe('off');
  });

  test('unconfigured deployments do not prompt the user', async () => {
    const h = harness({ publicKey: '' });
    expect(await enablePush(h.deps)).toBe('unconfigured');
    expect(h.registered).toBeNull();
  });
});

describe('disablePush', () => {
  test('tells the edge to forget the endpoint, then unsubscribes locally', async () => {
    const h = harness({ subscribed: true, permission: 'granted' });
    expect(await disablePush(h.deps)).toBe('off');
    const post = h.calls.find((c) => c.url === '/api/push/unsubscribe');
    expect(post?.body).toEqual({ endpoint: 'https://push.example.com/dev1' });
    expect(h.unsubscribed).toBe(true);
  });

  test('no subscription → a no-op, no request', async () => {
    const h = harness({});
    expect(await disablePush(h.deps)).toBe('off');
    expect(h.calls.some((c) => c.url === '/api/push/unsubscribe')).toBe(false);
  });
});
