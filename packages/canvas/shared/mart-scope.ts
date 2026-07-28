// ADR-0017 guest scoping, one level below `worker/guest-gate.ts`: marts ARE guest-readable
// (a shared canvas has to render), but only the marts the shared canvas's OWN component
// instances reference — never the workspace's full mart list. Gating on "does this guest
// have access to some canvas" would make the whole mart namespace enumerable by anyone
// holding a share link. PURE — the same shape as `decideGuestGate`, unit-tested off no DB.

/** The set of mart names a canvas's own component instances reference, via their
 * `dataSource` (mart-contract.ts) — the guest confinement boundary for #238's mart route,
 * read off the AUTHORITATIVE representation: the canvas's sync-room snapshot (ADR-0019,
 * #289). The room — not `canvas-state.json` — is the source of truth once a canvas lives
 * in a Durable Object, and the R2 blob would answer with a shape list the canvas no
 * longer has (#289: a removed mart would still be served to a guest).
 *
 * Structurally typed (not `RoomSnapshot`) so this file stays free of `@tldraw/sync-core` —
 * it is imported by the pure guest-scoping path and unit-tested off plain objects. Records
 * are read defensively: a room document is schema-validated on the way IN, and this only
 * needs the two fields it names. */
export function martsInRoomSnapshot(snapshot: { documents: { state: unknown }[] }): Set<string> {
  const names = new Set<string>();
  for (const { state } of snapshot.documents) {
    const rec = state as { typeName?: string; type?: string; props?: { dataSource?: { kind?: string; name?: string } | null } };
    if (rec?.typeName !== 'shape' || rec.type !== 'component') continue;
    const source = rec.props?.dataSource;
    if (source?.kind === 'mart' && typeof source.name === 'string') names.add(source.name);
  }
  return names;
}
