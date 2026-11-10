// The three-tier component LISTING, answered at the edge (ADR-0022, #363). Own and shared
// come from Records; the platform tier comes from the build-time manifest, because base
// Components are image-only code the edge can never read off a filesystem.
//
// It lives beside `component-store.ts` rather than inside it because the two answer different
// questions: `ComponentStore` is policy over the Record port and knows only the two WRITABLE
// tiers, while a catalog necessarily spans all three — the one place the image manifest and
// the store meet.

import { leadingComment } from '../shared/component-description.ts';
import type { ComponentCatalogEntry } from '../shared/platform-rpc.ts';
import { BASE_COMPONENTS } from './base-manifest.generated.ts';
import type { RecordStore } from './record-store.ts';

/**
 * Every Component a canvas can see, by name, with the tier it RESOLVES in.
 *
 * Precedence is own → shared → base, first match wins (PRD #354 story 41) — the same walk
 * `readComponent` does, so a name listed as `own` is the source that canvas actually loads.
 * The tier label is not decoration: callers use it for duplicate-avoidance, and an entry
 * labelled with the wrong tier sends the next edit into the wrong library.
 */
export async function componentCatalog(
  records: RecordStore,
  scope: { workspaceId: string; canvasId: string },
  base: ReadonlyArray<{ name: string; description: string }> = BASE_COMPONENTS,
): Promise<ComponentCatalogEntry[]> {
  const [own, shared] = await Promise.all([
    records.list({ workspaceId: scope.workspaceId, canvasId: scope.canvasId }),
    records.list({ workspaceId: scope.workspaceId, canvasId: null }),
  ]);
  const byName = new Map<string, ComponentCatalogEntry>();
  const add = (entry: ComponentCatalogEntry) => {
    // First writer wins, and the tiers are visited in precedence order — so a canvas that
    // shadowed a shared or platform Component is listed as owning it.
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  };
  for (const tier of ['own', 'shared'] as const) {
    for (const row of tier === 'own' ? own : shared) {
      // Data files share the table with Components (`kind`); they are siblings a Component
      // imports, never something to place, so they are not in the library.
      if (row.kind !== 'component') continue;
      add({ name: row.name, description: leadingComment(row.source), tier });
    }
  }
  for (const b of base) add({ ...b, tier: 'base' });
  // Code-unit order, which is what the container's own listing has always used (`Array#sort`
  // on the names). `localeCompare` would order a lowercase module like `captureRig`
  // differently, and "the edge answers in a different order" is a diff nobody wants to debug.
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
