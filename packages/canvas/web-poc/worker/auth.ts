import type { Database } from "../lib/db/index.js";
import { schema } from "../lib/db/index.js";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { apiKey } from "@better-auth/api-key";
import { mcp, organization } from "better-auth/plugins";
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
    // Signup is disabled in prod (James-only) and open in dev (PRD #49 #15): the edge
    // sets AUTH_DISABLE_SIGNUP="true" in prod, leaves it unset in dev.
    emailAndPassword: { enabled: true, disableSignUp: env.AUTH_DISABLE_SIGNUP === "true" },
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
      // Inbound MCP (ADR-0013 train 3, #177): cedarpad as an OAuth provider so outside
      // agents (Claude Code, claude.ai) connect with user-delegated, revocable tokens —
      // the ONLY programmatic surface (no inbound REST/turn API; a service credential
      // that can execute turns is an RCE credential). Flow: /api/auth/mcp/authorize with
      // no session redirects to `/` (the edge login, which preserves the OAuth query and
      // bounces back after sign-in), then the consent page below, then token exchange.
      // Root /.well-known discovery is served by the edge (worker/index.ts).
      mcp({
        loginPage: "/",
        oidcConfig: {
          loginPage: "/", // type-required here too; the plugin's top-level loginPage wins
          // Consent is REQUIRED for dynamically-registered clients (registration is an
          // unauthenticated endpoint by spec — auto-consent would let any authorize link
          // a user clicks mint a token silently). Minimal inline page; posts to the
          // plugin's mounted consent endpoint.
          getConsentHTML: ({ clientName, clientId, scopes, code }) => consentHTML(clientName ?? clientId, scopes, code ?? ""),
        },
      }),
    ],
  });
}

/** The OAuth consent page (#177): one Approve/Deny pair posting to the Better Auth
 * consent endpoint. Kept dependency-free inline HTML like the edge login page. */
function consentHTML(clientName: string, scopes: string[], code: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title>
<style>:root{color-scheme:light dark}*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea;display:grid;place-items:center;min-height:100vh}main{width:min(400px,92vw)}h1{font-size:18px;margin:0 0 8px}p{color:#9a9aa2}code{color:#e7e7ea}button{padding:10px 16px;border-radius:8px;border:0;font-weight:600;cursor:pointer;margin-right:8px}#ok{background:#e05d38;color:#fff}#no{background:#2a2a2e;color:#e7e7ea}.err{color:#ff7a6b;min-height:1.2em;margin-top:8px}</style></head><body><main>
<h1>Authorize access</h1>
<p><code>${esc(clientName)}</code> is asking to act as you on cedarpad (scopes: ${esc(scopes.join(", ") || "default")}). It will be able to do what you can do in your workspaces.</p>
<button id=ok>Approve</button><button id=no>Deny</button><div class=err id=err></div>
<script>
const send=async(accept)=>{const r=await fetch('/api/auth/oauth2/consent',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({accept,consent_code:${JSON.stringify(code)}})});const d=await r.json().catch(()=>null);if(r.ok&&d&&d.redirectURI){location.href=d.redirectURI;}else{document.getElementById('err').textContent=(d&&(d.message||d.error))||'Consent failed';}};
document.getElementById('ok').onclick=()=>send(true);
document.getElementById('no').onclick=()=>send(false);
</script></main></body></html>`;
}

export type Auth = ReturnType<typeof createAuth>;
