// Client-side reader for the edge Notebook route (ADR-0024): a placed component that names
// a notebook query (`dataSource: {kind:'notebook', query, params}`) fetches its rows through
// THIS ONE route. The sibling of `mart-data.ts` — same discipline, different namespace: the
// query registry (worker/notebook-data-api.ts) IS the boundary, so no statement and no URL
// ever leaves the client.

import { activeWorkspaceId } from './active-canvas';
import type { NotebookParams, NotebookRow } from '../shared/notebook-source';

/** Fetch one named query's rows from `/api/workspaces/:ws/notebook/:query`. Params ride the
 * query string and are re-validated server-side per query; a 404 (unknown name, guest) and
 * a 400 (bad params) both surface as an agent/user-legible error. */
export async function fetchNotebook(query: string, params?: NotebookParams): Promise<NotebookRow[]> {
  const ws = activeWorkspaceId();
  const search = new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]));
  const qs = search.toString();
  const res = await fetch(
    `/api/workspaces/${encodeURIComponent(ws)}/notebook/${encodeURIComponent(query)}${qs ? `?${qs}` : ''}`,
    { credentials: 'same-origin' },
  );
  if (!res.ok) throw new Error(`notebook query "${query}" failed (${res.status})`);
  const body = (await res.json()) as { rows: NotebookRow[] };
  return body.rows;
}
