import { PushKeyResponse, type PushSubscriptionInput } from '../../shared/push-contract.ts';

/**
 * The shell's web-push opt-in (#87). Browsers only grant notification permission from a user
 * gesture, so this is a deliberate toggle in Settings — never something that fires on load.
 *
 * Everything the browser gives us (`ServiceWorkerContainer`, `Notification`, `fetch`) is
 * injectable so the flow is testable headlessly; the defaults are the real globals.
 */

export type PushState =
  /** No service-worker / Push API in this browser (or a non-secure origin). */
  | 'unsupported'
  /** The deployment has no VAPID key — push is off for everyone. */
  | 'unconfigured'
  /** Supported and configured, this device is not subscribed. */
  | 'off'
  /** This device is subscribed. */
  | 'on'
  /** The user blocked notifications; only they can undo it, in browser settings. */
  | 'denied';

export interface PushDeps {
  serviceWorker?: ServiceWorkerContainer;
  notification?: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> };
  fetch: typeof globalThis.fetch;
}

const browserDeps = (): PushDeps => ({
  serviceWorker: typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  notification: typeof Notification !== 'undefined' ? Notification : undefined,
  fetch: globalThis.fetch.bind(globalThis),
});

/**
 * VAPID keys travel as base64url; `pushManager.subscribe` wants raw bytes. Exported because
 * it is the one piece of this module with a wrong-answer failure mode worth pinning down.
 */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The deployment's VAPID public key, or '' when push is unconfigured. */
async function vapidKey(deps: PushDeps): Promise<string> {
  const res = await deps.fetch('/api/push/key', { credentials: 'same-origin' }).catch(() => null);
  if (!res?.ok) return '';
  const parsed = PushKeyResponse.safeParse(await res.json().catch(() => null));
  return parsed.success ? parsed.data.publicKey : '';
}

/** Read this device's current state without prompting for anything. */
export async function pushState(deps: PushDeps = browserDeps()): Promise<PushState> {
  if (!deps.serviceWorker || !deps.notification) return 'unsupported';
  if (!(await vapidKey(deps))) return 'unconfigured';
  if (deps.notification.permission === 'denied') return 'denied';
  const reg = await deps.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const existing = await reg?.pushManager.getSubscription().catch(() => null);
  return existing ? 'on' : 'off';
}

/**
 * Turn push on for THIS device: register the worker, ask permission (must be called from a
 * click), subscribe, and register the endpoint with the edge. Idempotent — re-running on a
 * subscribed device just re-registers the same endpoint (the store upserts).
 */
export async function enablePush(deps: PushDeps = browserDeps()): Promise<PushState> {
  if (!deps.serviceWorker || !deps.notification) return 'unsupported';
  const publicKey = await vapidKey(deps);
  if (!publicKey) return 'unconfigured';

  const permission =
    deps.notification.permission === 'granted'
      ? 'granted'
      : await deps.notification.requestPermission().catch(() => 'denied' as NotificationPermission);
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const reg = await deps.serviceWorker.register('/sw.js');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      // Web push without a payload is useless to us, and Chrome requires this to be true.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const res = await deps.fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON() as PushSubscriptionInput),
  });
  return res.ok ? 'on' : 'off';
}

/** Turn push off for THIS device only — other devices keep theirs. */
export async function disablePush(deps: PushDeps = browserDeps()): Promise<PushState> {
  if (!deps.serviceWorker) return 'unsupported';
  const reg = await deps.serviceWorker.getRegistration('/sw.js').catch(() => null);
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (!sub) return 'off';
  // Tell the edge FIRST: a browser-side unsubscribe that failed to reach us would leave a
  // dead row that pushes forever (until the service 410s it).
  await deps
    .fetch('/api/push/unsubscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    })
    .catch(() => null);
  await sub.unsubscribe().catch(() => false);
  return 'off';
}
