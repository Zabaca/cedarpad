import webpush from 'web-push';

import type { Database } from '../web-poc/lib/db/client.ts';
import * as pushStore from '../web-poc/lib/db/queries/push-subscriptions.ts';
import { listWorkspaceMembers } from '../web-poc/lib/db/queries/workspaces.ts';
import type { ConversationRow, PushSubscriptionRow } from '../web-poc/lib/db/schema.ts';
import { PushPayload, type PushSubscriptionInput } from '../shared/push-contract.ts';
import type { Notify } from './inbox.ts';

/**
 * Web push delivery for the `notify` seam (#87): when a background agent flips a Conversation
 * to waiting_on:human, every device the owner has subscribed gets an OS-level ping — the
 * "sessions appear when they need my attention" half of the Inbox. The Inbox row is still the
 * durable signal; push is the doorbell, so every failure here is swallowed.
 *
 * The send runs in the CONTAINER (that's where the seam is), so VAPID_PRIVATE_KEY must be
 * forwarded through `worker/container-env.ts`. Its capability is narrow — it can address only
 * endpoints already in `push_subscriptions`, and reads nothing.
 */

/** What the push service said about one device. `gone` = 404/410: the subscription is dead. */
export type PushSendResult = 'delivered' | 'gone';

/** The transport seam — the real one is `webPushSender`; tests inject a recorder. */
export type PushSend = (sub: PushSubscriptionInput, payload: string) => Promise<PushSendResult>;

export interface PushNotifyDeps {
  db: Database;
  /** The one recipient whose devices get the ping (resolved by `makeAssignmentPushNotify`). */
  userId: string;
  /** Shell origin the notification click should open (e.g. `https://app.cedarpad.com`). */
  origin: string;
  send: PushSend;
}

/** Notification bodies are a one-line glance, not a transcript. */
const MAX_BODY = 200;
const clip = (s: string) => (s.length > MAX_BODY ? `${s.slice(0, MAX_BODY - 1)}…` : s);

const toInput = (row: PushSubscriptionRow): PushSubscriptionInput => ({
  endpoint: row.endpoint,
  keys: { p256dh: row.p256dh, auth: row.auth },
});

/** Build the `Notify` the bridge passes into `endTurn`. */
export function makePushNotify(deps: PushNotifyDeps): Notify {
  return async (conversation, question) => {
    const devices = await pushStore.listForUser(deps.db, deps.userId);
    if (devices.length === 0) return;

    const payload = JSON.stringify(
      PushPayload.parse({
        title: conversation.summary?.trim() || 'A session needs you',
        body: clip(question),
        url: `${deps.origin}/?stage=inbox&conv=${conversation.id}`,
        conversationId: conversation.id,
      }),
    );

    await Promise.all(
      devices.map(async (row) => {
        try {
          const result = await deps.send(toInput(row), payload);
          if (result === 'gone') await pushStore.remove(deps.db, deps.userId, row.endpoint);
        } catch (err) {
          console.error(`[push] send failed for ${row.endpoint}:`, err);
        }
      }),
    );
  };
}

/**
 * Who should be woken for this Conversation (#231). Routing follows the existing advisory
 * assignment (#217) rather than a second notion of who cares: an assigned session has an
 * owner, so waking the team is noise; an unassigned one is unclaimed queue work (a cron /
 * unattended run), so the whole workspace roster gets it. Deduped — the owner may also hold
 * a member row, and endpoints are per-user, so unique userIds means unique endpoints.
 */
export async function resolvePushRecipients(
  db: Database,
  conversation: Pick<ConversationRow, 'workspaceId' | 'assignedTo'>,
): Promise<string[]> {
  if (conversation.assignedTo) return [conversation.assignedTo];
  const members = await listWorkspaceMembers(db, conversation.workspaceId);
  return [...new Set(members.map((m) => m.userId))];
}

/** The `Notify` the bridge actually installs: resolve recipients, then per-user fan-out. */
export function makeAssignmentPushNotify(deps: Omit<PushNotifyDeps, 'userId'>): Notify {
  return async (conversation, question) => {
    const userIds = await resolvePushRecipients(deps.db, conversation);
    await Promise.all(
      userIds.map((userId) => makePushNotify({ ...deps, userId })(conversation, question)),
    );
  };
}

/**
 * The real transport. Returns null when VAPID is unconfigured — push is then simply off
 * (the bridge falls back to its log line), which is exactly the local-dev default.
 */
export function webPushSender(env: Record<string, string | undefined>): PushSend | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  // The RFC 8292 `sub` claim: a mailto:/https: the push service can contact us at.
  const subject = env.VAPID_SUBJECT ?? 'mailto:support@cedarpad.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);

  return async (sub, payload) => {
    try {
      await webpush.sendNotification(sub, payload);
      return 'delivered';
    } catch (err) {
      // 404/410 is the push service saying this device's subscription no longer exists.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      throw err;
    }
  };
}
