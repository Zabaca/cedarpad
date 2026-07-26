// Client-side reader for the edge mart route (ADR-0017, #238/#239): a placed component
// that names a mart (`dataSource: {kind:'mart', name}`) fetches its current rows +
// freshness through THIS ONE route — never a second read path, and never an arbitrary
// URL (the mart namespace IS the boundary; see mart-contract.ts's DataSourceSchema).

import { activeWorkspaceId } from './active-canvas';
import { MartSidecarSchema, type MartRow, type MartSidecar } from '../shared/mart-contract';

export interface MartData {
  rows: MartRow[];
  sidecar: MartSidecar;
}

/** Fetch one mart's rows + sidecar from `/api/workspaces/:ws/marts/:name` (member or
 * guest — the route itself decides access; see worker/mart-api.ts). Throws with an
 * agent/user-legible message on a 404 (missing, malformed name, or denied) or a
 * malformed response — the mart sidecar is re-validated at this boundary too
 * (CLAUDE.md §7), not just trusted because it crossed the wire once already. */
export async function fetchMart(name: string): Promise<MartData> {
  const ws = activeWorkspaceId();
  const res = await fetch(`/api/workspaces/${encodeURIComponent(ws)}/marts/${encodeURIComponent(name)}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`mart "${name}" not found`);
  const body = (await res.json()) as { rows: unknown; sidecar: unknown };
  return { rows: body.rows as MartRow[], sidecar: MartSidecarSchema.parse(body.sidecar) };
}
