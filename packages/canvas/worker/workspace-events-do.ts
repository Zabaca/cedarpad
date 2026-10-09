import { WorkspaceEvent } from '../shared/workspace-events.ts';
import { NOTIFY_PATH, SUBSCRIBE_PATH } from './workspace-events.ts';

// The per-workspace events hub (#383). One Durable Object per workspace, addressed by
// `idFromName(workspaceEventsName(workspaceId))`, whose entire job is fan-out.
//
// WHY A DO AND NOT A WORKER. Workers are stateless per isolate: a subscriber held on
// isolate A cannot be reached by a write that lands on isolate B, so there is no
// Worker-only fix for "tell every open tab that this workspace's inbox changed". One
// addressable point per workspace is the requirement, and a DO is the only thing that
// provides it. The three classes we already had are all the wrong fit — `CanvasSyncRoom`
// is keyed per CANVAS (the inbox spans canvases), and `Sandbox` is the right
// scope but the wrong lifecycle: it is a compute container built to sleep, so hanging
// the hub off one would either keep a container warm to serve a badge or lose the hub
// exactly when the workspace goes idle. `CanvasSyncRoom` is nonetheless the SHAPE this
// follows — a per-something hub with hibernatable subscribers.
//
// WHAT IT MUST NOT DO. It holds no inbox state and no count. It says "something in your
// inbox changed"; the subscriber re-reads D1. That is the lesson of ADR-0022 applied to a
// notifier: a second copy of the truth is a copy that can diverge, needs invalidation, and
// goes stale in ways nobody notices. A hub that holds nothing cannot be wrong, only late.
// The contract (`shared/workspace-events.ts`) is what keeps that structural rather than
// aspirational — a count cannot be expressed on this wire.
//
// HIBERNATION. Sockets are accepted with `ctx.acceptWebSocket`, so an idle hub can be
// evicted without dropping its subscribers, and a notice wakes it. There is nothing to
// restore on that wake: because the hub keeps no state, `ctx.getWebSockets()` IS the
// subscriber list. This is also why the SSE stream lives in the WORKER and not in here —
// hibernation is WebSocket-only, so a DO holding open SSE bodies would stay resident for
// as long as any tab anywhere had the app open. The Worker isolate holding the stream
// pays that cost instead, and it is a cost it was already paying for the old timer.

/**
 * Deliver one notice to every subscriber. Pure over the socket list, so the part where a
 * mistake means a badge that never updates is testable without a Durable Object.
 *
 * A socket that throws is skipped rather than propagated: one dead connection must not
 * cost every other tab in the workspace its notification. The runtime's own close/error
 * callbacks are what actually reap it.
 */
export function fanOut(sockets: WebSocket[], event: WorkspaceEvent): void {
  const message = JSON.stringify(event);
  for (const ws of sockets) {
    try {
      ws.send(message);
    } catch {
      /* already gone — the close/error callback will reap it */
    }
  }
}

// Deliberately NOT `extends DurableObject` from 'cloudflare:workers', for the reason
// `canvas-sync-do.ts` records: that import is unresolvable outside workerd, and this class
// has to be re-exported from worker/index.ts for wrangler to find it — which would break
// `bun test` for every suite that transitively imports the entrypoint.
export class WorkspaceEvents {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // The doorbell. Every conversation writer at the edge rings it after its write commits.
    if (url.pathname.endsWith(NOTIFY_PATH)) {
      // Parsed HERE, on the receiving side of the boundary (CLAUDE.md §7). The notice
      // arrived over a trusted hop, which is not a reason to forward it unread — and the
      // parse is also what strips anything a caller tried to smuggle alongside the topic.
      const parsed = WorkspaceEvent.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return new Response('invalid notice', { status: 400 });
      fanOut(this.ctx.getWebSockets(), parsed.data);
      return new Response(null, { status: 204 });
    }

    // The subscriber's door: one socket per open SSE stream, held by the Worker isolate
    // serving that stream. There is no identity to check — the hub carries nothing a
    // subscriber could learn from it beyond "look again", and the Worker has already
    // gated the workspace before it ever gets here.
    if (url.pathname.endsWith(SUBSCRIBE_PATH)) {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('expected a websocket upgrade', { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]!);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  // Hibernation delivers socket lifecycle as class methods. Both are empty on purpose:
  // the runtime removes the socket from `getWebSockets()` itself, and the hub has no
  // per-socket state of its own to forget.
  webSocketClose(): void {}
  webSocketError(): void {}
}
