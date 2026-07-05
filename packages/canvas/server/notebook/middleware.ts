import { schema } from "../../lib/db/index.js";
import { eq } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { type AccessScope, canAccessWorkspace, scopeFromAllowlist } from "./access.js";
import { type Auth, createAuth } from "./auth.js";
import type { AppEnv } from "./context.js";

/** First workspace the user belongs to (fallback create target when none active). */
async function firstMembershipWorkspace(
  db: AppEnv["Variables"]["db"],
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ workspaceId: schema.member.workspaceId })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
}

/** A user's optional workspace allowlist (null ⇒ access all). */
async function userAllowedWorkspaces(
  db: AppEnv["Variables"]["db"],
  userId: string,
): Promise<string[] | null> {
  const rows = await db
    .select({ allowed: schema.user.allowedWorkspaces })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return rows[0]?.allowed ?? null;
}

/** Custom fields we store on an API key's metadata. */
interface ApiKeyMetadata {
  /** Workspaces this key may access (absent ⇒ all). */
  allowedWorkspaces?: string[];
  /** Where this key's writes land (absent ⇒ the owner's first workspace). */
  defaultWorkspaceId?: string;
}

/** Read an API key's metadata via Better Auth (the reliable server-side surface). */
async function apiKeyMetadata(auth: Auth, key: string): Promise<ApiKeyMetadata | null> {
  const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null);
  return (result?.key?.metadata as ApiKeyMetadata | null | undefined) ?? null;
}

/**
 * Resolve the caller, their access scope, and their create target.
 *
 * 1. `x-api-key` or session cookie → Better Auth `getSession` (the apiKey
 *    plugin makes both resolve here).
 *    - Human session: `accessScope` from the user's allowlist (default all);
 *      create target = the session's active workspace.
 *    - API key (agent): `accessScope` from the key's `metadata.allowedWorkspaces`
 *      (default all); create target = `metadata.defaultWorkspaceId`.
 * 2. Dev escape hatch: `DEV_AUTH_WORKSPACE` + `x-dev-workspace` ⇒ act as that
 *    workspace with full (all) access, no auth (local dev only).
 *
 * Sets `workspaceId` (create target), `userId`, `isAgent`, `accessScope`.
 */
export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const db = c.get("db");
  const auth = createAuth(db, c.env);

  const session = await auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);

  if (session?.user) {
    const apiKeyHeader = c.req.header("x-api-key");
    const isAgent = apiKeyHeader != null;

    let accessScope: AccessScope;
    let target: string | null;

    if (isAgent) {
      const meta = await apiKeyMetadata(auth, apiKeyHeader);
      accessScope = scopeFromAllowlist(meta?.allowedWorkspaces);
      target = meta?.defaultWorkspaceId ?? (await firstMembershipWorkspace(db, session.user.id));
    } else {
      accessScope = scopeFromAllowlist(await userAllowedWorkspaces(db, session.user.id));
      const activeWorkspace =
        (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null;
      target = activeWorkspace ?? (await firstMembershipWorkspace(db, session.user.id));
    }

    // Keep the create target inside the access scope when restricted.
    if (target && !canAccessWorkspace(accessScope, target)) {
      target = accessScope.kind === "list" ? (accessScope.workspaceIds[0] ?? null) : target;
    }
    if (!target) {
      return c.json({ error: "no_workspace", message: "User has no workspace" }, 403);
    }

    c.set("workspaceId", target);
    c.set("userId", session.user.id);
    c.set("isAgent", isAgent);
    c.set("accessScope", accessScope);
    await next();
    return;
  }

  const devWorkspace = c.env.DEV_AUTH_WORKSPACE;
  const reqDevWorkspace = c.req.header("x-dev-workspace");
  if (devWorkspace && reqDevWorkspace) {
    c.set("workspaceId", reqDevWorkspace);
    c.set("userId", null);
    c.set("isAgent", true);
    c.set("accessScope", { kind: "all" });
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
