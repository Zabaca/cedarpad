// The workspace-wide Component inventory: every Component, and every card rendering it.
//
// WHY THIS IS NOT A LIST OF NAMES. Components resolve per canvas, own → shared → base,
// first match wins (`component-catalog.ts`). So "the instances of Roadmap" is not a
// question about a name — a canvas holding its own `Roadmap` renders THAT one, and its
// cards have nothing to do with the shared Component of the same name. A cleanup built on
// name matching would delete those cards when the shared Component went, which is data
// loss dressed up as tidying.
//
// The resolution therefore happens PER CANVAS here, exactly as it does at render time, and
// every card is attributed to the Component that canvas actually loads.
//
// A card whose module resolves to NOTHING is reported as `unresolved` rather than dropped.
// Those are the dead cards — a Component deleted, or lost — and they are the other half of
// the cleanup this view exists for. Omitting them would make a canvas look tidier than it is.

import type { CanvasShape } from '../src/shapes.ts';
import { BASE_COMPONENTS } from './base-manifest.generated.ts';
import type { RecordStore } from './record-store.ts';

/** Where a Component resolves. `unresolved` is not a tier — it is a card with no source. */
export type InventoryTier = 'own' | 'shared' | 'base' | 'unresolved';

/** One card on one canvas, with enough context to confirm a delete before it fires. */
export interface ComponentInstance {
  canvasId: string;
  canvasName: string;
  shapeId: string;
  /** Absent means the canvas's first page (src/shapes.ts). */
  page?: string;
}

export interface InventoryEntry {
  name: string;
  tier: InventoryTier;
  /** The canvas that owns it, for the `own` tier. Null for shared, base and unresolved —
   *  none of which belong to a canvas. */
  canvasId: string | null;
  instances: ComponentInstance[];
}

export interface InventoryDeps {
  records: RecordStore;
  workspaceId: string;
  canvases: ReadonlyArray<{ id: string; name: string }>;
  /** The component shapes on one canvas. Injected because reading a room is a Durable
   *  Object fetch, and this module's logic is worth testing without one. */
  readShapes: (canvasId: string) => Promise<CanvasShape[]>;
  base?: ReadonlyArray<{ name: string; description: string }>;
}

/** Identity of an entry. Own-tier Components are per canvas, so the canvas is part of it —
 *  two canvases each holding their own `Roadmap` are two Components, not one. */
const keyOf = (tier: InventoryTier, canvasId: string | null, name: string): string => `${tier}\0${canvasId ?? ''}\0${name}`;

export async function componentInventory(deps: InventoryDeps): Promise<InventoryEntry[]> {
  const base = deps.base ?? BASE_COMPONENTS;
  const shared = (await deps.records.list({ workspaceId: deps.workspaceId, canvasId: null })).filter((r) => r.kind === 'component');
  const sharedNames = new Set(shared.map((r) => r.name));
  const baseNames = new Set(base.map((b) => b.name));

  const entries = new Map<string, InventoryEntry>();
  const entry = (tier: InventoryTier, canvasId: string | null, name: string): InventoryEntry => {
    const key = keyOf(tier, canvasId, name);
    const found = entries.get(key);
    if (found) return found;
    const made: InventoryEntry = { name, tier, canvasId, instances: [] };
    entries.set(key, made);
    return made;
  };

  for (const c of shared) entry('shared', null, c.name);
  for (const b of base) entry('base', null, b.name);

  for (const canvas of deps.canvases) {
    const own = (await deps.records.list({ workspaceId: deps.workspaceId, canvasId: canvas.id })).filter((r) => r.kind === 'component');
    const ownNames = new Set(own.map((r) => r.name));
    for (const r of own) entry('own', canvas.id, r.name);

    for (const shape of await deps.readShapes(canvas.id)) {
      if (shape.type !== 'component') continue;
      // The resolution walk, in the same order the renderer uses. First match wins.
      const tier: InventoryTier = ownNames.has(shape.module)
        ? 'own'
        : sharedNames.has(shape.module)
          ? 'shared'
          : baseNames.has(shape.module)
            ? 'base'
            : 'unresolved';
      entry(tier, tier === 'own' ? canvas.id : null, shape.module).instances.push({
        canvasId: canvas.id,
        canvasName: canvas.name,
        shapeId: shape.id,
        ...(shape.page ? { page: shape.page } : {}),
      });
    }
  }

  return [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** What names a Component to delete — the same three fields that identify an entry. */
export type ComponentRef = Pick<InventoryEntry, 'name' | 'tier' | 'canvasId'>;

export interface DeleteDeps extends InventoryDeps {
  /** Drop shapes from one canvas's room. A Durable Object fetch in production. */
  removeShapes: (canvasId: string, shapeIds: string[]) => Promise<void>;
}

/**
 * Delete a Component and the cards that render it.
 *
 * The instances are RECOMPUTED here rather than taken from the caller. The list a human
 * confirmed against is a snapshot, and between the confirm and the click another writer
 * can add a card, delete one, or shadow the Component on a canvas — at which point a
 * client-supplied id list deletes a card that no longer belongs to this Component. The
 * cost of recomputing is one read per canvas; the cost of not doing it is deleting
 * somebody else's card.
 *
 * The two halves are deliberately asymmetric. The SOURCE is soft-deleted, so its versions
 * survive and a mistaken cleanup is recoverable (ADR-0022). The CARDS are not recoverable
 * — which is why the caller is expected to confirm against per-canvas counts first, and
 * why this answers with what it actually removed.
 */
export async function deleteComponent(deps: DeleteDeps, ref: ComponentRef): Promise<{ instancesRemoved: number; sourceDeleted: boolean }> {
  if (ref.tier === 'base') {
    // Base Components are code bundled into the image (`base-manifest.generated.ts`), not
    // rows anything here owns. There is nothing to delete and pretending otherwise would
    // leave a Component that reappears on the next listing.
    throw new Error(`"${ref.name}" is a built-in Component — it ships with the platform and cannot be deleted from a workspace.`);
  }

  const entries = await componentInventory(deps);
  const entry = entries.find((e) => e.name === ref.name && e.tier === ref.tier && e.canvasId === ref.canvasId);
  const instances = entry?.instances ?? [];

  const byCanvas = new Map<string, string[]>();
  for (const i of instances) byCanvas.set(i.canvasId, [...(byCanvas.get(i.canvasId) ?? []), i.shapeId]);
  for (const [canvasId, ids] of byCanvas) await deps.removeShapes(canvasId, ids);

  // `unresolved` has no Record by definition — the cards are the whole of it.
  let sourceDeleted = false;
  if (ref.tier === 'own' || ref.tier === 'shared') {
    await deps.records.softDelete({ workspaceId: deps.workspaceId, canvasId: ref.canvasId, name: ref.name });
    sourceDeleted = true;
  }
  return { instancesRemoved: instances.length, sourceDeleted };
}
