import { eq, inArray, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * What workspaces a principal (user or API key) may access.
 *
 * The default is `all` — workspaces are human segmentation within one company,
 * not isolated tenants, so every user and every freshly-generated key sees
 * everything. Restriction is an opt-in: populate an allowlist of the workspaces
 * a principal may access (a user's `allowedWorkspaces`, or a key's
 * `metadata.allowedWorkspaces`) and the scope becomes `list`. Everything not in
 * the list is denied. Empty/absent ⇒ `all`.
 */
export type AccessScope = { kind: "all" } | { kind: "list"; workspaceIds: string[] };

/** Build a scope from an optional allowlist — the single place the rule lives. */
export function scopeFromAllowlist(allowed: string[] | null | undefined): AccessScope {
  return allowed && allowed.length > 0 ? { kind: "list", workspaceIds: allowed } : { kind: "all" };
}

/** Whether a principal may touch a specific workspace (detail + write gates). */
export function canAccessWorkspace(scope: AccessScope, workspaceId: string): boolean {
  return scope.kind === "all" || scope.workspaceIds.includes(workspaceId);
}

/**
 * `WHERE` fragment confining a list/count query to the accessible workspaces.
 * `undefined` when the scope is `all` (no filter) — meant to be `and(...)`-composed.
 */
export function accessWhere(scope: AccessScope, column: SQLiteColumn): SQL | undefined {
  return scope.kind === "all" ? undefined : inArray(column, scope.workspaceIds);
}

/**
 * `WHERE` fragment for a read that spans accessible workspaces by default but
 * may be narrowed to one via `workspaceId`. An explicit `workspaceId` is honoured
 * only when it's in scope, otherwise the query is forced empty (`1 = 0`).
 */
export function workspaceFilter(
  scope: AccessScope,
  column: SQLiteColumn,
  workspaceId?: string,
): SQL | undefined {
  if (workspaceId) {
    return canAccessWorkspace(scope, workspaceId) ? eq(column, workspaceId) : sql`1 = 0`;
  }
  return accessWhere(scope, column);
}
