import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { getWorkspace, getWorkspaceRecord } from '../web-poc/lib/db/queries/workspaces.ts';
import { get as getCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { buildApp } from '../web-poc/worker/index.ts';
import { authenticate, decideGate, handleAuth, sendSignInLink } from './auth-gate.ts';
import { resolveCanvas } from './access.ts';
import { handleInvitationsApi, handleInviteAccept } from './invitations.ts';
import { handleConnectorSecretsApi } from './connector-secrets.ts';
import { handleGithubApi, handleGithubSetup, resolveDevAgentRepo, workspaceRepoSet } from './github-connection.ts';
import { handleAdminApi } from './admin.ts';
import { handleMembersApi } from './members.ts';
import { discoverJobs, evaluateScheduledJobs } from './repo-jobs.ts';
import { handleMcp, handleOAuthDiscovery } from './mcp-server.ts';
import { kickDevAgentRun, triggerDevAgentRun } from './dev-agent.ts';
import { kickWarehouseMaterialize } from './warehouse-dispatch.ts';
import { mintDevAgentGitToken, mintRepoReadToken } from './github-app.ts';
import { DEFAULT_WORKSPACE, resolve, type SandboxCoords } from './sandbox-resolver.ts';
import { sandboxFor, serveWorkspace, warehouseExec } from './sandbox-runtime.ts';
import { handleCanvasesApi, handleRecordPurgeApi, handleWorkspacesApi, renderLogin } from './shell.ts';
import { coordsForWorkspace, handleInboxBridge } from './inbox-bridge.ts';
import { handleInboxApi } from './inbox.ts';
import { handlePushApi } from './push.ts';
import { PLATFORM_RPC_PATH } from '../shared/platform-rpc.ts';
import { handlePlatformRpc, platformRpcDeps } from './platform-rpc.ts';
import { handleMcpReadApi, handleMcpTokenApi } from './mcp-tokens-api.ts';
import { probeMcpTools } from './mcp-probe.ts';
import { MCP_REGISTRY } from '../server/mcp-registry.ts';
import { handleShareLinksApi } from './share-links-api.ts';
import { handleShareAccept, readGuestSession } from './guest-session.ts';
import { decideGuestGate } from './guest-gate.ts';
import { guestCapabilities } from '../shared/guest-capabilities.ts';
import { handleCanvasMutate, parseCanvasMutatePath } from './canvas-mutate-api.ts';
import { handleCanvasSnapshot, parseCanvasSnapshotPath } from './canvas-snapshot-api.ts';
import { evictGuestSockets, handleSyncUpgrade, parseSyncPath } from './sync-api.ts';
import { handleCanvasAsset, parseAssetPath } from './canvas-assets.ts';
import { handleMartApi, martsForGuestCanvas, MART_ROUTE } from './mart-api.ts';
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';
import { ensureHuddleWorker, handleGuestHuddleJoin, handleHuddleJoin } from './huddle.ts';
import { IS_CHAT_SEND, effectiveMcpTokens, withMcpTokensHeader } from './mcp-tokens-proxy.ts';
import { INBOX_ASSIGN_HEADER } from '../shared/chat-wire.ts';
import {
  DEFAULT_CANVAS_ID,
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_COOKIE,
  decideCanvasRoute,
  decideWorkspaceRoute,
  parseCanvasRoute,
  parsePadRoute,
  parseWorkspaceRoute,
  readWorkspaceCookie,
} from './shell-routing.ts';
import {
  CANVAS_ID_HEADER,
  CHAT_KIND_HEADER,
  DEV_AGENT_CHAT_KIND,
  DEV_AGENT_GIT_TOKEN_HEADER,
  DEV_AGENT_REPO_HEADER,
  GUEST_CANVAS_HEADER,
  GUEST_CAPS_HEADER,
} from '../shared/bridge-wire.ts';

// One container = one workspace = one canvas (v1). The Worker is the proxy into the
// in-container vite dev server, which serves the app and forwards /api/* to the bridge.
// Edge Better Auth (ADR-0007, #45) is the SOLE gate — the legacy `cs_gate` shared-secret
// cookie was removed in the #47 cutover. Same preview-proxy path the
// SSE spike proved streams unbuffered, so the canvas SSE stream works as-is.
export class Sandbox extends BaseSandbox {
  // Sleep after idle (state survives in R2). The client idle gate (src/idle.ts) closes
  // both SSE streams after ~2m of no user activity (pointer/keyboard), so an open-but-idle
  // tab no longer pins the container via the 15s ping — this 5m window is the remaining
  // sleep delay once the streams go quiet (total idle-to-sleep ~7m).
  // Fallback only: the bridge self-exits on idle (server/bridge.ts) since the sandbox
  // won't idle-sleep while an SSE forward is pinned. sleepAfter still covers the
  // never-had-a-client case.
  sleepAfter = '5m';
}

// The warehouse container class (ADR-0017, #236): python + uv + dbt-duckdb + dlt +
// duckdb, built from a SEPARATE Dockerfile with no agent SDK — so extraction secrets
// (Slack/Stripe/Mercury, a future addition) are never reachable from a chat turn even
// by mistake. Dispatching a materialize run into it is a separate issue (out of scope
// here); this class + binding is the structural placement only.
export class Warehouse extends BaseSandbox {}

// The canvas sync room class (ADR-0019, #288). Re-exported here because wrangler resolves
// Durable Object classes off the entrypoint module's exports.
export { CanvasSyncRoom } from './canvas-sync-do.ts';

export interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  Warehouse: DurableObjectNamespace<Warehouse>;
  // One Durable Object per canvas, hosting that canvas's tldraw sync room (ADR-0019).
  // Addressed ONLY via `idFromName(syncRoomName(canvasId))` — see worker/sync-api.ts.
  // Unparameterised on purpose: `CanvasSyncRoom` is a plain class rather than a
  // `cloudflare:workers` `DurableObject` subclass (see canvas-sync-do.ts for why), so it
  // carries no `DurableObjectBranded` marker. Nothing calls it by RPC — the only traffic
  // is `stub.fetch` with the WebSocket upgrade — so the plain stub type is exactly right.
  CANVAS_SYNC: DurableObjectNamespace;
  // Workers static-assets binding for the Notebook SPA build (web-poc/dist, PRD #49
  // slice #58). Served under /notebook AFTER the edge session gate — it's app content,
  // so an unauthenticated hit gets the login, never the SPA.
  ASSETS: Fetcher;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  // Native R2 binding (ADR-0017, #238) — separate from the R2_* S3-compat creds above,
  // which only ever get forwarded into the container's Bun runtime. The edge Worker
  // itself (workerd) reads mart parquet straight off this binding, so browsing a mart
  // never wakes the container. Same bucket as R2_BUCKET; a native binding, not the S3
  // client, because Bun.S3Client isn't available in workerd.
  // Also the canvas asset bucket (ADR-0019): tldraw image/video bytes live here under
  // `canvas-assets/`, which needs the WRITE half `MartBucket` deliberately omits.
  MART_BUCKET: import('./mart-api.ts').MartBucket & import('./canvas-assets.ts').AssetBucket;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  // web-poc (mounted at the edge): the platform data layer on D1 (ADR-0018) + auth +
  // embeddings. Secrets (VOYAGE_API_KEY, BETTER_AUTH_SECRET) come from workerSecrets;
  // the two origins are plain vars in wrangler.jsonc.
  PLATFORM_DB: D1Database;
  VOYAGE_API_KEY?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  WEB_ORIGIN?: string;
  // E2E ONLY (#276), emitted only into the GENERATED local dev config (never wrangler.jsonc):
  // local dev runs no container, so `serveWorkspace` proxies to the bridge process instead.
  // See `localBridgeOrigin` in sandbox-resolver.ts for the two belts guarding it.
  E2E_MODE?: string;
  LOCAL_BRIDGE_ORIGIN?: string;
  // Kill-switch for the scheduled dev-agent run (#63/#66). Default off ("false"); the cron
  // fires but no-ops until repo-connection (#96) lands. Flip to "true" to enable.
  DEV_AGENT_ENABLED?: string;
  // GitHub App auth for the dev-agent (#96). The edge mints short-lived, repo-scoped
  // installation tokens from these (worker/github-app.ts) for clone/push/PR; the private key
  // stays at the edge and is NEVER forwarded into the container (the RCE boundary, ADR-0008).
  // From workerSecrets (provisioned in secrets.yaml). Unset ⇒ the dev-agent boots without a
  // git token and the push/PR path surfaces its own clear error.
  GITHUB_APP_ID?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // The App's public slug (github.com/apps/<slug>) for the workspace connect flow (#193,
  // ADR-0015). Plain var, not a secret. Unset ⇒ the Settings UI hides "Connect GitHub".
  GITHUB_APP_SLUG?: string;
  // Platform key sealing stored per-repo PATs at rest (ADR-0016, worker/secret-box.ts).
  // From workerSecrets. Unset ⇒ PAT repos can't be added and stored PATs can't be opened
  // (their repos degrade to unreachable); installation repos are unaffected.
  REPO_TOKEN_KEY?: string;
  // Bearer token for the `fredrin` MCP registry entry (ADR-0013 train 2): default-workspace
  // env fallback attached per chat send (worker/mcp-tokens-proxy.ts). Unset ⇒ fredrin is
  // simply not connected; a stored per-workspace token row overrides it.
  FREDRIN_KEY?: string;
  // Web push (#87). The edge only ever hands out the PUBLIC half — the browser needs it as
  // `applicationServerKey` to subscribe. The private key now stays HERE too: delivery moved to
  // the edge with ADR-0018 (worker/push-notify.ts), so no VAPID key reaches a container at all
  // and the container asks for a ping by name over the platform RPC. Unset ⇒ /api/push/key answers `''` and the
  // shell's opt-in toggle stays hidden, so push is simply off (the local-dev default).
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  // The single-tenant owner of everything the bridge files under a user id (Inbox
  // Conversations via `ask_human`, the dev-agent's promoted items): must be this
  // deployment's Better Auth user.id, NOT an email or display name — the Inbox query
  // filters by exactly that column. Unset ⇒ the bridge falls back to the literal string
  // `'default'`, which never matches a real authenticated user, so `ask_human` items
  // silently never appear in the Inbox. Revisit when #98 (multi-user) lands — a single
  // static id can't represent "whichever of N users is calling."
  CANVAS_USER?: string;
  // The www worker's waitlist D1, also bound here for the admin view (ADR-0014).
  // Unset in local dev ⇒ /api/admin/waitlist answers 503.
  WAITLIST?: D1Database;
  // Huddles (ADR-0017): LiveKit Cloud signing keys, edge-only — the container gets
  // short-lived minted room tokens, never these. Unset ⇒ join answers 503, no UI harm.
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
}

