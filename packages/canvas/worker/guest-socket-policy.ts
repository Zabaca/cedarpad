import { InstancePresenceRecordType } from '@tldraw/tlschema';

import type { GuestCapabilities } from '../shared/guest-capabilities.ts';
import { GUEST_BARE_NAME, guestColor, markGuestName } from '../shared/guest-mark.ts';

/**
 * Per-connection policy for a guest's sync socket: what it may write (#320) and what it may say
 * about itself in presence (#339).
 *
 * WRITES. `guest_interact` and `guest_edit` are different permissions, but tldraw sync gives a
 * session exactly ONE knob, read-only, so the handshake can only answer "may this connection push
 * at all". For a connection that may interact but not edit, every push is narrowed here to the
 * writes a component interaction actually makes.
 *
 * Those writes are small and known (`src/ComponentShape.tsx`): `setData` patches `props.data` on
 * the component's own shape, and the host mirrors its lifecycle onto `meta.status`. Everything
 * else (moving, resizing, creating, deleting, repointing `props.module`, bumping `props.rev`) is
 * editing the document. The narrowing DROPS THE WHOLE DOCUMENT DIFF rather than filtering ops out
 * of it. That is precisely what `TLSyncRoom` already does for a read-only session
 * (`if (message.diff && !session?.isReadonly)`), so a refused push is refused the way the
 * protocol already refuses one and the client rebases onto the server's state.
 *
 * PRESENCE. A guest's presence is stamped from the connection, not trusted from the client: see
 * the section at the end of this file. Presence is kept through the narrowing, never dropped.
 *
 * PURE, so it is unit-testable off a room and off a socket. The Durable Object owns the
 * wiring; this owns the decision.
 */

/** Which connections get narrowed. A guest who may edit needs no narrowing; a guest who
 *  may do neither is already read-only in the room, which is a stronger stop than this. */
export function isInteractOnly(caps: GuestCapabilities): boolean {
  return caps.interact && !caps.editCanvas;
}

type ValueOp = [string, ...unknown[]];
const isOp = (v: unknown): v is ValueOp => Array.isArray(v) && typeof v[0] === 'string';

/** A `patch` that only SETS keys in `allowed`. `delete`/`append` are refused even on an
 *  allowed key: removing a component's data is not using it. */
function isPatchLimitedTo(op: unknown, allowed: readonly string[]): boolean {
  if (!isOp(op) || op[0] !== 'patch') return false;
  const inner = op[1];
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return false;
  return Object.entries(inner as Record<string, unknown>).every(
    ([k, v]) => allowed.includes(k) && isOp(v) && (v[0] === 'put' || v[0] === 'patch'),
  );
}

/** One record's op, judged on its own: a patch to this shape's component data or status. */
function isInteraction(id: string, op: unknown): boolean {
  if (!id.startsWith('shape:')) return false;
  if (!isOp(op) || op[0] !== 'patch') return false;
  const fields = op[1];
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  return Object.entries(fields as Record<string, unknown>).every(([field, fieldOp]) => {
    if (field === 'props') return isPatchLimitedTo(fieldOp, ['data']);
    if (field === 'meta') return isPatchLimitedTo(fieldOp, ['status']);
    return false;
  });
}

/**
 * The message an interact-only connection is actually allowed to send. Returns the message
 * unchanged when every op in its document diff is an interaction; otherwise the same
 * message with the document diff removed. Non-push messages pass through untouched.
 */
export function narrowInteractPush<T>(message: T): T {
  const msg = message as { type?: unknown; diff?: unknown };
  if (!msg || typeof msg !== 'object' || msg.type !== 'push') return message;
  const { diff } = msg;
  const permitted =
    !!diff &&
    typeof diff === 'object' &&
    !Array.isArray(diff) &&
    Object.entries(diff as Record<string, unknown>).every(([id, op]) => isInteraction(id, op));
  if (permitted) return message;
  const { diff: _dropped, ...rest } = msg;
  return rest as T;
}

