// What a canvas deletion does to the Records the canvas owned, and the one door that
// reclaims them (ADR-0022 decision 9). Policy over the Record port, like `component-store.ts`:
// no SQL, no HTTP, so the rules are testable against the in-memory port with no database.
//
// Delete has to be honest in BOTH directions. Today it is dishonest by keeping: nothing
// removes a deleted canvas's Components, so the source survives by accident and leaks forever.
// A hard cascade would be dishonest the other way — one click permanently destroying source is
// the exact shape of the 2026-07-29 loss, and it would make the version history this whole
// workstream added pointless. So deletion HIDES, and a separate, deliberate purge reclaims.
//
// Two boundaries this deliberately does NOT cross. Workspace SKILLS are workspace-scoped, not
// canvas-scoped — no canvas owns one — so deleting a canvas leaves them entirely alone, and
// the purge is likewise `component_records` only. And a Component whose canvas is gone cannot
// be brought back by `put`'s undelete: every Component verb names its canvas, and the edge
// checks that canvas against the registry, whose row the deletion removed — so the undelete
// that a version restore is built on stops at the same gate a write does.

import type { RecordStore } from './record-store.ts';

/** A canvas that is being deleted. `canvasId` is a real canvas — never the shared tier's null. */
export type CanvasScope = { workspaceId: string; canvasId: string };

/**
 * Soft-delete everything in a canvas's OWN tier: its Components and the data files they
 * import, both of which are Records of the same family and would otherwise be left as
 * orphans that nothing lists and nothing reclaims.
 *
 * The shared library is `canvas_id NULL`, and a scope delete carrying no canvas would erase
 * it — a workspace's whole shared library destroyed by deleting one canvas. The type says
 * `string`, and this refuses an empty one, because the in-memory port keys the shared tier
 * by the same empty string a blank id would produce.
 */
export async function deleteCanvasRecords(records: RecordStore, scope: CanvasScope): Promise<void> {
  if (!scope.canvasId) throw new Error('deleteCanvasRecords: a canvas id is required — a canvas-less scope is the workspace shared library');
  await records.softDeleteScope(scope);
}
