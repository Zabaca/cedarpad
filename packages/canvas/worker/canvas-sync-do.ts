import {
  DurableObjectSqliteSyncWrapper,
  JsonChunkAssembler,
  SQLiteSyncStorage,
  type SessionStateSnapshot,
  type TLSocketRoom,
} from '@tldraw/sync-core';
import type { TLRecord } from '@tldraw/tlschema';

import { CanvasMutation, mutationError } from '../shared/canvas-mutation.ts';
import { readGuestCapabilities } from '../shared/guest-capabilities.ts';
import { applyMutation, MutationRejected } from './canvas-mutate.ts';
import { applyGuestPolicy, isInteractOnly } from './guest-socket-policy.ts';
import type { Env } from './index.ts';
import { handleSnapshotRequest } from './snapshot-io.ts';
import { isReadonlyRequest, SYNC_GUEST_CAPS_HEADER, SYNC_GUEST_LINK_HEADER, SYNC_USER_HEADER } from './sync-api.ts';
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
  /** #320: this connection may write component data and nothing else. It rides in the
   *  attachment because it is a property of the CONNECTION — established at the handshake
   *  from the link's capabilities — and it has to survive hibernation with the socket. */
  interactOnly?: boolean;
  /** #339: this connection is a guest's. Every message it sends passes through
   *  `applyGuestPolicy` (the presence badge is stamped here, not trusted to the client). It
   *  rides the attachment because it is a property of the CONNECTION and has to survive
   *  hibernation. Attachments written before this field existed are guests when they carry
   *  a `linkId`; see `isGuestSocket`. */
  guest?: boolean;
  /** #320: which share link admitted this guest connection. Absent on a member's. It is
   *  not identity (that is `meta.userId`) — it is the handle revocation drops sockets by,
   *  and it rides the attachment because it must survive hibernation with the socket. */
  linkId?: string;
  snapshot?: SessionStateSnapshot;
}

/** Is this connection a guest's? `guest` is the field; `linkId` covers a socket that
 *  hibernated with an attachment written before `guest` existed. A member carries neither. */
export function isGuestSocket(a: Pick<SocketAttachment, 'guest' | 'linkId'>): boolean {
  return a.guest === true || a.linkId !== undefined;
}

/**
 * The connections a revoked share link opened (#320 §5). Pure over the socket list so the
 * selection — the part where a mistake either leaves the revoked guest connected or
 * disconnects innocent members — is testable without a Durable Object.
 */
export function socketsForLink(sockets: WebSocket[], linkId: string): WebSocket[] {
  return sockets.filter((ws) => (ws.deserializeAttachment() as SocketAttachment | null)?.linkId === linkId);
}

// Deliberately NOT `extends DurableObject` from 'cloudflare:workers'. The Workers runtime
// accepts any class with a `(state, env)` constructor as a DO, and that import is
// unresolvable outside workerd — which would break `bun test` for EVERY suite that
// transitively imports worker/index.ts (where this class must be re-exported for wrangler
// to find it). The base class buys only `this.ctx`/`this.env`, both trivially held here.
export class CanvasSyncRoom {
  private readonly room: TLSocketRoom<TLRecord, SyncSessionMeta>;
  protected readonly ctx: DurableObjectState;
  /** Chunk reassembly for the sessions whose messages we have to READ before forwarding
   *  (guests: #320 narrowing, #339 presence badge). Members' messages are forwarded untouched. */
  private readonly assemblers = new Map<string, JsonChunkAssembler>();

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
    // Identity arrives ONLY as the headers `handleSyncUpgrade` stamps after authorizing.
    // The DO is unreachable except through that handler, so their absence is a bug, not an
    // anonymous user — fail closed rather than host a session with no owner.
    //
    // A connection is a MEMBER's (user header) or a GUEST's (capability header), never
    // both: the Worker always writes one and deletes the other. The guest's capabilities
    // are parsed here on the receiving side of the boundary (CLAUDE.md §7) — a trusted hop
    // is not a reason to trust a payload — and anything that fails to parse is no
    // capabilities at all (#320).
    const userId = request.headers.get(SYNC_USER_HEADER);
    const guestCaps = request.headers.has(SYNC_GUEST_CAPS_HEADER)
      ? readGuestCapabilities(request.headers.get(SYNC_GUEST_CAPS_HEADER))
      : null;
    if (!userId && !guestCaps) return new Response('unauthorized', { status: 401 });

