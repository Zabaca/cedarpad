import { and, eq } from "drizzle-orm";
import type { PushSubscriptionInput } from "../../../../shared/push-contract.ts";
import type { Database } from "../client.js";
import { type PushSubscriptionRow, pushSubscriptions } from "../schema.js";

/**
 * Web push subscription store (#87). PER DEVICE, not per user — the endpoint is the
 * push service's per-device address and the primary key, so re-subscribing a device
 * upserts (including reassigning it to whoever is signed in now, on a shared browser).
 * Backend only.
 */

/** Record (or refresh) one device's subscription for a user. */
export async function save(
  db: Database,
  userId: string,
  sub: PushSubscriptionInput,
): Promise<void> {
  const values = {
    endpoint: sub.endpoint,
    userId,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
  };
  await db
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: values.p256dh, auth: values.auth, updatedAt: new Date() },
    });
}

/** Every device this user has subscribed. */
export async function listForUser(db: Database, userId: string): Promise<PushSubscriptionRow[]> {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}

/**
 * Forget a device — user opt-out, or the push service reporting the endpoint is gone.
 * Scoped by user as well as endpoint: an endpoint URL is the only thing needed to address a
 * device, so an unscoped delete would let any signed-in caller silence someone else's phone.
 */
export async function remove(db: Database, userId: string, endpoint: string): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}
