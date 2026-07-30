import type { Database } from '../web-poc/lib/db/index.ts';
// The badge shape and the frame encoding come from the shared contract (CLAUDE.md §7) —
// one definition, encoded here and parsed by the Shell.
import { WorkspaceEvent, encodeInboxBadgeFrame, type InboxBadge } from '../shared/workspace-events.ts';
import { inboxWatermark } from '../web-poc/lib/db/queries/inbox-watermark.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { listVisibleConversations } from './access.ts';
import { orderInbox, unseenCount, viewToListOpts } from './inbox-view.ts';

// What ONE connected tab's nav badge costs (#383), kept free of the edge runtime and of
// timers so the cost is measurable in a unit test (`inbox-badge.test.ts`) rather than
// argued about. `inbox.ts` owns the SSE plumbing around it; this owns the decision of when
// to touch D1 at all.
//
// The stream this backs used to recompute the badge unconditionally every 10s per tab —
// 1.6M rows a day in production to answer a question whose answer changed a few hundred
// times. The fix is not a cache (ADR-0022: a second copy of the truth diverges); it is
// asking a CHEAPER question first. Nothing about the count is stored anywhere but in this
// one connection's memory, next to the stream that already holds it.

export interface InboxBadgeSource {
  /**
   * The quiet path. Read the watermark; only if it moved, re-read the inbox. Answers the
   * frame to send, or null when there is nothing new to say — which is almost always.
   */
  poll(): Promise<InboxBadge | null>;
  /**
   * The notified path (#383 part 2): something changed and the hub said so, so skip the
   * probe and recompute. Still answers null when the number did not actually move — the
   * hub reports that the INBOX changed, which is a broader thing than the badge changing.
   */
  push(): Promise<InboxBadge | null>;
}

/**
 * One connection's badge source. `userId` is fixed because the badge is per-viewer:
 * ADR-0016 visibility means two members of one workspace can legitimately see different
 * counts, so the filtering cannot be shared or hoisted anywhere.
 */
export function inboxBadgeSource(database: Database, workspaceId: string, userId: string): InboxBadgeSource {
  // The two things this connection remembers. Neither is inbox state: `mark` is a
  // change detector and `count` is what this socket last SAID, kept only so the stream
  // does not repeat itself.
  let mark: string | null = null;
  let count = -1;

  const recompute = async (): Promise<InboxBadge | null> => {
    const items = orderInbox(await listVisibleConversations(database, workspaceId, userId, viewToListOpts(null)));
    const ws = await getWorkspace(database, workspaceId, userId);
    const readAt = ws?.inboxReadAt ? ws.inboxReadAt.getTime() : 0;
    const next = unseenCount(items, readAt);
    if (next === count) return null;
    count = next;
    return { count: next, readAt };
  };

  return {
    async poll() {
      const now = await inboxWatermark(database, workspaceId);
      if (now === mark) return null;
      mark = now;
      return recompute();
    },
    async push() {
      // The watermark is refreshed even though it was not consulted: a poll that ran right
      // after this must not re-read rows this call already read.
      mark = await inboxWatermark(database, workspaceId);
      return recompute();
    },
  };
}

/** The half of a hub subscription this module uses. Narrowed to two methods so the stream
 *  tests need no WebSocket — and so nothing here can accidentally start SENDING to a hub
 *  that has nothing to receive. */
export interface HubSocket {
  addEventListener(type: 'message' | 'close' | 'error', cb: (ev: { data?: unknown }) => void): void;
  close(): void;
}

/** How often the stream writes with nothing to say, and how often it checks anyway. Both
 *  are the ROUTE's decision (`inbox.ts` holds the production numbers); they are parameters
 *  here so the timer behaviour is testable in milliseconds instead of minutes. */
export interface InboxBadgeStreamTimings {
  keepAliveMs: number;
  safetyNetMs: number;
}

/**
 * One connected tab's badge stream.
 *
 * The hub is the DRIVER: a notice arrives, the source recomputes, and a frame goes out —
 * so badge latency is a hub hop plus one read rather than a tick. The two timers are not
 * that driver and must not be mistaken for it:
 *
 *   - keep-alive writes a comment frame and reads NOTHING. It exists because the old 10s
 *     recompute doubled as departed-client detection: a purely event-driven stream never
 *     notices a client that vanished, and those streams accumulate. The write is what
 *     fails, and the failure is what tears this down.
 *   - the safety net re-checks the watermark, because ringing the hub is best-effort by
 *     construction (the write it announces has already committed), so a lost notice must
 *     not strand the badge until the tab is reloaded.
 *
 * `hub` may be null — no binding, or a hub that refused the upgrade. The stream then runs
 * on the safety net alone: slower than it should be, never wrong.
 */
export function inboxBadgeStream(
  source: InboxBadgeSource,
  hub: HubSocket | null,
  timings: InboxBadgeStreamTimings,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const timers: ReturnType<typeof setInterval>[] = [];
  let done = false;

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      const teardown = () => {
        if (done) return;
        done = true;
        for (const t of timers) clearInterval(t);
        timers.length = 0;
        // Releasing the hub socket here is what keeps subscribers from outliving their
        // tabs — the hub reaps nothing on its own.
        try {
          hub?.close();
        } catch {
          /* already gone */
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const write = (chunk: string) => {
        if (done) return;
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          // The client went away: enqueueing into a stream nobody is reading throws, and
          // that throw is the only signal we get.
          teardown();
        }
      };

      const emit = async (badge: Promise<InboxBadge | null>) => {
        try {
          const next = await badge;
          if (next) write(encodeInboxBadgeFrame(next));
        } catch {
          teardown();
        }
      };

      hub?.addEventListener('message', (ev) => {
        // Parsed on the receiving side (CLAUDE.md §7). An unreadable notice is dropped
        // rather than treated as "something changed" — a hub that starts speaking a
        // dialect we do not know must not turn into a recompute loop.
        if (!WorkspaceEvent.safeParse(safeJson(ev.data)).success) return;
        void emit(source.push());
      });
      // A hub that goes away (a deploy restarts it) ends the stream rather than leaving it
      // silently unsubscribed: EventSource reconnects, and the new stream attaches to the
      // new hub. Self-healing, and cheaper than resubscribing from in here.
      hub?.addEventListener('close', teardown);
      hub?.addEventListener('error', teardown);

      void emit(source.poll()); // the opening badge
      timers.push(setInterval(() => write(': keep-alive\n\n'), timings.keepAliveMs));
      timers.push(setInterval(() => void emit(source.poll()), timings.safetyNetMs));
    },
    cancel: () => {
      done = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      try {
        hub?.close();
      } catch {
        /* already gone */
      }
    },
  });
}

const safeJson = (data: unknown): unknown => {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
};
