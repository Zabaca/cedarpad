import { schema } from "../lib/db/index.js";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { type AccessScope, canAccessWorkspace, scopeForWorkspace } from "./access.js";
import { createAuth } from "./auth.js";
import type { AppEnv } from "./context.js";
import { createDbForWorker } from "./runtime.js";

/** Attach a per-request Drizzle db to the context. */
export const dbMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDbForWorker(c.env));
  await next();
});

/**
 * Cookie the platform Shell sets to pin the active workspace (ADR-0007, #46).
 * Mirrors `WORKSPACE_COOKIE` in `packages/canvas/worker/shell-routing.ts`.
 */
const WORKSPACE_COOKIE = "cs_workspace";
/** Header an agent (`x-api-key`) passes to pick its active workspace. */
const WORKSPACE_HEADER = "x-workspace-id";
/** The legacy/default platform workspace — used when no selection is present. */
const DEFAULT_WORKSPACE_ID = "default";

/**
 * Pure resolution of the active PLATFORM workspace (ADR-0007, #57). Notebook
 * data is isolated per platform workspace — NOT the Better Auth organization.
 *   - agent (`x-api-key`): the `x-workspace-id` header.
 *   - session: the `cs_workspace` cookie set by the Shell.
 * Absent/empty in either case ⇒ the legacy `default` workspace, so existing
 * (backfilled) rows stay reachable and nothing is lost.
 */
export function resolveActiveWorkspace(input: {
  isAgent: boolean;
  header: string | null | undefined;
  cookie: string | null | undefined;
}): string {
  const selected = input.isAgent ? input.header : input.cookie;
  return selected && selected.length > 0 ? selected : DEFAULT_WORKSPACE_ID;
}

/** Request-bound wrapper: read the selection from the header (agent) or cookie. */
function activeWorkspaceId(c: Context<AppEnv>, isAgent: boolean): string {
  return resolveActiveWorkspace({
    isAgent,
    header: c.req.header(WORKSPACE_HEADER),
    cookie: getCookie(c, WORKSPACE_COOKIE),
  });
}

/**
 * Resolve the caller and their active platform workspace.
 *
 * 1. `x-api-key` or session cookie → Better Auth `getSession` (the apiKey
 *    plugin makes both resolve here). The active workspace is the platform
 *    workspace: `x-workspace-id` header (agent) or `cs_workspace` cookie
 *    (session); absent ⇒ `default`. Reads/writes are isolated to it.
 * 2. Dev escape hatch: `DEV_AUTH_WORKSPACE` + `x-dev-workspace` ⇒ act as that
 *    workspace, no auth (local dev only).
 *
 * Sets `workspaceId` (active + create target), `userId`, `isAgent`,
 * `accessScope` (scoped to the active workspace so A never sees B).
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const auth = createAuth(db, c.env);

  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);

  if (session?.user) {
    const isAgent = c.req.header("x-api-key") != null;
    const workspaceId = activeWorkspaceId(c, isAgent);

    c.set("workspaceId", workspaceId);
    c.set("userId", session.user.id);
    c.set("isAgent", isAgent);
    c.set("accessScope", scopeForWorkspace(workspaceId));
    await next();
    return;
  }

  const devWorkspace = c.env.DEV_AUTH_WORKSPACE;
  const reqDevWorkspace = c.req.header("x-dev-workspace");
  if (devWorkspace && reqDevWorkspace) {
    c.set("workspaceId", reqDevWorkspace);
    c.set("userId", null);
    c.set("isAgent", true);
    c.set("accessScope", scopeForWorkspace(reqDevWorkspace));
    await next();
    return;
  }

  return c.json({ error: "unauthorized" }, 401);
});

/** Whether an observation exists and is within the caller's access scope. */
export async function observationAccessible(
  db: AppEnv["Variables"]["db"],
  scope: AccessScope,
  observationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ workspaceId: schema.observations.workspaceId })
    .from(schema.observations)
    .where(eq(schema.observations.id, observationId))
    .limit(1);
  const row = rows[0];
  return row != null && canAccessWorkspace(scope, row.workspaceId);
}

/** Whether a source exists and is within the caller's access scope. */
export async function sourceAccessible(
  db: AppEnv["Variables"]["db"],
  scope: AccessScope,
  sourceId: string,
): Promise<boolean> {
  const rows = await db
    .select({ workspaceId: schema.sources.workspaceId })
    .from(schema.sources)
    .where(eq(schema.sources.id, sourceId))
    .limit(1);
  const row = rows[0];
  return row != null && canAccessWorkspace(scope, row.workspaceId);
}

/** Whether a problem exists and is within the caller's access scope. */
export async function problemAccessible(
  db: AppEnv["Variables"]["db"],
  scope: AccessScope,
  problemId: string,
): Promise<boolean> {
  const rows = await db
    .select({ workspaceId: schema.problems.workspaceId })
    .from(schema.problems)
    .where(eq(schema.problems.id, problemId))
    .limit(1);
  const row = rows[0];
  return row != null && canAccessWorkspace(scope, row.workspaceId);
}
