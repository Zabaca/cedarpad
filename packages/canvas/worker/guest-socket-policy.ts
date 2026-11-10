import type { GuestCapabilities } from '../shared/guest-capabilities.ts';

/**
 * Per-connection write policy for a guest's sync socket (#320).
 *
 * `guest_interact` and `guest_edit` are different permissions, but tldraw sync gives a
 * session exactly ONE knob — `isReadonly` — so the handshake can only answer "may this
 * connection push at all". This module is the rest of the answer: for a connection that
 * may interact but not edit, every push is narrowed to the writes a component interaction
 * actually makes.
 *
 * Those writes are small and known (`src/ComponentShape.tsx`): `setData` patches
 * `props.data` on the component's own shape, and the host mirrors its lifecycle onto
 * `meta.status`. Everything else — moving, resizing, creating, deleting, repointing
 * `props.module`, bumping `props.rev` — is editing the document.
 *
 * The narrowing DROPS THE WHOLE DOCUMENT DIFF rather than filtering ops out of it, and
 * keeps presence. That is precisely what `TLSyncRoom` already does for a read-only session
 * (`if (message.diff && !session?.isReadonly)`), so a refused push is refused the way the
 * protocol already refuses one and the client rebases onto the server's state.
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
// The guest badge is the CONNECTION's, not the client's (#339)
// ---------------------------------------------------------------------------
//
// A guest shows in presence as `<name> (Guest)` and that mark is load-bearing: revoking a
// share link is a manual judgement call (#320), so a member has to NOTICE an outsider before
// they can act. The browser sets the mark itself (`src/presence.ts`, `tlUserFor`), which is
// fine for a guest who plays along and nothing at all for one who sends the record without it.
//
// So the room stamps it. Every push from a guest connection passes through here on its way
// to the room, and the `userName` it carries is made a marked one, whatever the client wrote.
// What is left to the client is the name a guest chose, never whether they are labelled.

/** The suffix the browser also uses; matching it makes the stamping idempotent, so a
 *  well-behaved client's own mark is kept rather than doubled. */
export const GUEST_SUFFIX = ' (Guest)';

/** A name that always reads as a guest's: trimmed, suffixed once, and the bare marked
 *  "Guest" when there is nothing usable (a missing, non-string, blank or already-bare one). */
export function markGuestName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (n === '' || n === 'Guest') return 'Guest';
  return n.endsWith(GUEST_SUFFIX) ? n : `${n}${GUEST_SUFFIX}`;
}

/**
 * The same message with its presence record's `userName` marked. A presence PUT carries the
 * whole record; a PATCH carries only the fields that changed, so it is touched only when it
 * touches `userName` (a patch that does not leaves the stored, already-marked name alone).
 * A name change by any op other than a plain `put` (a `delete`, an `append`) cannot be marked
 * without knowing the old value, so it becomes the bare marked "Guest".
 *
 * Non-push messages, and pushes with no presence, are returned untouched.
 */
export function markGuestPresence<T>(message: T): T {
  const msg = message as { type?: unknown; presence?: unknown };
  if (!msg || typeof msg !== 'object' || msg.type !== 'push') return message;
  const presence = msg.presence;
  if (!Array.isArray(presence)) return message;

  if (presence[0] === 'put') {
    const record = presence[1];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return message;
    const marked = { ...(record as Record<string, unknown>), userName: markGuestName((record as { userName?: unknown }).userName) };
    return { ...msg, presence: ['put', marked] } as T;
  }

  if (presence[0] === 'patch') {
    const diff = presence[1];
    if (!diff || typeof diff !== 'object' || Array.isArray(diff) || !('userName' in diff)) return message;
    const op = (diff as Record<string, unknown>).userName;
    const next = isOp(op) && op[0] === 'put' ? markGuestName(op[1]) : 'Guest';
    return { ...msg, presence: ['patch', { ...(diff as Record<string, unknown>), userName: ['put', next] }] } as T;
  }

  return message;
}

/**
 * What a guest connection's message becomes before the room sees it: narrowed to what its
 * capabilities allow (when it may only interact), then its presence badge stamped. The
 * Durable Object calls this for every message from a guest and nothing else touches them.
 */
export function applyGuestPolicy<T>(message: T, opts: { interactOnly: boolean }): T {
  return markGuestPresence(opts.interactOnly ? narrowInteractPush(message) : message);
}
