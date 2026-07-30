// `GET`/`DELETE /api/workspace-components` — the Components stage's data, answered at the
// EDGE (ADR-0022). The Records are the edge's, the base tier is a bundled manifest, and the
// cards come from each canvas's Durable Object, so nothing here wakes a container.
//
// It is the one view that spans canvases: the pad's palette and gallery are scoped to the
// canvas you have open, which is exactly why a Component generated on some other canvas is
// invisible until you go looking for it.

import { CanvasMutationResult } from '../shared/canvas-mutation.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { componentInventory, deleteComponent, type ComponentRef, type InventoryTier } from './component-inventory.ts';
import type { Env } from './index.ts';
import { d1RecordStore } from './record-store.ts';
import { CONTAINER_PRINCIPAL } from '../shared/canvas-mutation.ts';
import { SYNC_USER_HEADER } from './sync-api.ts';
import { syncRoomName } from './sync-room.ts';

export const INVENTORY_PATH = '/api/workspace-components';

const TIERS: readonly InventoryTier[] = ['own', 'shared', 'base', 'unresolved'];

/**
 * Read or mutate one canvas's room through its Durable Object.
 *
 * `stub.fetch` rather than DO RPC for the constraint #288 records: `CANVAS_SYNC` is an
 * unparameterised namespace because the class cannot `extends DurableObject`, so RPC is
 * unavailable. This is the same door `canvas-mutate-api.ts` uses, minus the HTTP hop —
 * we are already inside the Worker, and the caller was authorized before we got here.
 */
async function roomFetch(env: Env, canvasId: string, body: unknown) {
  const id = env.CANVAS_SYNC.idFromName(syncRoomName(canvasId));
  const res = await env.CANVAS_SYNC.get(id).fetch(
    new Request(`https://do/api/canvas-sync/${canvasId}/mutate`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', [SYNC_USER_HEADER]: CONTAINER_PRINCIPAL },
    }),
  );
  if (!res.ok) throw new Error(`canvas ${canvasId} refused the read (${res.status})`);
  return CanvasMutationResult.parse(await res.json());
}

function parseRef(body: unknown): ComponentRef | null {
  const b = body as { name?: unknown; tier?: unknown; canvasId?: unknown } | null;
  if (!b || typeof b.name !== 'string' || !b.name) return null;
  if (typeof b.tier !== 'string' || !TIERS.includes(b.tier as InventoryTier)) return null;
  const canvasId = b.canvasId === null || b.canvasId === undefined ? null : typeof b.canvasId === 'string' ? b.canvasId : undefined;
  if (canvasId === undefined) return null;
  return { name: b.name, tier: b.tier as InventoryTier, canvasId };
}

/**
 * Every Component in the workspace, and every card rendering it.
 *
 * Membership of the WORKSPACE is the check, not per-canvas reachability: this is a
 * workspace-wide inventory, and a member who could not see one of its canvases would get a
 * list whose instance counts silently disagree with what a delete would do.
 */
export async function handleComponentInventory(request: Request, env: Env, db: Database, user: { id: string }, workspaceId: string): Promise<Response> {
  if (!(await getWorkspace(db, workspaceId, user.id))) {
    return Response.json({ error: 'workspace not found' }, { status: 404 });
  }
  const canvases = (await canvasRegistry.list(db, workspaceId)).map((c) => ({ id: c.id, name: c.name }));
  const deps = {
    records: d1RecordStore(db),
    workspaceId,
    canvases,
    readShapes: async (canvasId: string) => (await roomFetch(env, canvasId, { op: 'read' })).shapes,
    removeShapes: async (canvasId: string, ids: string[]) => {
      await roomFetch(env, canvasId, { op: 'remove', ids });
    },
  };

  if (request.method === 'GET') {
    return Response.json({ components: await componentInventory(deps) });
  }
  if (request.method === 'DELETE') {
    const ref = parseRef(await request.json().catch(() => null));
    if (!ref) return Response.json({ error: 'body must name { name, tier, canvasId }' }, { status: 400 });
    try {
      return Response.json(await deleteComponent(deps, ref));
    } catch (e) {
      // A refused delete is the caller's mistake (a built-in), not a server fault.
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  return Response.json({ error: 'method not allowed' }, { status: 405 });
}
