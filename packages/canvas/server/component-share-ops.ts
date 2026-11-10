// The shared-library membership operations, each pairing the on-disk move/copy with the
// reload that makes it visible. promote and adopt are TWO-step operations — move the file,
// then rev-bump every canvas that placed it — and forgetting the second step leaves the
// component changed on disk but stale in the store. These functions make the pairing a
// single call the tool and the HTTP route both go through, so the reload can't be dropped.
// The reload is injected (a `() => number` the caller supplies) so this stays decoupled from
// the store/canvas-ops layer.

import { adoptSharedComponent, type ComponentRecords, componentRecordStore, promoteComponent } from './components.ts';

/** Move a component from a canvas's own dir into the shared library, then reload. Returns the
 * reload count (canvases that placed it and were rev-bumped). Reload fires only on a clean move. */
export async function promoteToShared(
  canvasId: string,
  module: string,
  reload: () => number,
  records: ComponentRecords | null = componentRecordStore,
): Promise<number> {
  await promoteComponent(canvasId, module, records);
  return reload();
}

/** Copy a shared component back into a canvas's own dir (diverge), then reload that canvas's
 * placed instances. Returns the reload count. Reload fires only on a clean copy. */
export async function adoptFromShared(
  canvasId: string,
  module: string,
  reload: () => number,
  records: ComponentRecords | null = componentRecordStore,
): Promise<number> {
  await adoptSharedComponent(canvasId, module, records);
  return reload();
}
