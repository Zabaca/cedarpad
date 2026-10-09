import type { Database } from '../web-poc/lib/db/index.ts';
import type { CanvasRow } from '../web-poc/lib/db/schema.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import { canvasHiddenFrom } from './visibility.ts';

// The ONE composition seam for "may this user touch this thing" at the edge (#225).
// `visibility.ts` holds the PREDICATES (ADR-0016); `getWorkspace` holds the membership
// predicate (owner-OR-member). What lives here is their three-step COMPOSITION — resolve
// the row, check membership, apply visibility with the canvas join — which every handler
// used to re-derive by hand. One forgotten `canvasHiddenFrom` leg is a visibility leak, so
// the composition is a seam, not a convention.
//
// Every function FAILS CLOSED and indistinguishably: a missing row, a non-member, and a
// hidden row all return null / drop out of the list. Callers keep their own 404 / error
// shapes (some 404, some throw) — that mapping stays at the site.

/** A canvas the user may read: registered to `workspaceId`, the user a member of it, and
 *  not private-to-someone-else. Note the legacy `default` canvas has NO registry row —
 *  callers that treat it as always-selectable must special-case it before calling here. */
export async function resolveCanvas(
  db: Database,
  workspaceId: string,
  canvasId: string,
  userId: string,
): Promise<CanvasRow | null> {
  if (!(await getWorkspace(db, workspaceId, userId))) return null;
  const row = await canvasRegistry.get(db, canvasId);
  if (!row || row.workspaceId !== workspaceId) return null;
  return canvasHiddenFrom(row, userId) ? null : row;
}

/** The workspace's canvases the user may read: workspace-visible ones plus their own
 *  private ones. Membership is the CALLER's job (it resolved the workspace to list).
 *  NOT for the Shell's canvas rail — that projects others' private rows as `locked`
 *  for the workspace owner (manage-not-read), a different question than "may I read". */
export async function listVisibleCanvases(db: Database, workspaceId: string, userId: string): Promise<CanvasRow[]> {
  const rows = await canvasRegistry.list(db, workspaceId);
  return rows.filter((c) => !canvasHiddenFrom(c, userId));
}

/** The workspace a canvas lives in, if the caller may reach it — the share-links / huddle
 *  shape: the canvas is addressed WITHOUT its workspace, so the workspace is derived from
 *  the row (and hardcoded for the legacy row-less `default` canvas). `private` governs
 *  workspace visibility, not explicit sharing: minting on your OWN private canvas is fine. */
export async function resolveCanvasWorkspace(db: Database, canvasId: string, userId: string): Promise<string | null> {
  const row = canvasId === DEFAULT_CANVAS_ID ? null : await canvasRegistry.get(db, canvasId);
  if (row && canvasHiddenFrom(row, userId)) return null;
  const workspaceId = canvasId === DEFAULT_CANVAS_ID ? DEFAULT_WORKSPACE_ID : row?.workspaceId;
  if (!workspaceId) return null;
  return (await getWorkspace(db, workspaceId, userId)) ? workspaceId : null;
}