// ---------------------------------------------------------------------------
// A guest's presence is the CONNECTION's, not the client's (#339)
// ---------------------------------------------------------------------------
//
// What a member sees of a guest, the name, the colour, whether they are there at all, is
// presence, and presence is what a client sends. Revoking a share link is a manual judgement
// call (#320), so a member has to NOTICE an outsider before they can act, and a guest who can
// choose how they look can choose not to be noticed:
//
//   userName            drop the "(Guest)" mark, or push it out of a truncated label
//   lastActivityTimestamp  1: tldraw hides a collaborator inactive for more than a minute, from the
//                       people menu and from the cursors
//   userId              a member's id: each viewer drops presence carrying its own id
//   color               white on white, or not a colour at all, so the label cannot be read
//   chatMessage         takes the name-tag slot ("Maple Street Crew")
//
// So the room owns those fields. Every push from a guest connection passes through here on its
// way to the room, and each is set from what the SERVER knows: the name is marked (and the guest's
// chosen part kept, capped and cleaned), the timestamp is the room's own clock at the push, the
// id is the connection's identity (`guest:<sessionId>`), the colour is from a fixed palette keyed
// by that identity, and the chat message is empty. A patch is treated like the put it amends: it
// is stamped when it touches a field, and every presence push counts as activity. What is left to
// the client is the name a guest chose, the cursor and the camera.

/** What the room knows about the connection a presence push came in on. */
export interface GuestPresenceContext {
  /** The connection's identity, `guest:<sessionId>` (minted by the room, never by the client). */
  identity: string;
  /** The room's clock, milliseconds. */
  now: number;
  /** The `userName` last forwarded for this session, which an `append` is resolved against. */
  lastName?: string | undefined;
  /** Whether the room holds a presence record for this session yet. Without one a patch has nothing
   *  to amend and the guest is not shown to members at all, however much they edit. */
  hasPresence?: boolean | undefined;
  /** The room's current page, which a default record sits on. A function so it is looked up only when a default
   *  record is built (reading it decodes the document). Falls back to `page:page`. */
  pageId?: (() => string | undefined) | undefined;
}

/** The `userId` a guest's presence carries. tldraw's schema wants a `user:` id, so the connection's
 *  identity is wrapped in one: `user:guest:<sessionId>`. */
export const presenceUserId = (identity: string): string => `user:${identity}`;

export interface StampedPush<T> {
  message: T;
  /** The `userName` this push leaves the session with, when it set one. Absent otherwise. */
  userName?: string;
}

/** The record a guest gets when they edit before ever sending presence: a valid `instance_presence`
 *  (tldraw's own constructor fills the rest) at the origin, so members see who is working. The client's own first presence
 *  replaces it. The id is the room's to set (sync-core overwrites it). */
function defaultPresence(ctx: GuestPresenceContext): Record<string, unknown> {
  return InstancePresenceRecordType.create({
    id: InstancePresenceRecordType.createId('guest'),
    userId: presenceUserId(ctx.identity) as never,
    userName: GUEST_BARE_NAME,
    lastActivityTimestamp: ctx.now,
    color: guestColor(ctx.identity),
    currentPageId: (ctx.pageId?.() ?? 'page:page') as never,
  }) as unknown as Record<string, unknown>;
}

/**
 * The same message with its presence stamped from the connection (see the section above), and the
 * name it leaves the session with. A presence PUT carries the whole record: every owned field is
 * set. A PATCH carries only what changed: it is stamped when it touches an owned field, and always
 * carries the room's timestamp. A name change that is not a plain `put` (a `delete`, an `append` that
 * does not extend the name last forwarded) cannot be marked and becomes the bare "Guest"; an
 * `append` that does extend it, which is what a browser sends as its guest types, is applied to it.
 *
 * A push with NO presence (a document-only edit) is activity too: it gains a timestamp patch, or, for a
 * session with no record yet (`ctx.hasPresence === false`), a first put of a default record, so a guest who
 * only edits is still shown to members. Non-push messages are returned untouched.
 */
