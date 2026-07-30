import { WorkspaceEvent, workspaceEventsName } from '../shared/workspace-events.ts';

// How the EDGE reaches a workspace's events hub (#383). The addressing lives here, apart
// from the Durable Object itself (`workspace-events-do.ts`), so every call site — and
// there are many, because every conversation writer rings this doorbell — shares one
// derivation of "which instance" and one definition of "best effort".

/** The two doors on the hub. Matched on the suffix inside the DO, exactly as
 *  `CanvasSyncRoom` matches `/mutate` and `/snapshot`. */
export const NOTIFY_PATH = '/notify';
export const SUBSCRIBE_PATH = '/subscribe';

/** Minimal structural shape of the `WORKSPACE_EVENTS` binding — the same narrowing as
 *  `CanvasSyncNamespace` (mart-api.ts): only `idFromName` + `get().fetch`, so a test can
 *  pass a plain object and no test has to conjure a Durable Object namespace. */
export interface WorkspaceEventsHub<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): { fetch(request: Request): Promise<HubResponse> };
}

/**
 * The subscriber end of a hub connection, as this module uses it. Declared structurally
 * rather than as the DOM `WebSocket` in this program's `lib`, which has neither `accept()`
 * nor a `webSocket` property on `Response` — both are the Workers runtime's, and naming
 * them here keeps the casts out of the call sites.
 */
export interface HubWebSocket {
  accept(): void;
  addEventListener(type: 'message' | 'close' | 'error', cb: (ev: { data?: unknown }) => void): void;
  close(): void;
}

/** A 101 out of a Durable Object carries the client end of the pair on `webSocket`. */
type HubResponse = Response & { webSocket?: HubWebSocket | null };

/** A workspace's hub is one instance, globally: every isolate in every colo derives the
 *  same id from the same workspace id. That is the entire reason this is a DO. */
const stubFor = <Id>(hub: WorkspaceEventsHub<Id>, workspaceId: string) =>
  hub.get(hub.idFromName(workspaceEventsName(workspaceId)));

/**
 * Ring the doorbell: tell everyone watching this workspace that its inbox changed.
 *
 * Best effort by construction — it never throws and never reports. Every call site is a
 * mutation that has ALREADY committed by the time this runs, so a hub that is unreachable
 * must cost a late badge, never a failed write. The subscriber's own watermark tick is the
 * backstop for exactly that case.
 *
 * `hub` is optional because the binding genuinely can be absent: unit tests drive these
 * handlers with a bare `{}` env, and a missing binding must be "no push", not a crash.
 */
export async function notifyInboxChanged(hub: WorkspaceEventsHub | undefined, workspaceId: string): Promise<void> {
  if (!hub) return;
  try {
    await stubFor(hub, workspaceId).fetch(
      new Request(`https://workspace-events/${encodeURIComponent(workspaceId)}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'inbox' } satisfies WorkspaceEvent),
      }),
    );
  } catch {
    /* the doorbell is not the signal — the row is already written */
  }
}

/**
 * Attach to a workspace's hub for the life of one SSE stream. Answers the socket, or null
 * when there is no hub to attach to — in which case the caller keeps its periodic tick and
 * the badge is merely as slow as it used to be, rather than broken.
 */
export async function subscribeToWorkspace(
  hub: WorkspaceEventsHub | undefined,
  workspaceId: string,
): Promise<HubWebSocket | null> {
  if (!hub) return null;
  try {
    const res = await stubFor(hub, workspaceId).fetch(
      new Request(`https://workspace-events/${encodeURIComponent(workspaceId)}${SUBSCRIBE_PATH}`, {
        headers: { upgrade: 'websocket' },
      }),
    );
    const socket = res.webSocket;
    if (!socket) return null;
    socket.accept();
    return socket;
  } catch {
    return null;
  }
}
