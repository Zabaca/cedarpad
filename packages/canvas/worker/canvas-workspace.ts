import type { Database } from '../web-poc/lib/db/client.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { DEFAULT_CANVAS_ID, DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

/**
 * Which workspace a canvas belongs to, or null when the registry has never heard of it.
 *
 * The edge answers this wherever a container presents a credential for a canvas it names
 * (#374): a container's bearer is bound to ITS workspace, so the edge must learn the
 * workspace the request is about from the canvas, then check the bearer against that
 * workspace's key. The legacy `default` canvas has no registry row (it predates the
 * registry) and is pinned to the legacy `default` workspace by hand.
 */
export async function workspaceOfCanvas(db: Database, canvasId: string): Promise<string | null> {
  if (canvasId === DEFAULT_CANVAS_ID) return DEFAULT_WORKSPACE_ID;
  return (await canvasRegistry.get(db, canvasId))?.workspaceId ?? null;
}
