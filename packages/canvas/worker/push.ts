import { PushSubscriptionInput, PushUnsubscribeInput } from '../shared/push-contract.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';

// Web push device registry (#87) — the opt-in half of the `notify` seam. Edge-only against
// remote Turso: subscribing never wakes a container. The container bridge reads these rows
// back out when a Conversation flips to waiting_on:human (server/push-notify.ts).
//
// The subscription is bound to the AUTHENTICATED user (`user.id`), never to anything the
// body claims — and unsubscribe is user-scoped in the store for the same reason.

/**
 * GET  /api/push/key         → { publicKey } (empty when VAPID is unconfigured → push off)
 * POST /api/push/subscribe   → 204, body: PushSubscriptionInput
 * POST /api/push/unsubscribe → 204, body: PushUnsubscribeInput
 */
export async function handlePushApi(
  request: Request,
  env: Env,
  user: GateUser,
  action?: string,
): Promise<Response> {
  if (action === 'key') {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    return Response.json({ publicKey: env.VAPID_PUBLIC_KEY ?? '' });
  }

  if (action !== 'subscribe' && action !== 'unsubscribe') {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = await request.json().catch(() => null);
  const db = createDbForWorker(env as unknown as Bindings);

  if (action === 'subscribe') {
    const parsed = PushSubscriptionInput.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'invalid subscription' }, { status: 400 });
    await pushStore.save(db, user.id, parsed.data);
    return new Response(null, { status: 204 });
  }

  const parsed = PushUnsubscribeInput.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'invalid endpoint' }, { status: 400 });
  await pushStore.remove(db, user.id, parsed.data.endpoint);
  return new Response(null, { status: 204 });
}
