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