// Notebook's Hono API (web-poc's `buildApp`), mounted AT THE EDGE (ADR-0007, #56). No
// db is injected, so its `dbMiddleware` builds one per request via
// `createDbForWorker(c.env)` — the PLATFORM_DB D1 binding (ADR-0018) — so Notebook's
// `/v1/*` runs here without ever waking a container. Built once per isolate (route
// setup is pure); the db is per-request.
const notebookApi = buildApp();

// The kick's repo resolution (ADR-0015): runs target the default workspace's container, so
// its repository connection (row, else the transitional env fallback) names the repo set.
// Best-effort like the mint itself: a DB failure kicks token-less rather than failing the run.
const defaultWorkspaceRepo = async (env: Env, requested?: string) => {
  try {
    return await resolveDevAgentRepo(env, createDbForWorker(env as unknown as Bindings), DEFAULT_WORKSPACE_ID, requested);
  } catch (e: unknown) {
    console.error(`[dev-agent] repo resolution failed — kicking token-less: ${String(e)}`);
    return null;
  }
};

/** Push one repo's read-only checkout refresh into a workspace's container (ADR-0016):
 *  the read token rides a header, transient — the bridge fetches then scrubs it. Public
 *  repos push no token at all; the bridge clones the public HTTPS remote. */
const pushCheckoutRefresh = (env: Env, workspaceId: string, repo: string, token?: string): Promise<Response> =>
  serveWorkspace(
    new Request('https://bridge.internal/api/repos/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-repo-git-token': token } : {}) },
      body: JSON.stringify({ repo }),
    }),
    env,
    coordsForWorkspace(workspaceId),
  );

/** Domain cutover: a request on a non-canonical host (poc.cedarpad.com) 301s to the same
 * path+query on the canonical origin (WEB_ORIGIN). Same-host / unset / unparseable origin
 * ⇒ null (dev + preview + tests serve wherever they are). Exported for tests. */
export function canonicalRedirect(url: URL, webOrigin: string | undefined): Response | null {
  if (!webOrigin) return null;
  let canonicalHost: string;
  try {
    canonicalHost = new URL(webOrigin).host;
  } catch {
    return null;
  }
  if (url.host === canonicalHost || url.host.endsWith('.workers.dev') || url.hostname === 'localhost') return null;
  return Response.redirect(`${webOrigin}${url.pathname}${url.search}`, 301);
}

