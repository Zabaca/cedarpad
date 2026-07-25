/* Push service worker (#87) — the OS-level half of the Inbox's `notify` seam.
 *
 * Deliberately dependency-free plain JS: this file is served verbatim from `shell/dist/sw.js`
 * and is NOT part of the vite module graph, so it cannot import the zod contract in
 * `shared/push-contract.ts`. It reads the payload defensively instead; the contract is
 * enforced on the sending side (server/push-notify.ts parses before encrypting).
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Malformed/absent payload: still surface something rather than dropping the ping.
  }
  const title = payload.title || 'A session needs you';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      // One notification per Conversation: a second question on the same session replaces
      // the first instead of stacking N pings for one thread.
      tag: payload.conversationId || 'cedarpad-inbox',
      renotify: true,
      data: { url: payload.url || '/?stage=inbox' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/?stage=inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing shell tab and steer it, rather than opening a duplicate.
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.focus();
          if ('navigate' in client) client.navigate(target);
          return;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
