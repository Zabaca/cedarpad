// ADR-0017 guest scoping, one level below `worker/guest-gate.ts`: marts ARE guest-readable
// (a shared canvas has to render), but only the marts the shared canvas's OWN component
// instances reference — never the workspace's full mart list. Gating on "does this guest
// have access to some canvas" would make the whole mart namespace enumerable by anyone
// holding a share link. PURE — the same shape as `decideGuestGate`, unit-tested off no DB.

import type { CanvasState } from '../src/shapes.ts';

/** The set of mart names `canvasState`'s own component instances reference, via their
 * `dataSource` (mart-contract.ts). This — not the workspace's mart list — is the guest
 * confinement boundary for #238's mart route. */
export function martsReferencedBy(canvasState: CanvasState): Set<string> {
  const names = new Set<string>();
  for (const shape of canvasState.shapes) {
    if (shape.type === 'component' && shape.dataSource?.kind === 'mart') {
      names.add(shape.dataSource.name);
    }
  }
  return names;
}
