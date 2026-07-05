import type { Database } from "../../lib/db/index.js";
import { schema } from "../../lib/db/index.js";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import { organization } from "better-auth/plugins";
import type { Bindings } from "./context.js";

/**
 * Build a Better Auth instance for the current request's env + db.
 *
 * - `organization` plugin → the multi-tenant primitive, surfaced everywhere as
 *   the **workspace**. Its schema is mapped onto our `workspace` table and the
 *   foreign keys renamed to `workspaceId`, so the database and our domain code
 *   speak "workspace". (Better Auth's client/endpoint surface still uses the
 *   `organization.*` names — wrapped behind a `workspace` facade in
 *   `apps/web/src/auth.ts`.)
 * - `apiKey` plugin with `enableSessionForAPIKeys` → agents authenticate by
 *   sending `x-api-key`, and the same `getSession` call resolves them.
 *   `enableMetadata` lets us persist the key's `defaultWorkspaceId` /
 *   `allowedWorkspaces` (read back by `authMiddleware` to scope the agent).
 */
export function createAuth(db: Database, env: Bindings) {
  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    // CSRF: Better Auth checks the request Origin on state-changing routes. The
    // web app is served from a different origin than the API (Vite :5173 in dev,
    // Cloudflare Pages in prod) and reaches the API via proxy, so those origins
    // must be trusted. `WEB_ORIGIN` carries the production web origin.
    trustedOrigins: [
      "http://localhost:5173",
      "http://localhost:5174",
      ...(env.WEB_ORIGIN ? [env.WEB_ORIGIN] : []),
    ],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    // Signup is closed in production (AUTH_DISABLE_SIGNUP=1 in wrangler vars):
    // Better Auth login is the only gate to the whole app, so open signup would
    // hand any visitor an account — and with it the canvas agent. Dev leaves the
    // flag unset so local signup works.
    emailAndPassword: { enabled: true, disableSignUp: env.AUTH_DISABLE_SIGNUP === "1" },
    plugins: [
      organization({
        schema: {
          organization: { modelName: "workspace" },
          member: { fields: { organizationId: "workspaceId" } },
          invitation: { fields: { organizationId: "workspaceId" } },
        },
      }),
      apiKey({
        enableSessionForAPIKeys: true,
        enableMetadata: true,
        // The plugin names a key's owner `referenceId`; map it onto our existing
        // `user_id` column (and FK) so we keep `userId` everywhere in our own code.
        schema: { apikey: { fields: { referenceId: "userId" } } },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
