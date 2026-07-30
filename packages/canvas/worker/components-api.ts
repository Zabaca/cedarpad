// `GET /api/components` answered at the EDGE (ADR-0022, #363). It used to proxy into the
// container, which can mean cold-booting one — 30–120s and real money — to list a few
// kilobytes of names. Own and shared come from Records, the platform tier from the bundled
// build-time manifest, so the whole library is answerable with the container asleep
// (PRD #354 story 29).
//
// The response shape is the bridge's, unchanged: `components` (bare names) for existing
// callers and `details` (name + description + TIER) for the gallery, the palette and the
// in-canvas catalog. The tier labels are load-bearing — callers avoid duplicates with them.

import type { Database } from '../web-poc/lib/db/index.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { resolveCanvas } from './access.ts';
import { componentCatalog } from './component-catalog.ts';
import { d1RecordStore } from './record-store.ts';
import { DEFAULT_CANVAS_ID } from './shell-routing.ts';

/**
 * The library a canvas can see. 404s a canvas the caller may not read — same fail-closed,
 * indistinguishable answer `access.ts` gives everywhere else, so an unregistered id, another
 * workspace's canvas and someone's private canvas all look alike.
 *
 * The legacy `default` canvas has no registry row (it predates the registry) and is always
 * selectable inside a workspace the caller belongs to, exactly as the pad routes treat it —
 * so a caller that names no canvas still gets the workspace's shared library and the platform
 * tier rather than a 404.
 */
export async function handleComponentsApi(
  db: Database,
  user: { id: string },
  workspaceId: string,
  canvasId: string,
): Promise<Response> {
  const reachable =
    canvasId === DEFAULT_CANVAS_ID
      ? (await getWorkspace(db, workspaceId, user.id)) !== null
      : (await resolveCanvas(db, workspaceId, canvasId, user.id)) !== null;
  if (!reachable) return Response.json({ error: 'canvas not found' }, { status: 404 });

  const details = await componentCatalog(d1RecordStore(db), { workspaceId, canvasId });
  return Response.json({ components: details.map((d) => d.name), details });
}
