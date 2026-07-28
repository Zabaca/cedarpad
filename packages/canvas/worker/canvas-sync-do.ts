import {
  DurableObjectSqliteSyncWrapper,
  SQLiteSyncStorage,
  type SessionStateSnapshot,
  type TLSocketRoom,
} from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { CanvasMutation, mutationError } from '../shared/canvas-mutation.ts';
import { applyMutation, MutationRejected } from './canvas-mutate.ts';
import type { Env } from './index.ts';
import { handleSnapshotRequest } from './snapshot-io.ts';
import { isReadonlyRequest, SYNC_USER_HEADER } from './sync-api.ts';
import { createCanvasSyncRoom, type SyncSessionMeta } from './sync-room.ts';

// The Durable Object that hosts a canvas's `TLSocketRoom` (ADR-0019). Shape follows
// tldraw's `tldraw-sync-cloudflare` template; the two deviations are deliberate:
//
//   1. PERSISTENCE IS DO SQLITE, not an R2 snapshot blob. sync-core 5.2.5 ships
//      `SQLiteSyncStorage` + `DurableObjectSqliteSyncWrapper` for exactly this, so the
//      room's documents/tombstones/clock ARE the DO's SQLite tables — written inside the
//      same transaction as the mutation, not debounced to a blob afterwards. Eviction and
//      restart therefore cost nothing: the next constructor reads the same tables and
//      clients resume from their last clock instead of re-downloading from version -1.
//      This is what ADR-0019 objected to about `canvas-state.json`.
//
//   2. HIBERNATION IS ON. Sockets are accepted with `ctx.acceptWebSocket`, so an idle
//      room with connected tabs can be evicted without dropping them. Per-session state
//      rides in the socket's attachment (`onSessionSnapshot` → `serializeAttachment`) and
//      is restored on wake with `handleSocketResume`, which is the API sync-core added in
//      5.2.5 for this. Document state needs no such care — it is already in SQLite.

/** What we keep on each hibernatable socket. `meta` is stamped by the Worker, never the client. */
interface SocketAttachment {
  sessionId: string;
  meta: SyncSessionMeta;
  snapshot?: SessionStateSnapshot;
}

// Deliberately NOT `extends DurableObject` from 'cloudflare:workers'. The Workers runtime
// accepts any class with a `(state, env)` constructor as a DO, and that import is
// unresolvable outside workerd — which would break `bun test` for EVERY suite that
// transitively imports worker/index.ts (where this class must be re-exported for wrangler
// to find it). The base class buys only `this.ctx`/`this.env`, both trivially held here.
export class CanvasSyncRoom {
  private readonly room: TLSocketRoom<TLRecord, SyncSessionMeta>;
  protected readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx;
    this.room = createCanvasSyncRoom({
      storage: new SQLiteSyncStorage({ sql: new DurableObjectSqliteSyncWrapper(ctx.storage) }),
      // Persist each session's state into its own socket attachment, so a wake can resume
      // it. sync-core calls this after 5s of session inactivity — i.e. exactly the state
      // that would be lost to an eviction.
      onSessionSnapshot: (sessionId, snapshot) => {
        const ws = this.socketFor(sessionId);
        if (!ws) return;
        this.attach(ws, { ...(this.attachmentOf(ws) as SocketAttachment), snapshot });
      },
    });
    // Wake path: the sockets outlived the isolate, the room did not. Resume every session
    // whose snapshot we kept; a socket without one predates its first snapshot and is
    // dropped rather than silently desynced — the client reconnects.
    for (const ws of ctx.getWebSockets()) {
      const a = this.attachmentOf(ws);
      if (!a?.snapshot) {
        ws.close(1012, 'server restarted');
        continue;
      }
      this.room.handleSocketResume({ sessionId: a.sessionId, socket: ws, snapshot: a.snapshot, meta: a.meta });
    }
  }

  private attachmentOf(ws: WebSocket): SocketAttachment | null {
    return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
  }

  private attach(ws: WebSocket, a: SocketAttachment) {
    ws.serializeAttachment(a);
  }

  private socketFor(sessionId: string): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => this.attachmentOf(ws)?.sessionId === sessionId);
  }

  async fetch(request: Request): Promise<Response> {
    // Identity arrives ONLY as the header `handleSyncUpgrade` stamps after authorizing.
    // The DO is unreachable except through that handler, so an absent header is a bug,
    // not an anonymous user — fail closed rather than host a session with no owner.
    const userId = request.headers.get(SYNC_USER_HEADER);
    if (!userId) return new Response('unauthorized', { status: 401 });

    // The agent write path (#291). Matched on the suffix rather than by importing
    // `parseCanvasMutatePath`, which would close a runtime import cycle back through
    // worker/index.ts (where this class is re-exported for wrangler). The authoritative
    // route match already happened in the Worker; this only picks the branch.
    const url = new URL(request.url);
    if (url.pathname.endsWith('/mutate')) return this.mutate(request);

    // The migration door (#295), matched the same way and for the same reason. The
    // admin gate already ran in the Worker (`handleCanvasSnapshot`); this only routes.
    if (url.pathname.endsWith('/snapshot')) return handleSnapshotRequest(this.room, request);

    // The read-only decision arrives the same way identity does — stamped by
    // `handleSyncUpgrade`, never client-supplied (#294). A guest holds a capability to
    // READ one canvas, and sync-core drops a read-only session's document diffs inside
    // the room, so the confinement is the server's, not the browser's. Nothing else
    // about the session differs: it still receives every member edit.
    const readonly = isReadonlyRequest(request);
    const sessionId = url.searchParams.get('sessionId') ?? crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.attach(server, { sessionId, meta: { userId } });
    this.room.handleSocketConnect({ sessionId, socket: server, isReadonly: readonly, meta: { userId } });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Apply one agent mutation to the live room. The contract is parsed AGAIN here, on the
   * receiving side of the boundary (CLAUDE.md §7) — the Worker parsed it before choosing
   * this DO, but the room must not trust a payload just because it arrived over a
   * trusted hop. `applyMutation` writes through `room.updateStore()`, so tldraw validates
   * every record before it is persisted (ADR-0019, "The write API").
   */
  private async mutate(request: Request): Promise<Response> {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'body must be JSON' }, 400);
    }
    const parsed = CanvasMutation.safeParse(body);
    if (!parsed.success) return json({ error: mutationError(parsed.error) }, 400);
    try {
      return json(await applyMutation(this.room, parsed.data));
    } catch (e) {
      // A refused write, not a broken room: `updateStore` is transactional, so nothing
      // was persisted. 400 so the agent gets the reason back and can correct its intent.
      if (e instanceof MutationRejected) return json({ error: e.message }, 400);
      throw e;
    }
  }

  // Hibernation delivers socket events as class methods, not listeners — the room is
  // driven from here rather than from the `addEventListener` path it would use elsewhere.
  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    const a = this.attachmentOf(ws);
    if (a) this.room.handleSocketMessage(a.sessionId, message);
  }

  webSocketClose(ws: WebSocket) {
    const a = this.attachmentOf(ws);
    if (a) this.room.handleSocketClose(a.sessionId);
  }

  webSocketError(ws: WebSocket) {
    const a = this.attachmentOf(ws);
    if (a) this.room.handleSocketClose(a.sessionId);
  }
}
