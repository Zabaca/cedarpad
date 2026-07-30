import { z } from 'zod';

// The wire contract for the per-workspace events hub (#383). ONE zod module, parsed on
// BOTH sides (CLAUDE.md §7): the hub parses the notice a writer hands it, and the Shell
// parses the badge frame the hub's stream hands back.
//
// The hub exists because Workers are stateless per isolate: subscribers held on isolate A
// cannot be reached by a write that lands on isolate B, so there has to be exactly one
// addressable point per workspace. That is a Durable Object, addressed by
// `workspaceEventsName(workspaceId)`.

/**
 * The Durable Object *name* for a workspace's events hub — the same role
 * `syncRoomName(canvasId)` plays for a canvas room. Namespaced so a workspace id can never
 * collide with another use of the namespace, and kept as the raw id (not a hash) so a hub
 * in the dashboard is traceable back to its workspace.
 */
export const workspaceEventsName = (workspaceId: string): string => `workspace-events:${workspaceId}`;

/**
 * What a writer tells the hub. A TOPIC and nothing else.
 *
 * This is the whole design, and it is deliberate (#383, ADR-0022). The hub says "something
 * in your inbox changed"; the subscriber re-reads D1. It holds no count and no rows, so
 * there is no second copy of the truth to diverge, no invalidation to get wrong, and no
 * way for it to be stale in a way nobody notices — a hub that holds nothing can only ever
 * be late, never wrong. The strict object below is what keeps that true: a count cannot
 * ride this message even if someone later wants it to.
 */
export const WorkspaceEvent = z.object({ topic: z.literal('inbox') }).strip();
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>;

/** The nav badge: how many open items are newer than the workspace's SHARED read mark,
 *  and the mark itself. Per-viewer — ADR-0016 visibility means two members of one
 *  workspace can legitimately see different counts. */
export const InboxBadge = z.object({
  count: z.number().int().nonnegative(),
  readAt: z.number().int().nonnegative(),
});
export type InboxBadge = z.infer<typeof InboxBadge>;

/** The badge as one SSE frame (sender side). */
export const encodeInboxBadgeFrame = (badge: InboxBadge): string => `data: ${JSON.stringify(InboxBadge.parse(badge))}\n\n`;

/**
 * The badge out of an `EventSource` message (receiver side) — the `data` payload, without
 * the framing. Null for anything that does not parse: a bad frame must leave the badge
 * showing what it showed, never throw inside an event handler.
 */
export function readInboxBadgeFrame(data: string): InboxBadge | null {
  try {
    const parsed = InboxBadge.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