export function stampGuestPresence<T>(message: T, ctx: GuestPresenceContext): StampedPush<T> {
  const msg = message as { type?: unknown; presence?: unknown };
  if (!msg || typeof msg !== 'object' || msg.type !== 'push') return { message };
  const presence = msg.presence;
  const color = guestColor(ctx.identity);

  // EVERY guest push is activity, and a guest with no record is not shown at all: so a push with no
  // presence (a document-only edit) carries the room's timestamp as a patch, or, before the session has
  // a record, a first put of a default one. A patch with nothing to amend becomes that put too.
  //
  // The room IGNORES a presence it cannot read and still applies the push's document diff, so anything that is
  // not a well-formed put or patch counts as missing here too, or a hand-written push would edit unseen.
  const kind = presenceKind(presence);
  const orphanPatch = kind === 'patch' && ctx.hasPresence === false;
  if ((kind === 'missing' || orphanPatch) && ctx.hasPresence === false) {
    return { message: { ...msg, presence: ['put', defaultPresence(ctx)] } as T, userName: GUEST_BARE_NAME };
  }
  if (kind === 'missing') {
    return { message: { ...msg, presence: ['patch', { lastActivityTimestamp: ['put', ctx.now] }] } as T };
  }
  // From here the presence is a well-formed put or patch (`presenceKind`).
  const [op, body] = presence as [string, Record<string, unknown>];

  if (op === 'put') {
    const userName = markGuestName(body.userName);
    const stamped = {
      ...body,
      userName,
      userId: presenceUserId(ctx.identity),
      lastActivityTimestamp: ctx.now,
      color,
      chatMessage: '',
    };
    return { message: { ...msg, presence: ['put', stamped] } as T, userName };
  }

  const patch: Record<string, unknown> = { ...body, lastActivityTimestamp: ['put', ctx.now] };
  let userName: string | undefined;
  if ('userName' in patch) {
    const op = patch.userName;
    userName = isOp(op) && op[0] === 'put' ? markGuestName(op[1]) : resolveAppend(op, ctx.lastName);
    patch.userName = ['put', userName];
  }
  if ('userId' in patch) patch.userId = ['put', presenceUserId(ctx.identity)];
  if ('color' in patch) patch.color = ['put', color];
  if ('chatMessage' in patch) patch.chatMessage = ['put', ''];
  return { message: { ...msg, presence: ['patch', patch] } as T, ...(userName !== undefined ? { userName } : {}) };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a push's `presence` is: a well-formed put (a record object), a well-formed patch (a diff object), or
 *  `missing`, which is everything else (absent, null, a remove, an unknown op, a put or patch with no object). */
function presenceKind(presence: unknown): 'put' | 'patch' | 'missing' {
  if (!Array.isArray(presence)) return 'missing';
  if (presence[0] === 'put' && isPlainObject(presence[1])) return 'put';
  if (presence[0] === 'patch' && isPlainObject(presence[1])) return 'patch';
  return 'missing';
}

/** `['append', ' Quill', 11]` extends the name last forwarded when it starts where that name
 *  ends; anything else (no name to extend, a different offset, `delete`) is the bare "Guest". */
function resolveAppend(op: unknown, last: string | undefined): string {
  if (isOp(op) && op[0] === 'append' && typeof op[1] === 'string' && typeof last === 'string' && op[2] === last.length) {
    return markGuestName(last + op[1]);
  }
  return GUEST_BARE_NAME;
}

/**
 * What a guest connection's message becomes before the room sees it: narrowed to what its
 * capabilities allow (when it may only interact), then its presence stamped from the connection.
 * The Durable Object calls this for every message from a guest and nothing else touches them.
 */
export function applyGuestPolicy<T>(
  message: T,
  opts: { interactOnly: boolean } & GuestPresenceContext,
): StampedPush<T> {
  return stampGuestPresence(opts.interactOnly ? narrowInteractPush(message) : message, opts);
}