export default {
  // Cron trigger (ADR-0007 PRD #51, re-shaped by ADR-0011, narrowed by #100). The tick is an
  // EVALUATOR only: it dispatches repo-defined jobs that are due (see below). There is no
  // built-in jobless run any more — one mechanism, `.claude/jobs/`. `waitUntil` keeps the
  // isolate alive for the kicks (which may pay a cold boot) past the handler return.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Read-only checkout cadence (ADR-0016): the daily tick re-syncs the default
    // workspace's Repo checkouts. Best-effort, ungated (reads only), skipped while the
    // container is asleep — refresh-on-add and the Settings button cover the gaps.
    ctx.waitUntil(
      (async () => {
        const database = createDbForWorker(env as unknown as Bindings);
        const ws = await getWorkspaceRecord(database, DEFAULT_WORKSPACE_ID);
        if (!ws) return;
        const views = await workspaceRepoSet(env, database, ws);
        for (const v of views) {
          const token = await mintRepoReadToken(env, { nowSec: Math.floor(Date.now() / 1000), ...v }).catch(() => null);
          if (token || v.auth.kind === 'public') {
            await pushCheckoutRefresh(env, DEFAULT_WORKSPACE_ID, v.repoFullName, token ?? undefined).catch(() => {});
          }
        }
      })().catch((e: unknown) => console.error(`[repos] scheduled checkout refresh failed: ${String(e)}`)),
    );
    // Repo-defined scheduled jobs (#196, ADR-0015): the same tick evaluates the selected
    // repos' `daily` jobs against their lastRunAt stamps — the ONLY scheduled dispatch (#100).
    // DEV_AGENT_ENABLED stays the master breaker for scheduled work; best-effort — an
    // evaluator failure never breaks the tick.
    if (env.DEV_AGENT_ENABLED === 'true') {
      const database = createDbForWorker(env as unknown as Bindings);
      ctx.waitUntil(
        evaluateScheduledJobs(database, DEFAULT_WORKSPACE_ID, {
          nowMs: Date.now(),
          discover: () => discoverJobs(env, database, DEFAULT_WORKSPACE_ID, { nowSec: Math.floor(Date.now() / 1000) }),
          // The dispatch branch (#240): a `target: warehouse` job wakes the Warehouse
          // container instead of the bridge — batch, not an agent turn (ADR-0017). Every
          // other job (the default, `target: agent`) is unchanged from before this field
          // existed: a headless chat turn kicked at the warm canvas container.
          kick: (repo, job) =>
            job.target === 'warehouse'
              ? kickWarehouseMaterialize(env, { exec: warehouseExec })
              : kickDevAgentRun(env, { mint: mintDevAgentGitToken, serve: serveWorkspace, resolveRepo: defaultWorkspaceRepo }, repo, job),
        }).catch((e: unknown) => console.error(`[jobs] scheduled evaluation failed: ${String(e)}`)),
      );
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    // Domain cutover (2026-07-17): app.cedarpad.com is canonical; the legacy
    // poc.cedarpad.com host 301s to the same path+query so old share links and
    // bookmarks keep working. WEB_ORIGIN holds the canonical origin.
    const canonical = canonicalRedirect(url, env.WEB_ORIGIN);
    if (canonical) return canonical;

    // Public build stamp (#74). deploy.sh polls this post-deploy to confirm the SERVED
    // container image's SHA, and it carries no Better Auth session — so it's routed HERE,
    // ahead of the edge gate, straight to the default workspace container (the bridge's
    // /api/buildrev returns ONLY the SHA, never /api/status's health/client counts).
    // isPublicPath also lists it, but the gate below denies any null-user request, so the
    // stamp must be served before the gate to actually reach the container. This is the
    // one unauthenticated path that can cold-boot a container; bounded by max_instances.
    if (url.pathname === '/api/buildrev') {
      return serveWorkspace(request, env, resolve(DEFAULT_WORKSPACE));
    }

    // Edge auth (ADR-0007, slice #45) — the SOLE gate now that cs_gate is gone. Better
    // Auth's endpoints are served AT THE EDGE so login/session happen here without ever
    // proxying to a container; every other route must carry a valid session. This branch
    // precedes the Notebook mount below, so `buildApp`'s own `/api/auth/*` mount is never
    // reached — ONE auth path (this `handleAuth`) across the platform.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(request, env);
    }

    // Notebook API at the edge (ADR-0007, #56). `/v1/*` is served HERE against the
    // platform D1 (ADR-0018), so Notebook no longer depends on / wakes the container. It
    // SELF-gates via web-poc's `authMiddleware` (Better Auth session cookie OR
    // `x-api-key`) against the SAME `createAuth` the edge `/api/auth` path uses — one
    // auth system — so we deliberately route it BEFORE the edge session gate below (which
    // would `renderLogin` HTML and can't honour agent `x-api-key`). Notebook returns its
    // own JSON 401.
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      return notebookApi.fetch(request, env as never);
    }
    // Verify the session and decide the gate BEFORE the resolver/proxy below — an
    // unauthenticated request never reaches serveWorkspace, so it never reaches the
    // container. Notebook's /v1/* verifies the SAME Better Auth session (same D1, same
    // secret, same cookie), so one auth system spans the platform.
    // #177 inbound MCP: OAuth discovery at the origin root (public — clients fetch these
    // before they hold any token) and the /mcp endpoint itself, which self-gates on its
    // bearer (401 + WWW-Authenticate, never the login page, never the session cookie).
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/oauth-protected-resource') {
      return handleOAuthDiscovery(request, env, url.pathname);
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, env);
    }

    // The platform RPC (ADR-0018): the container calling back for the two writes that
    // originate inside it. Routed ahead of the session gate for the same reason /mcp is — the
    // caller is a process, not a browser, so it has no Better Auth cookie and the gate would
    // hand it the login page. It SELF-gates on a bearer derived from BETTER_AUTH_SECRET (the
    // same trust root the guest cookie is signed with), so an unauthenticated request cannot
    // invoke either operation.
    if (url.pathname === PLATFORM_RPC_PATH) {
      return handlePlatformRpc(request, env, platformRpcDeps(env, createDbForWorker(env as unknown as Bindings)));
    }

    const session = await authenticate(request, env);

    // Canvas sync (ADR-0019): the WebSocket upgrade into the canvas's Durable-Object-hosted
    // TLSocketRoom. Routed AHEAD of the session gate below and SELF-GATING, for the same
    // reason /mcp is: the gate's deny branch answers with the login HTML at 200, which a
    // WebSocket client cannot act on. handleSyncUpgrade answers 401/403 instead, and no
    // Durable Object is addressed until it has authorized the caller for THIS canvas.
    const syncCanvasId = parseSyncPath(url.pathname);
    if (syncCanvasId) {
      return handleSyncUpgrade(request, env, syncCanvasId, session?.user ?? null);
    }

    // The agent write path onto the same room (ADR-0019, #291). Self-gating for the same
    // reason as the upgrade above: an agent client needs a status code, not login HTML.
    const mutateCanvasId = parseCanvasMutatePath(url.pathname);
    if (mutateCanvasId) {
      return handleCanvasMutate(request, env, mutateCanvasId, session?.user ?? null);
    }

    // The migration door onto the same room (#295): export/import a room snapshot.
    // Self-gating like the two above, and ADMIN-only — see canvas-snapshot-api.ts.
    const snapshotCanvasId = parseCanvasSnapshotPath(url.pathname);
    if (snapshotCanvasId) {
      return handleCanvasSnapshot(request, env, snapshotCanvasId, session?.user ?? null);
    }

    // Canvas assets (ADR-0019): the R2 bytes behind an image shape's `src`. Self-gating
    // for the same reason as the upgrade above — an `<img>` renders the gate's 200 login
    // page as a broken box, so a refusal has to be a status code.
    const assetRef = parseAssetPath(url.pathname);
    if (assetRef) {
      return handleCanvasAsset(request, env, assetRef, session?.user ?? null);
    }

    // #179: the invite accept flow — reachable WITHOUT a session (the email-bound,
    // single-use token is the credential; the deny branch below would render the login
    // page). Routed like /api/auth: ahead of the gate, never proxied to a container.
    const inviteMatch = /^\/invite\/([^/]+)$/.exec(url.pathname);
    if (inviteMatch) {
      return handleInviteAccept(
        request,
        createDbForWorker(env as unknown as Bindings),
        session?.user ?? null,
        // Capture group is `[^/]+` (one or more chars) — always defined when the match succeeds.
        inviteMatch[1]!,
        { sendSignInLink: sendSignInLink(env) },
      );
    }

    // #220: the guest share door — reachable WITHOUT a session, like /invite (the link id
    // is the credential). A live link mints the signed cs_guest cookie (worker/guest-session.ts)
    // and 302s into the app; the gate below learns to accept that cookie (slice 4).
    const shareMatch = /^\/share\/([^/]+)$/.exec(url.pathname);
    if (shareMatch) {
      return handleShareAccept(
        request,
        createDbForWorker(env as unknown as Bindings),
        env.BETTER_AUTH_SECRET ?? '',
        shareMatch[1] as string,
      );
    }

    /** Serve `path` out of the static-assets build (shell/dist), preserving method/headers. */
    const asset = (path: string) => {
      const assetUrl = new URL(request.url);
      assetUrl.pathname = path;
      return env.ASSETS.fetch(new Request(assetUrl, request));
    };

    const gate = decideGate(url.pathname, session);
    if (gate.decision === 'deny' || !gate.user) {
      // #220 slice 4: no member session — maybe a GUEST session (the signed cs_guest
      // cookie minted by /share/<linkId>). Confinement is decideGuestGate's default-deny
      // allowlist scoped to the link's canvas; on top of it, the link row is re-checked
      // EVERY request so revoking a link kills its sessions at the next hit. Anything
      // that fails any of these falls through to the login page, exactly like today.
      const guest = env.BETTER_AUTH_SECRET
        ? await readGuestSession(request.headers.get('cookie'), env.BETTER_AUTH_SECRET)
        : null;
      if (guest) {
        const canvas = request.headers.get(CANVAS_ID_HEADER) ?? url.searchParams.get('canvas');
        // The one guest-only edge endpoint sits OUTSIDE decideGuestGate's proxy allowlist:
        // it's answered here, never proxied. The Shell probes it on boot to pick guest mode.
        const isGuestProbe = url.pathname === '/api/guest-session' && request.method === 'GET';
        // Huddle join (ADR-0017): edge-answered like the probe, never proxied. The
        // capability is re-read off the LIVE link row (not the cookie) so revoking or
        // downgrading a link takes effect at the next join.
        const guestHuddleMatch = /^\/api\/canvases\/([^/]+)\/huddle\/join$/.exec(url.pathname);
        // Marts (ADR-0017, #238): edge-answered like the probe/huddle above, never
        // proxied — reading R2 directly must never wake the container. The route's own
        // :ws segment is ignored for guests; only the LINK's workspace is ever read, so a
        // guest can't slide a foreign workspace id into the path.
        const guestMartMatch = MART_ROUTE.exec(url.pathname);
        // #320: the LIVE row is read BEFORE the gate decides, because it is the source of
        // the capabilities as well as of liveness. The cookie carries a snapshot of the
        // grants at mint time; a link that has since been downgraded must not keep what it
        // was minted with, exactly as a revoked one does not. One derivation
        // (`guestCapabilities`) feeds this door, the sync handshake and the bridge.
        const live = await getActiveShareLink(createDbForWorker(env as unknown as Bindings), guest.linkId);
        if (live && live.canvasId === guest.canvasId) {
          const caps = guestCapabilities({ ...live, shapeId: live.shapeId ?? guest.shapeId });
          const guestGate = decideGuestGate({ pathname: url.pathname, method: request.method, canvas }, guest, caps);
          if (isGuestProbe || guestHuddleMatch || guestMartMatch || guestGate.decision === 'allow') {
            if (isGuestProbe) {
              return Response.json({
                canvasId: guest.canvasId,
                workspaceId: guest.workspaceId,
                guestChat: caps.chat,
                guestHuddle: caps.huddle,
                capabilities: caps,
                // Component-scoped link (PRD #221): the Shell/pad narrow to this shape.
                ...(guest.shapeId ? { shapeId: guest.shapeId } : {}),
              });
            }
            if (guestMartMatch) {
              // ADR-0017 guest scoping: resolve THIS canvas's own referenced marts fresh
              // every request — never cached, never trusted from the client. The source is
              // the canvas's sync ROOM (ADR-0019, #289), not `canvas-state.json`: the blob
              // is stale once the DO owns the document, so a mart removed from the canvas
              // would still be served. The reader identity is the link, stamped only after
              // the live share-link re-check above.
              const name = guestMartMatch[2] as string;
              const marts = await martsForGuestCanvas(env.CANVAS_SYNC, guest.canvasId, `guest:${guest.linkId}`);
              return handleMartApi(env.MART_BUCKET, guest.workspaceId, name, { kind: 'guest', marts });
            }
            if (guestHuddleMatch) {
              if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
                return Response.json({ error: 'huddle not configured' }, { status: 503 });
              }
              const lk = { LIVEKIT_URL: env.LIVEKIT_URL, LIVEKIT_API_KEY: env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET };
              const res = await handleGuestHuddleJoin(
                request,
                { ...guest, guestHuddle: caps.huddle },
                guestHuddleMatch[1] as string,
                lk,
              );
              if (res.ok) {
                await ensureHuddleWorker(lk, guest.canvasId, (req) =>
                  serveWorkspace(req, env, coordsForWorkspace(guest.workspaceId)),
                );
              }
              return res;
            }
            if (url.pathname === '/') return asset('/');
            if (url.pathname.startsWith('/assets/')) return asset(url.pathname);
            // Everything else allowed by the guest gate proxies to the LINK's workspace
            // container — never the cs_workspace cookie's (a guest can't pick a container).
            // x-guest-canvas is the bridge's confinement signal (#220 slice 6: chat stream
            // filtering, view-only member conversations) — stamped HERE, overwriting
            // anything the client sent, so it can never be spoofed upward.
            // x-guest-caps carries the SAME capabilities this gate just decided from
            // (#320), stamped the same way and for the same reason — so the bridge's own
            // guest checks derive from one answer instead of inventing a second one. The
            // gate says which routes are reachable; the bridge holds facts the edge cannot
            // see (a module's tier), and needs the capabilities to judge them.
            const guestProxied = new Request(request);
            guestProxied.headers.set(GUEST_CANVAS_HEADER, guest.canvasId);
            guestProxied.headers.set(GUEST_CAPS_HEADER, JSON.stringify(caps));
            return serveWorkspace(guestProxied, env, coordsForWorkspace(guest.workspaceId));
          }
        }
      }
      // Sole-gate deny: serve the edge Better Auth login (#47 cutover) so an
      // unauthenticated user can sign in — never the deleted cs_gate `?key=` page,
      // and never the container.
      return renderLogin();
    }
    const user = gate.user;

    // The Shell SPA (ADR-0007, PRD #103) — the ONE chrome, served HERE from the static-assets
    // build behind the gate above. THE INVARIANT: `/` must reach env.ASSETS without ever
    // calling serveWorkspace/sandboxFor, so browsing the shell never wakes (or bills) a
    // container. Mounting the pad iframe (/w/:ws/canvas/:id/pad, below) is the only thing
    // that does. `/assets/*` is vite's default output prefix and cannot collide with the
    // container's dev-server paths (`/src/*`, `/@vite/*`, `/node_modules/*`), which still
    // fall through to serveWorkspace at the bottom.
    //
    // Request '/' itself, NOT '/index.html': Workers static-assets' default html_handling
    // ("auto-trailing-slash") 307s an explicit `/index.html` request to its canonical `/`
    // form. Passing that path here made ASSETS hand back that redirect, which we returned
    // verbatim — the browser followed it back to `/`, which asked for `/index.html` again,
    // forever (prod outage, ERR_TOO_MANY_REDIRECTS). `/` is already canonical, so ASSETS
    // serves it directly with no redirect.
    if (url.pathname === '/') return asset('/');
    if (url.pathname.startsWith('/assets/')) return asset(url.pathname);

    // The push service worker (#87). Served from the ROOT path on purpose: a service worker's
    // default scope is its own directory, and it must control `/` to focus an existing shell
    // tab on notification click. It sits behind the gate like the shell itself — the browser
    // sends cookies on a same-origin SW fetch, and it's only ever registered post-login.
    if (url.pathname === '/sw.js') return asset('/sw.js');

    // Notebook is a Shell stage now (ADR-0007, PRD #103 slice #107), not its own SPA
    // surface — the bare URL bounces to the shell with the stage selected, so a bookmark
    // or link to `/notebook` still lands on Notebook, just inside the one chrome. Its
    // assets still build into shell/dist/notebook (base `/notebook/`, PRD #49 slice #58)
    // and share the shell's ASSETS binding, so `/notebook/assets/*` must keep resolving
    // as a static asset — only the BARE surface redirects.
    if (url.pathname === '/notebook' || url.pathname === '/notebook/') {
      return new Response(null, { status: 302, headers: { location: '/?stage=notebook' } });
    }
    if (url.pathname.startsWith('/notebook/')) {
      return asset(url.pathname);
    }

    // Edge Shell (ADR-0007, #46). The launcher + its registry API are served HERE — no
    // container is proxied to for either — so listing/creating a workspace never wakes
    // one. Only opening a workspace (/w/:id) routes to a container.

    // #220 slice 5: a MEMBER session is never a guest — the Shell's boot probe answers
    // null here so the full chrome renders. (The guest branch above answers the scope.)
    if (url.pathname === '/api/guest-session') return Response.json(null);

    // Registry API the launcher calls (owner-OR-member list, owner create).
    if (url.pathname === '/api/workspaces') return handleWorkspacesApi(request, env, user);

    // Workspace invitations (#179): owner-only issuance/list/revoke, served at the edge.
    const invitationsMatch = /^\/api\/workspaces\/([^/]+)\/invitations(?:\/([^/]+))?$/.exec(url.pathname);
    if (invitationsMatch) {
      return handleInvitationsApi(
        request,
        createDbForWorker(env as unknown as Bindings),
        user,
        // Capture group is `[^/]+` (one or more chars) — always defined when the match succeeds.
        invitationsMatch[1]!,
        invitationsMatch[2],
        { sendSignInLink: sendSignInLink(env) },
      );
    }

    // Workspace roster (#192, Settings stage): list owner+members (workspace-visible),
    // owner-only removal. Edge-served like invitations — no container woken.
    const membersMatch = /^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/.exec(url.pathname);
    if (membersMatch) {
      return handleMembersApi(
        request,
        createDbForWorker(env as unknown as Bindings),
        user,
        // Capture group is `[^/]+` (one or more chars) — always defined when the match succeeds.
        membersMatch[1]!,
        membersMatch[2],
      );
    }

    // The explicit purge (ADR-0022 decision 9, #364): the one door that reclaims what a
    // canvas deletion soft-deleted. Owner-only, edge-served, and deliberately NOT reachable
    // from the canvas DELETE above — no single click may destroy source.
    const recordPurgeMatch = /^\/api\/workspaces\/([^/]+)\/records\/purge$/.exec(url.pathname);
    if (recordPurgeMatch) {
      return handleRecordPurgeApi(
        request,
        createDbForWorker(env as unknown as Bindings),
        user,
        // Capture group is `[^/]+` (one or more chars) — always defined when the match succeeds.
        recordPurgeMatch[1]!,
      );
    }

    // Marts (ADR-0017, #238): a member may read any mart in a workspace they belong to —
    // membership checked against the DB exactly like invitations/members above. Edge-read
    // parquet straight off R2 (never proxied), so browsing never wakes the container.
    const martMatch = MART_ROUTE.exec(url.pathname);
    if (martMatch) {
      const wsId = martMatch[1] as string;
      const name = martMatch[2] as string;
      if (!(await getWorkspace(createDbForWorker(env as unknown as Bindings), wsId, user.id))) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return handleMartApi(env.MART_BUCKET, wsId, name, { kind: 'member' });
    }

    // Admin surface (ADR-0014): waitlist view, role=admin only. Edge-served.
    if (url.pathname === '/api/admin/waitlist') {
      return handleAdminApi(request, createDbForWorker(env as unknown as Bindings), user, env.WAITLIST);
    }

    // Repository connection (#193, ADR-0015): status / connect redirect / repo selection /
    // disconnect, plus GitHub's post-install setup callback. Edge-only.
    const githubMatch = /^\/api\/workspaces\/([^/]+)\/github(?:\/(connect|repos|external|refresh|public))?$/.exec(url.pathname);
    if (githubMatch) {
      const wsId = githubMatch[1] as string;
      return handleGithubApi(
        request,
        env,
        createDbForWorker(env as unknown as Bindings),
        user,
        wsId,
        githubMatch[2] as 'connect' | 'repos' | 'external' | 'refresh' | 'public' | undefined,
        {
          nowMs: Date.now(),
          pushRefresh: (repo, token) => pushCheckoutRefresh(env, wsId, repo, token),
          waitUntil: (p) => ctx.waitUntil(p),
        },
      );
    }
    if (url.pathname === '/api/github/setup') {
      return handleGithubSetup(request, env, createDbForWorker(env as unknown as Bindings), user, { nowMs: Date.now() });
    }

    // Connector secrets (#241): per-workspace encrypted third-party credentials (dlt
    // sources for the warehouse pipeline, ADR-0017). Owner-gated mutation, member-visible
    // list (name + presence only — never plaintext or ciphertext). Edge-only.
    const connectorsMatch = /^\/api\/workspaces\/([^/]+)\/connectors$/.exec(url.pathname);
    if (connectorsMatch) {
      const wsId = connectorsMatch[1] as string;
      return handleConnectorSecretsApi(request, env, createDbForWorker(env as unknown as Bindings), user, wsId);
    }

    // Canvas registry API (Canvas app index), scoped to the active workspace via the
    // cs_workspace cookie. Served at the edge like /api/workspaces — no container woken.
    if (url.pathname === '/api/canvases') {
      return handleCanvasesApi(request, createDbForWorker(env as unknown as Bindings), user);
    }
    const canvasApiMatch = /^\/api\/canvases\/([^/]+)$/.exec(url.pathname);
    if (canvasApiMatch) {
      return handleCanvasesApi(request, createDbForWorker(env as unknown as Bindings), user, canvasApiMatch[1]);
    }

    // Huddles (ADR-0017): join mints a canvas-scoped LiveKit room token at the edge
    // (signing keys never leave here) and pokes the canvas's bridge to ensure the agent
    // worker. Access is 404-checked inside the handler exactly like share links.
    const huddleJoinMatch = /^\/api\/canvases\/([^/]+)\/huddle\/join$/.exec(url.pathname);
    if (huddleJoinMatch) {
      if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
        return Response.json({ error: 'huddle not configured' }, { status: 503 });
      }
      const lk = { LIVEKIT_URL: env.LIVEKIT_URL, LIVEKIT_API_KEY: env.LIVEKIT_API_KEY, LIVEKIT_API_SECRET: env.LIVEKIT_API_SECRET };
      const huddleCanvasId = huddleJoinMatch[1] as string;
      const workerDb = createDbForWorker(env as unknown as Bindings);
      const res = await handleHuddleJoin(request, workerDb, user, huddleCanvasId, lk);
      if (res.ok) {
        const cvRow = huddleCanvasId === DEFAULT_CANVAS_ID ? null : await getCanvas(workerDb, huddleCanvasId);
        const wsId = huddleCanvasId === DEFAULT_CANVAS_ID ? DEFAULT_WORKSPACE_ID : cvRow?.workspaceId;
        const coords = coordsForWorkspace(wsId as string);
        await ensureHuddleWorker(lk, huddleCanvasId, (req) => serveWorkspace(req, env, coords));
      }
      return res;
    }

    // Canvas share links (canvas ADR-0015, PRD #220): mint/list/revoke the guest door's
    // capability rows. Member-checked through the canvas's workspace; edge-only.
    const shareLinksMatch = /^\/api\/canvases\/([^/]+)\/share-links(?:\/([^/]+))?$/.exec(url.pathname);
    if (shareLinksMatch) {
      return handleShareLinksApi(
        request,
        createDbForWorker(env as unknown as Bindings),
        user,
        shareLinksMatch[1] as string,
        shareLinksMatch[2],
        // #320 §5: revoking must also drop the link's already-open sync sockets — their
        // capabilities were fixed at the handshake, so the tombstone alone would leave the
        // connected guest writing.
        (linkId) => evictGuestSockets(env, shareLinksMatch[1] as string, linkId, user.id),
      );
    }

    // Edge Inbox API (ADR-0007, PRD #50 slice #62), user-scoped. Served HERE against the
    // platform D1 + R2: list/detail/close/reopen never wake a container (history reads
    // from the R2 transcript while the runner sleeps); only reply forwards into the
    // container (#61).
    const inboxApiMatch = /^\/api\/inbox(?:\/([^/]+)(?:\/(reply|close|reopen|assign|visibility|merge))?)?$/.exec(url.pathname);
    if (inboxApiMatch) {
      return handleInboxApi(request, env, user, inboxApiMatch[1], inboxApiMatch[2]);
    }

    // Web push device registry (#87) — the opt-in behind the Inbox's `notify` seam. Edge-only
    // (no container woken); the bridge reads the rows back when it needs to ping.
    const pushApiMatch = /^\/api\/push\/([^/]+)$/.exec(url.pathname);
    if (pushApiMatch) {
      return handlePushApi(request, env, user, pushApiMatch[1]);
    }

    // External MCP owner consent (ADR-0013 train 2, #176): connect/disconnect a registry
    // server's per-workspace bearer token. Edge-only (no container woken) — the token is read
    // back out only when a chat send is proxied (below / worker/inbox-bridge.ts).
    const mcpTokenApiMatch = /^\/api\/workspaces\/([^/]+)\/mcp\/([^/]+)\/token$/.exec(url.pathname);
    if (mcpTokenApiMatch) {
      return handleMcpTokenApi(request, env, user, mcpTokenApiMatch[1] as string, mcpTokenApiMatch[2] as string);
    }
    // Member-readable MCP reads (per-chat selection UI): registry list + a server's tool
    // names. The token stays at the edge; only names cross to the browser.
    const mcpReadApiMatch = /^\/api\/workspaces\/([^/]+)\/mcp(?:\/([^/]+)\/tools)?$/.exec(url.pathname);
    if (mcpReadApiMatch) {
      return handleMcpReadApi(
        request,
        env,
        user,
        mcpReadApiMatch[1] as string,
        { registry: MCP_REGISTRY, tokens: effectiveMcpTokens, probeTools: probeMcpTools },
        mcpReadApiMatch[2],
      );
    }

    // Jobs trigger: run the dev-agent NOW on demand (Jobs stage "Run now" / API). Auth-gated (we're
    // below the session gate, so `user` is signed in) but NOT DEV_AGENT_ENABLED-gated — that flag
    // only kills the daily CRON; a manual trigger is an explicit user action. ADR-0011: the kick
    // mints the per-turn git token and proxies POST /api/dev-agent/run to the warm bridge, which
    // dispatches it as a headless chat turn — the bridge's { chatId, joined } answer is returned
    // through, so the UI can point at the (possibly already-running) run's conversation. The
    // bridge single-flights runs with JOIN semantics; repeated clicks answer with the same run.
    // A `target: warehouse` job instead routes to kickWarehouseMaterialize (#248) — "Run now"
    // parity with the scheduler's own dispatch, still gated by this same route/session (no
    // second authorization model), still batch: no bridge, no Conversation, no git token.
    if (url.pathname === '/api/jobs/dev-agent/run') {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      // Body { job, repo? }: `job` is REQUIRED (#100 — a jobless kick is a 400, never a
      // default run) and names a repo-defined job (#195); its body is (re-)read off the repo's
      // DEFAULT branch here — the merge armed it; a caller can never inject a prompt. `repo`
      // optionally disambiguates a job name across selected repos (must be in the set).
      const body = (await request.json().catch(() => null)) as { repo?: string; job?: string } | null;
      return triggerDevAgentRun(
        env,
        {
          mint: mintDevAgentGitToken,
          serve: serveWorkspace,
          resolveRepo: defaultWorkspaceRepo,
          discover: (e) =>
            discoverJobs(e, createDbForWorker(e as unknown as Bindings), DEFAULT_WORKSPACE_ID, {
              nowSec: Math.floor(Date.now() / 1000),
            }),
          kickWarehouse: () => kickWarehouseMaterialize(env, { exec: warehouseExec }),
        },
        body,
        // Shared inbox: the manual trigger's Conversation is assigned to who clicked.
        user.id,
      );
    }

    // Repo-defined jobs (#195, ADR-0015): what `.claude/jobs/` on the selected repos' default
    // branches define, discovered live (SHA-cached). Edge-only; access-checked; prompt omitted
    // (the run path re-reads it — the list is a rendering surface, not a prompt channel).
    const jobsMatch = /^\/api\/workspaces\/([^/]+)\/jobs$/.exec(url.pathname);
    if (jobsMatch && request.method === 'GET') {
      const database = createDbForWorker(env as unknown as Bindings);
      const ws = await getWorkspace(database, jobsMatch[1] as string, user.id);
      if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
      const jobs = await discoverJobs(env, database, ws.id, { nowSec: Math.floor(Date.now() / 1000) });
      return Response.json({ jobs: jobs.map(({ prompt, ...j }) => j) });
    }

    // Edge chat proxy (ADR-0009, PRD #119 slice #122): a Shell-mounted <ChatView> targets
    // `/inbox/:convId/bridge/*` so its live stream + send + interrupt + transcript + alive
    // reach the Conversation's OWNING runner bridge. BELOW the gate above (dispatch order is
    // security-load-bearing) — an unauthenticated request got `renderLogin()` already and can
    // never reach a bridge. `handleInboxBridge` ownership-checks the Conversation against
    // `user`, resolves `conv.workspaceId → coords`, strips this prefix, and proxies the raw
    // sub-path (`/api/...`, captured query-free) unrewritten via `serveWorkspace`. The Inbox
    // LIST (`/api/inbox`, above) stays edge-only and never wakes a runner.
    const inboxBridgeMatch = /^\/inbox\/([^/]+)\/bridge(\/.*)?$/.exec(url.pathname);
    if (inboxBridgeMatch) {
      // First capture group is `[^/]+` (one or more chars) — always defined when the match succeeds.
      return handleInboxBridge(request, env, user, inboxBridgeMatch[1]!, inboxBridgeMatch[2] ?? '/');
    }

    // The Inbox is a Shell stage now (#108) — no standalone page. The legacy edge route
    // redirects to the stage URL so old bookmarks/links land inside the one chrome. Behind
    // the gate above, so an unauthenticated hit still gets the login first.
    if (url.pathname === '/inbox') {
      return new Response(null, { status: 302, headers: { location: '/?stage=inbox' } });
    }

    // Ownership check shared by the two canvas routes below: the workspace must be owned
    // (the legacy `default` id needs no row) AND the canvas must belong to it, else the
    // request is 404'd here and never proxied. This branch is BELOW the auth gate above,
    // so an unauthenticated request can never reach it — nor cold-boot a container.
    const ownedCanvas = async (workspaceId: string, canvasId: string) => {
      const workerDb = createDbForWorker(env as unknown as Bindings);
      // #179: EVERY workspace — `default` included (it has a seeded row) — is looked up
      // owner-OR-member; a missing row fails closed. No bypass. The canvas leg (registered
      // to this workspace + ADR-0016 visible) is the access seam: a private canvas is 404
      // to everyone but its creator — the workspace owner included (manage-not-read). The
      // legacy `default` canvas has no registry row and decideCanvasRoute always selects it.
      const wsRecord = await getWorkspace(workerDb, workspaceId, user.id);
      const visible =
        canvasId === DEFAULT_CANVAS_ID ? null : await resolveCanvas(workerDb, workspaceId, canvasId, user.id);
      return decideCanvasRoute(workspaceId, canvasId, wsRecord, visible);
    };

    /** cs_workspace pins which container the absolute-path asset/API fallthrough proxies to. */
    const workspaceCookie = (workspaceId: string) =>
      `${WORKSPACE_COOKIE}=${workspaceId}; Path=/; HttpOnly; Secure; SameSite=Lax`;

    // /w/:workspaceId/canvas/:canvasId/pad — the Render Pad's own URL (#105). Served IN
    // PLACE (no redirect) so the URL stays stable: the Shell iframes it, and the frontend
    // reads its canvas id back off the pathname (src/active-canvas.ts) rather than from a
    // browser-global cookie — which is what lets two tabs hold two canvases.
    const padRoute = parsePadRoute(url.pathname);
    if (padRoute) {
      const decision = await ownedCanvas(padRoute.workspaceId, padRoute.canvasId);
      if (decision.decision === 'not-found') {
        return new Response('canvas not found', { status: 404 });
      }
      const proxied = await serveWorkspace(request, env, coordsForWorkspace(decision.workspaceId));
      const response = new Response(proxied.body, proxied);
      response.headers.append('set-cookie', workspaceCookie(decision.workspaceId));
      return response;
    }

    // /w/:workspaceId/canvas/:canvasId — the canvas deep-link. Pins the workspace
    // (cs_workspace, HttpOnly — the proxy routes by it) and redirects to that canvas's pad.
    // It must NOT land on `/`: the canvas id used to ride along in cs_canvas, and with the
    // cookie gone `/` would silently serve the DEFAULT canvas instead of the requested one.
    const canvasRoute = parseCanvasRoute(url.pathname);
    if (canvasRoute) {
      const decision = await ownedCanvas(canvasRoute.workspaceId, canvasRoute.canvasId);
      if (decision.decision === 'not-found') {
        return new Response('canvas not found', { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: new Headers([
          ['set-cookie', workspaceCookie(decision.workspaceId)],
          ['location', `/w/${encodeURIComponent(decision.workspaceId)}/canvas/${encodeURIComponent(decision.canvasId)}/pad`],
        ]),
      });
    }

    // /w/:workspaceId — the app-surface URL. Enforce ownership via the registry (the
    // `default` id is the legacy prod workspace and needs no row), then pin the
    // selection in a cookie and land on the canvas. An unknown/non-owned id is 404 —
    // never proxied. The cookie carries the selection because the canvas frontend loads
    // absolute-path assets (/src, /api) that can't live under a /w/:id prefix.
    const route = parseWorkspaceRoute(url.pathname);
    if (route) {
      // #179: `default` is access-checked like any workspace (seeded row; owner-OR-member).
      const record = await getWorkspace(createDbForWorker(env as unknown as Bindings), route.workspaceId, user.id);
      if (decideWorkspaceRoute(route.workspaceId, record).decision === 'not-found') {
        return new Response('workspace not found', { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          'set-cookie': `${WORKSPACE_COOKIE}=${route.workspaceId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
          location: '/',
        },
      });
    }

    // Which workspace to serve: the cookie set by /w/:id above (ownership already
    // checked at set-time), defaulting to the legacy workspace when unset — so direct
    // asset/API hits with no selection behave exactly as today.
    const selected = readWorkspaceCookie(request.headers.get('cookie'));

    const workspaceId = selected ?? DEFAULT_WORKSPACE_ID;
    const coords = coordsForWorkspace(workspaceId);

    // Force the container to recycle so a freshly deployed image takes effect (CF
    // keeps the in-use instance on the old image until it idle-sleeps). The next
    // request cold-boots the new image; canvas-state restores from R2.
    if (url.pathname === '/__recycle') {
      const sandbox = sandboxFor(env, coords.sandboxId);
      const r = await sandbox.stop().then(() => 'stopped').catch((e) => String(e));
      return Response.json({ recycle: r });
    }

    // Container stdout (the [boot] phase lines + vite/bridge startup) is NOT in
    // Workers Observability yet (CF gap), so surface getProcessLogs directly. Gated.
    if (url.pathname === '/__bootlog') {
      const sandbox = sandboxFor(env, coords.sandboxId);
      const r: unknown = await sandbox.getProcessLogs('canvas').catch((e) => ({ error: String(e) }));
      const body =
        typeof r === 'string'
          ? r
          : [(r as { stdout?: string }).stdout, (r as { stderr?: string }).stderr].filter(Boolean).join('\n') ||
            JSON.stringify(r, null, 2);
      return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // ADR-0013 train 2 (#176): the same-origin chat send path (the pad's <ChatView>, which is
    // not inbox-adopted) gets the workspace's connected external-MCP tokens exactly like the
    // Inbox proxy does (worker/inbox-bridge.ts) — same header, same "no tokens ⇒ untouched".
    const isChatSend = request.method === 'POST' && IS_CHAT_SEND.test(url.pathname);
    // The edge-owned headers below are answers the edge alone writes, so a client-sent copy of
    // any of them must never survive into the container — on ANY request, not only a send.
    // Cloning is skipped entirely when the client sent none (the overwhelmingly common case).
    const forged = [CHAT_KIND_HEADER, DEV_AGENT_GIT_TOKEN_HEADER, DEV_AGENT_REPO_HEADER];
    const asksDevAgent = isChatSend && request.headers.get(CHAT_KIND_HEADER) === DEV_AGENT_CHAT_KIND;
    let proxied = request;
    if (isChatSend || forged.some((h) => request.headers.has(h))) {
      proxied = new Request(request);
      for (const h of forged) proxied.headers.delete(h);
    }
    if (isChatSend) {
      // Shared-inbox assignment: a pad send is a human act — stamp its initiator so the
      // bridge assigns the born Conversation to them (overwrites any client-sent value).
      proxied.headers.set(INBOX_ASSIGN_HEADER, user.id);
      proxied = await withMcpTokensHeader(proxied, env, workspaceId);
      // Chat-kind selection (CEDA-N67Y50): the Inbox's "+ New chat" draft has no Conversation
      // row, so worker/inbox-bridge.ts's row-driven arming has nothing to key on — the draft
      // declares the kind it wants to be born as on `x-chat-kind` instead, and the edge answers
      // with the same per-send mint the Inbox proxy does. The ask was already stripped above,
      // so the token stays the complete definition of a dev-agent turn (ADR-0010/0011). Once
      // born the row IS dev-agent and every later send re-arms through the Inbox proxy — this
      // is the birth case only.
      if (asksDevAgent) {
        // Best-effort, exactly as the Inbox proxy's mint is: a workspace with no connected repo
        // proxies the send unarmed, and the chat simply files as an ordinary one.
        const resolved = await resolveDevAgentRepo(env, createDbForWorker(env as unknown as Bindings), workspaceId).catch(
          (e: unknown) => {
            console.error(`[dev-agent] repo resolution failed — new chat starts token-less: ${String(e)}`);
            return null;
          },
        );
        if (resolved) {
          proxied.headers.set(DEV_AGENT_REPO_HEADER, resolved.repoFullName);
          const token = await mintDevAgentGitToken(env, { nowSec: Math.floor(Date.now() / 1000), ...resolved });
          if (token) proxied.headers.set(DEV_AGENT_GIT_TOKEN_HEADER, token);
        }
      }
    }

    return serveWorkspace(proxied, env, coords);
  },
};
