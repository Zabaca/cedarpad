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
 * Parse `/w/:workspaceId/canvas/:canvasId/pad` into its two ids. This is the Render Pad's
 * own URL — the canvas app served in place (no redirect) so it can be iframed by the Shell
 * and read its canvas id back off `window.location.pathname` (#105). Self-describing, so
 * two tabs can hold two canvases; a browser-global cookie could not. Returns null for any
 * other path (a bare `/w/:ws/canvas/:id` is `parseCanvasRoute`'s).
 */
export function parsePadRoute(pathname: string): { workspaceId: string; canvasId: string } | null {
  const m = /^\/w\/([^/]+)\/canvas\/([^/]+)\/pad\/?$/.exec(pathname);
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
 * Given a requested workspace id and the access-checked registry lookup (null when the
 * id is unknown or the caller is neither owner nor member — #179), decide whether to
 * serve it or 404. Every id — INCLUDING `default`, which has a real seeded row since
 * #179 — requires a record; a missing row fails closed. `default` still resolves to
 * the LEGACY runtime coords (that's routing, not access).
 */
export function decideWorkspaceRoute(
  workspaceId: string,
  record: { id: string } | null,
): WorkspaceRouteDecision {
  if (!record) return { decision: 'not-found' };
  if (workspaceId === DEFAULT_WORKSPACE_ID) return { decision: 'serve', workspace: DEFAULT_WORKSPACE };
  return { decision: 'serve', workspace: { id: record.id } };
}

export type CanvasRouteDecision =
  | { decision: 'select'; workspaceId: string; canvasId: string }
  | { decision: 'not-found' };

/**
 * Decide `/w/:ws/canvas/:id` from the access-checked lookups: `workspaceRecord` is
 * null unless the caller is owner or member (#179 — `default` included, seeded row);
 * `canvasRecord` is the registry row or null. Select only when the workspace is
 * servable AND the canvas exists AND it belongs to that workspace — otherwise 404,
 * never proxied. Pure: the DB lookups happen in the caller so this stays
 * unit-testable off a live runtime.
 */
export function decideCanvasRoute(
  workspaceId: string,
  canvasId: string,
  workspaceRecord: { id: string } | null,
  canvasRecord: { workspaceId: string } | null,
): CanvasRouteDecision {
  if (!workspaceRecord) return { decision: 'not-found' };
  // The legacy `default` canvas has no registry row (like the default workspace); it is
  // always selectable within a servable workspace so the index can switch back to it.
  if (canvasId === DEFAULT_CANVAS_ID) return { decision: 'select', workspaceId, canvasId };
  if (canvasRecord && canvasRecord.workspaceId === workspaceId) {
    return { decision: 'select', workspaceId, canvasId };
  }
  return { decision: 'not-found' };
}
