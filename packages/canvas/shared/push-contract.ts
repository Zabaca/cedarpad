import { z } from 'zod';

/**
 * Web push contract (#87 — the `notify` seam made real).
 *
 * ONE module for every push boundary (CLAUDE.md §7): the browser → edge subscribe/unsubscribe
 * bodies, and the JSON payload the edge encrypts and the service worker decrypts. Three
 * processes parse against these schemas — the shell (`shell/src/push.ts`), the edge
 * (`worker/push.ts`), and edge delivery (`worker/push-notify.ts`) — so a field rename
 * is a mechanical refactor, not archaeology.
 *
 * `shell/public/sw.js` is the one consumer that CANNOT import this (it is a raw service-worker
 * script, not part of the vite module graph); it reads the payload defensively instead.
 */

/** The browser's `PushSubscription.toJSON()` shape (RFC 8291 keys), as POSTed to the edge. */
export const PushSubscriptionInput = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    /** The subscriber's P-256 public key, base64url. */
    p256dh: z.string().min(1),
    /** The subscriber's auth secret, base64url. */
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionInput = z.infer<typeof PushSubscriptionInput>;

/** DELETE-by-endpoint body: unsubscribing only needs the device's endpoint. */
export const PushUnsubscribeInput = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeInput = z.infer<typeof PushUnsubscribeInput>;

/** `GET /api/push/key` → the VAPID public key the browser needs to subscribe (empty = push off). */
export const PushKeyResponse = z.object({ publicKey: z.string() });
export type PushKeyResponse = z.infer<typeof PushKeyResponse>;

/** The encrypted body delivered to the service worker when a Conversation goes waiting_on:human. */
export const PushPayload = z.object({
  title: z.string(),
  body: z.string(),
  /** Shell URL to focus/open on notification click — the Inbox stage, that Conversation open. */
  url: z.string(),
  conversationId: z.string(),
});
export type PushPayload = z.infer<typeof PushPayload>;
