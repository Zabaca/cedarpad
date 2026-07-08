import { DEFAULT_WORKSPACE, type ResolvableWorkspace } from './sandbox-resolver.ts';

// The edge Shell's PURE routing/selection decisions (ADR-0007, #46), kept free of any
// DB or `@cloudflare/sandbox` import so they're unit-testable off a live runtime. The
// Turso lookup and the Shell HTML / registry API (which DO touch the DB) live in
// `shell.ts`; those consume the decisions made here.

/** Cookie that pins which workspace the container proxy serves for absolute-path
 *  requests. The canvas frontend loads assets from absolute paths (`/src`, `/api`),
 *  so it can't live under a `/w/:id` prefix — the cookie carries the selection. */
export const WORKSPACE_COOKIE = 'cs_workspace';

/** The legacy/default workspace id. It has no registry row; it resolves to the
 *  behavior-preserving prod coordinates (`canvas` / `workspaces/default/`). */
export const DEFAULT_WORKSPACE_ID = 'default';

/** Cookie that pins which canvas the frontend addresses. Unlike `cs_workspace` it is
 *  NON-HttpOnly: the container-served canvas frontend reads it client-side to stamp
 *  `x-canvas-id` on its bridge calls (the edge proxy itself doesn't route by canvas —
 *  one container per workspace hosts N canvases, path-isolated). */
export const CANVAS_COOKIE = 'cs_canvas';

/** The legacy/default canvas id. Absent selection resolves here, so today's
 *  un-namespaced canvas is byte-for-byte preserved. */
export const DEFAULT_CANVAS_ID = 'default';

/**
 * Parse `/w/:workspaceId` (with or without a trailing app-surface segment) into its
 * workspace id. The segment after the id is the app surface (canvas today) and is not
 * needed here — the cookie, not the path, carries the selection to the proxy.
 * Returns null for any non-`/w/` path or an empty id (`/w/`, `/w`).
 */
export function parseWorkspaceRoute(pathname: string): { workspaceId: string } | null {
  const m = /^\/w\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return m ? { workspaceId: m[1] } : null;
}

/** Read the workspace-selection cookie, or null when unset. */
export function readWorkspaceCookie(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, WORKSPACE_COOKIE);
}

/** Read the canvas-selection cookie, or null when unset. */
export function readCanvasCookie(cookieHeader: string | null): string | null {
  return readCookie(cookieHeader, CANVAS_COOKIE);
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  for (const c of (cookieHeader ?? '').split(/;\s*/)) {
    const [k, ...v] = c.split('=');
    if (k === name && v.length) return v.join('=');
  }
  return null;
}

/**
 * Parse `/w/:workspaceId/canvas/:canvasId` into its two ids. This is the canvas
 * app-surface URL: selecting it pins BOTH the workspace and the canvas. Returns null
 * for any path that isn't exactly a canvas route (an empty id ⇒ null). A bare
 * `/w/:id` (no `/canvas/:id`) is a workspace route, handled by `parseWorkspaceRoute`.
 */
export function parseCanvasRoute(pathname: string): { workspaceId: string; canvasId: string } | null {
  const m = /^\/w\/([^/]+)\/canvas\/([^/]+)\/?$/.exec(pathname);
  return m ? { workspaceId: m[1], canvasId: m[2] } : null;
}

/**
 * Which workspace to land the user on given their registry list. Empty ⇒ the legacy
 * default so a first-login user lands on the existing prod container (no DB write, so
 * it's behavior-preserving); otherwise their first (oldest) workspace.
 */
export function selectInitialWorkspace(list: ReadonlyArray<{ id: string }>): string {
  return list.length ? list[0].id : DEFAULT_WORKSPACE_ID;
}

export type WorkspaceRouteDecision =
  | { decision: 'serve'; workspace: ResolvableWorkspace }
  | { decision: 'not-found' };

/**
 * Given a requested workspace id and the ownership-checked registry lookup (null when
 * the id is unknown or owned by someone else), decide whether to serve it or 404.
 * The `default` id is always served as the legacy workspace (it has no row); a real id
 * is served only when the lookup found an owned record — otherwise 404, never proxied.
 */
export function decideWorkspaceRoute(
  workspaceId: string,
  record: { id: string } | null,
): WorkspaceRouteDecision {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return { decision: 'serve', workspace: DEFAULT_WORKSPACE };
  if (record) return { decision: 'serve', workspace: { id: record.id } };
  return { decision: 'not-found' };
}

export type CanvasRouteDecision =
  | { decision: 'select'; workspaceId: string; canvasId: string }
  | { decision: 'not-found' };

/**
 * Decide `/w/:ws/canvas/:id` from the ownership-checked lookups: `workspaceRecord`
 * is null unless the workspace is owned (the `default` id needs no row); `canvasRecord`
 * is the registry row or null. Select only when the workspace is servable AND the canvas
 * exists AND it belongs to that workspace — otherwise 404, never proxied. Pure: the DB
 * lookups happen in the caller so this stays unit-testable off a live runtime.
 */
export function decideCanvasRoute(
  workspaceId: string,
  canvasId: string,
  workspaceRecord: { id: string } | null,
  canvasRecord: { workspaceId: string } | null,
): CanvasRouteDecision {
  const workspaceServable = workspaceId === DEFAULT_WORKSPACE_ID || !!workspaceRecord;
  if (!workspaceServable) return { decision: 'not-found' };
  // The legacy `default` canvas has no registry row (like the default workspace); it is
  // always selectable within a servable workspace so the index can switch back to it.
  if (canvasId === DEFAULT_CANVAS_ID) return { decision: 'select', workspaceId, canvasId };
  if (canvasRecord && canvasRecord.workspaceId === workspaceId) {
    return { decision: 'select', workspaceId, canvasId };
  }
  return { decision: 'not-found' };
}