    // The agent write path (#291). Matched on the suffix rather than by importing
    // `parseCanvasMutatePath`, which would close a runtime import cycle back through
    // worker/index.ts (where this class is re-exported for wrangler). The authoritative
    // route match already happened in the Worker; this only picks the branch.
    const url = new URL(request.url);
    // Both doors below are the container's and the admin's, reached with a member/service
    // credential. A guest connection has no business on either — and re-opening one for a
    // guest is exactly the #297 shape (a guest's write authored as the container).
    if (url.pathname.endsWith('/mutate')) {
      return userId ? this.mutate(request) : new Response('unauthorized', { status: 401 });
    }

    // The migration door (#295), matched the same way and for the same reason. The
    // admin gate already ran in the Worker (`handleCanvasSnapshot`); this only routes.
    if (url.pathname.endsWith('/snapshot')) {
      return userId ? handleSnapshotRequest(this.room, request) : new Response('unauthorized', { status: 401 });
    }

    // Revocation reaching the OPEN sockets (#320 §5). The member gate ran in the Worker
    // (`handleShareLinksApi` resolved the canvas through their workspace); this is the
    // member's door like the two above, so a guest connection cannot reach it.
    if (url.pathname.endsWith('/evict')) {
      if (!userId) return new Response('unauthorized', { status: 401 });
      const linkId = url.searchParams.get('linkId');
      if (!linkId) return new Response('linkId required', { status: 400 });
      this.evict(linkId);
      return new Response(null, { status: 204 });
    }

