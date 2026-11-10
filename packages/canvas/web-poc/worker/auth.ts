import type { Database } from "../lib/db/index.js";
import { schema } from "../lib/db/index.js";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, magicLink, mcp, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { hasPendingInvitationForEmail } from "../lib/db/queries/invitations.js";
import type { Bindings } from "./context.js";
import { createEmailSender } from "./email.js";

/**
 * Build a Better Auth instance for the current request's env + db.
 *
 * - `organization` plugin → the multi-tenant primitive, surfaced everywhere as
 *   the **workspace**. Its schema is mapped onto our `workspace` table and the
 *   foreign keys renamed to `workspaceId`, so the database and our domain code
 *   speak "workspace". (Better Auth's client/endpoint surface still uses the
 *   `organization.*` names — wrapped behind a `workspace` facade in
 *   `apps/web/src/auth.ts`.)
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
    // PASSWORDLESS. There is no password credential on this platform at all — the
    // magic-link plugin below is the only way to hold a session. `AUTH_DISABLE_SIGNUP`
    // governed this switch and no longer gates anything; the allowlist in
    // `sendMagicLink` is what keeps account creation closed now.
    emailAndPassword: { enabled: false },
    plugins: [
      // ADR-0014: admin lives inside the app, gated on `user.role === "admin"`.
      // Supplies the operator verbs (create-user = the manual invite, list-users,
      // ban) without a second auth surface. Roles are assigned by data update,
      // never by any signup path.
      admin(),
      // THE credential (passwordless cutover). Better Auth's
      // `POST /sign-in/magic-link` is PUBLIC and creates the user on verify, so the
      // allowlist below — not `disableSignUp` — is what keeps signup closed: a link
      // is only ever DELIVERED to an address that already holds an account or holds
      // a pending invitation. `disableSignUp` would be too strong: an invitee has no
      // user row yet, and their first click is exactly what must create it.
      //
      // Non-allowed addresses get the SAME silent ok as allowed ones (the endpoint
      // never confirms who has an account).
      magicLink({
        // 15 minutes, not the 5-minute default: these links cross a mail hop, and
        // an invite may sit unopened for a few minutes.
        expiresIn: 60 * 15,
        sendMagicLink: async ({ email, url }) => {
          const address = email.trim().toLowerCase();
          const [existing] = await db
            .select({ id: schema.user.id })
            .from(schema.user)
            .where(eq(schema.user.email, address))
            .limit(1);
          const allowed =
            existing !== undefined || (await hasPendingInvitationForEmail(db, address, Date.now()));
          if (!allowed) return;

          await createEmailSender(env.EMAIL)(
            {
              to: address,
              subject: "Sign in to cedarpad",
              text: `Sign in to cedarpad (this link is valid for 15 minutes and can be used once):\n\n${url}\n\nIf you did not request this, you can ignore this email.`,
            },
            "[auth] magic link",
          );
        },
      }),
      organization({
        schema: {
          organization: { modelName: "workspace" },
          member: { fields: { organizationId: "workspaceId" } },
          invitation: { fields: { organizationId: "workspaceId" } },
        },
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
