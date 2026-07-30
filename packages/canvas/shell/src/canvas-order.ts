// The canvas picker's hand-arranged order.
//
// Stored as ONE array of canvas ids on the workspace, not as a sort column per canvas row.
// The reason is the legacy `default` canvas: it has no registry row at all (#179 seeded
// production's workspace by hand and the canvas predates the registry), so a per-row column
// could never describe where it sits, and it would need special-casing forever. In an id
// array it is simply an id.
//
// The order is a HINT, not a schema. It is written by clients, it can name canvases that
// were since deleted, and it will not know about canvases created after it was written —
// by a teammate, or by you on another device. So every function here is total: it answers
// something sensible for any input rather than trusting what it is given.

/** Ids from the stored JSON text. Unreadable ⇒ no order, never a throw: this is a
 *  preference, and a read that throws would take the whole canvas picker down with it. */
export function parseCanvasOrder(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Arrange `rows` by `order`.
 *
 * Two rules carry the behavior:
 *
 * - An id in `order` that no longer names a canvas is DROPPED. A deleted canvas must not
 *   leave a gap or a ghost row.
 * - A canvas `order` has never seen goes to the END, in the order the server sent it. It
 *   has to appear — it may be the one you just made, or a teammate's — but pushing it to
 *   the front would rearrange a list somebody deliberately arranged.
 *
 * An empty order therefore returns the server's own order untouched, which is `created_at`
 * ascending: a workspace that has never reordered sees no change at all.
 */
export function applyCanvasOrder<T extends { id: string }>(order: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: T[] = [];
  const taken = new Set<string>();
  for (const id of order) {
    const row = byId.get(id);
    // `taken` guards a duplicated id in a bad write — one row on screen, not two.
    if (row && !taken.has(id)) {
      out.push(row);
      taken.add(id);
    }
  }
  for (const row of rows) if (!taken.has(row.id)) out.push(row);
  return out;
}

/** `ids` with the item at `from` moved to `to`. What one drag produces. */
export function moved(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...ids];
  next.splice(to, 0, item);
  return next;
}