    // The read-only decision arrives the same way identity does — stamped by
    // `handleSyncUpgrade`, never client-supplied (#294). A guest holds a capability to
    // READ one canvas, and sync-core drops a read-only session's document diffs inside
    // the room, so the confinement is the server's, not the browser's. Nothing else
    // about the session differs: it still receives every member edit.
    const readonly = isReadonlyRequest(request);
    const sessionId = url.searchParams.get('sessionId') ?? crypto.randomUUID();
    // #320: a guest writes as `guest:<sessionId>`, minted HERE because the sessionId is a
    // property of this connection and nothing upstream knows it. Two guests holding one
    // link are therefore distinguishable in presence and history — which the old
    // `guest:<linkId>` identity could not do, and which is what makes the manual "notice
    // then revoke" enforcement possible at all.
    const identity = userId ?? `guest:${sessionId}`;
    const interactOnly = !!guestCaps && isInteractOnly(guestCaps);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.admit(server, {
      sessionId,
      identity,
      readonly,
      interactOnly,
      guest: !!guestCaps,
      // `||`, not `??`: an empty header is not a link id, and storing `''` would attach a
      // connection no revocation could ever name.
      linkId: guestCaps ? request.headers.get(SYNC_GUEST_LINK_HEADER) || undefined : undefined,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Put an accepted socket into the room. tldraw REUSES a session id across reconnects (the client
   * keeps it), so the guest assembler a previous socket of the same session left half-way through
   * a chunked message is dropped here: otherwise the new socket's first message (its `connect`) is
   * an error to a stale assembler and the guest is refused (1008) before they are in.
   */
  private admit(
    server: WebSocket,
    p: { sessionId: string; identity: string; readonly: boolean; interactOnly: boolean; guest: boolean; linkId: string | undefined },
  ): void {
    this.ctx.acceptWebSocket(server);
    this.attach(server, {
      sessionId: p.sessionId,
      meta: { userId: p.identity },
      interactOnly: p.interactOnly,
      ...(p.guest ? { guest: true, linkId: p.linkId } : {}),
    });
    this.assemblers.delete(p.sessionId);
    this.room.handleSocketConnect({ sessionId: p.sessionId, socket: server, isReadonly: p.readonly, meta: { userId: p.identity } });
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
    if (!a) return;
    // Members' messages are forwarded untouched. A guest's pass through `applyGuestPolicy`:
    // narrowed to what its capabilities allow (#320) and its presence badge stamped (#339).
    if (!isGuestSocket(a)) return this.room.handleSocketMessage(a.sessionId, message);
    // We have to assemble chunks before we can read one, so a guest session gets its own
    // assembler. It lives as long as the room's own (both in-memory, both rebuilt on a wake), so
    // it adds no failure mode a hibernation did not already have.
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let res: ReturnType<JsonChunkAssembler['handleMessage']>;
    try {
      res = this.assemblerFor(a.sessionId).handleMessage(raw);
    } catch {
      // A message that opens like JSON and is not (`{` then garbage) throws in the assembler.
      res = { error: new Error('unparseable message') };
    }
    if (!res) return; // more chunks to come
    // NEVER forward what could not be assembled. Our assembler and the room's are separate, so a
    // message ours rejects (a chunk header, then a whole push) is one the room's idle assembler
    // would accept, and it would reach the room without the policy: an unmarked badge, or a
    // document diff an interact-only guest may not push. A guest that sends something no
    // honest client sends is dropped: the session ends and the client reconnects clean.
    if (!('data' in res)) return this.drop(ws, a, 'invalid message');
    // What the guest has in presence is what the ROOM holds, not what this class last forwarded: the room only
    // accepts presence from a connected session and ignores a push sent before `connect`, so a flag kept here
    // could say "has a record" about one that does not exist. `getSessionSnapshot` is null until the session is
    // connected, then carries the record (and survives a wake: sync-core restores it), and costs a map lookup.
    const held = this.room.getSessionSnapshot(a.sessionId)?.presenceRecord as { userName?: unknown } | null | undefined;
    const out = applyGuestPolicy(res.data, {
      interactOnly: !!a.interactOnly,
      identity: a.meta.userId,
      now: Date.now(),
      hasPresence: held != null,
      lastName: typeof held?.userName === 'string' ? held.userName : undefined,
      pageId: () => this.currentPageId(),
    });
    this.room.handleSocketMessage(a.sessionId, JSON.stringify(out.message));
  }

  /** The room's first page, which a guest's default presence record sits on (a canvas has one). */
  private currentPageId(): string | undefined {
    return this.room.getCurrentSnapshot().documents.find((d) => d.state.typeName === 'page')?.state.id;
  }

  /** End a connection. The room is told first, so the session is gone from its state before the
   *  socket dies; 1008 (policy violation) rather than a plain close, so a client does not read it
   *  as a blip and reconnect-loop. Used for a guest that broke the protocol and for revocation. */
  private drop(ws: WebSocket, a: SocketAttachment | null, reason: string): void {
    if (a) {
      this.assemblers.delete(a.sessionId);
      this.room.handleSocketClose(a.sessionId);
    }
    ws.close(1008, reason);
  }

  /**
   * Close every connection a revoked link opened (#320 §5). Revocation was already a
   * tombstone that stops the NEXT connect, but capabilities ride the handshake, so a guest
   * already on the socket kept their grants indefinitely — revoke did nothing at the one
   * moment you reach for it. The room is told first, so the session is gone from its state
   * before the socket dies; 1008 (policy violation) rather than a plain close, so the
   * client does not read it as a blip and reconnect-loop.
   */
  private evict(linkId: string): void {
    for (const ws of socketsForLink(this.ctx.getWebSockets(), linkId)) this.drop(ws, this.attachmentOf(ws), 'share link revoked');
  }

  private assemblerFor(sessionId: string): JsonChunkAssembler {
    let assembler = this.assemblers.get(sessionId);
    if (!assembler) this.assemblers.set(sessionId, (assembler = new JsonChunkAssembler()));
    return assembler;
  }

  webSocketClose(ws: WebSocket) {
    const a = this.attachmentOf(ws);
    if (!a) return;
    this.assemblers.delete(a.sessionId);
    this.room.handleSocketClose(a.sessionId);
  }

  webSocketError(ws: WebSocket) {
    const a = this.attachmentOf(ws);
    if (!a) return;
    this.assemblers.delete(a.sessionId);
    this.room.handleSocketClose(a.sessionId);
  }
}
