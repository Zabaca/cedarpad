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
  for (const c of (cookieHeader ?? '').split(/;\s*/)) {
    const [k, ...v] = c.split('=');
    if (k === WORKSPACE_COOKIE && v.length) return v.join('=');
  }
  return null;
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
