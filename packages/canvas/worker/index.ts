import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { get as getCanvas } from '../web-poc/lib/db/queries/canvases.ts';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { authenticate, decideGate, handleAuth, sendSignInLink } from './auth-gate.ts';
import { resolveCanvas } from './access.ts';
import { handleInvitationsApi, handleInviteAccept } from './invitations.ts';
import { handleAdminApi } from './admin.ts';
import { handleComponentsApi } from './components-api.ts';
import { handleComponentInventory, INVENTORY_PATH } from './component-inventory-api.ts';
import { handleMembersApi } from './members.ts';
import { handleMcp, handleOAuthDiscovery } from './mcp-server.ts';
import { DEFAULT_WORKSPACE, coordsForWorkspace, resolve, type SandboxCoords } from './sandbox-resolver.ts';
import { handleAdminHost, isAdminHost } from './admin-page.ts';
import { serveCanvasContainer, serveWorkspace } from './sandbox-runtime.ts';
import { handleCanvasesApi, handleRecordPurgeApi, handleWorkspacesApi, renderLogin } from './shell.ts';
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
import { getActiveShareLink } from '../web-poc/lib/db/queries/share-links.ts';
import { ensureHuddleWorker, handleGuestHuddleJoin, handleHuddleJoin } from './huddle.ts';
import { IS_CHAT_SEND, effectiveMcpTokens, withMcpTokensHeader } from './mcp-tokens-proxy.ts';
import { proxiedRequestEvent, track } from './analytics.ts';
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
  BRIDGE_ROUTES,
  CANVAS_AUTHOR_HEADER,
  CANVAS_ID_HEADER,
  CANVAS_VIEWER_HEADER,
  GUEST_CANVAS_HEADER,
  GUEST_CAPS_HEADER,
} from '../shared/bridge-wire.ts';

// The workspace container (one per workspace, on the `durable_object` scheduling policy) — the
// Worker is the proxy into its vite dev server, which serves the app and forwards /api/* to the
// bridge. Re-exported here because wrangler resolves Durable Object classes off the entrypoint
// module's exports.
export { CanvasContainer } from './canvas-container.ts';

// The canvas sync room class (ADR-0019, #288). Re-exported here because wrangler resolves
// Durable Object classes off the entrypoint module's exports.
export { CanvasSyncRoom } from './canvas-sync-do.ts';

export interface Env {
  // The workspace's container under the `durable_object` scheduling policy
  // (worker/canvas-container.ts). Unparameterised for the reason CANVAS_SYNC is: a plain
  // class, reached only by stub.fetch.
  CanvasContainer: DurableObjectNamespace;
  // One Durable Object per canvas, hosting that canvas's tldraw sync room (ADR-0019).
  // Addressed ONLY via `idFromName(syncRoomName(canvasId))` — see worker/sync-api.ts.
  // Unparameterised on purpose: `CanvasSyncRoom` is a plain class rather than a
  // `cloudflare:workers` `DurableObject` subclass (see canvas-sync-do.ts for why), so it
  // carries no `DurableObjectBranded` marker. Nothing calls it by RPC — the only traffic
  // is `stub.fetch` with the WebSocket upgrade — so the plain stub type is exactly right.
  CANVAS_SYNC: DurableObjectNamespace;
  // Workers static-assets binding for the Shell SPA build (shell/dist). Served AFTER the
  // edge session gate — it's app content, so an unauthenticated hit gets the login.
  ASSETS: Fetcher;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ENDPOINT: string;
  // Native R2 binding — separate from the R2_* S3-compat creds above, which only ever get
  // forwarded into the container's Bun runtime. Same bucket as R2_BUCKET; a native binding,
  // not the S3 client, because Bun.S3Client isn't available in workerd. The canvas asset
  // bucket (ADR-0019): tldraw image/video bytes live here under `canvas-assets/`. Named for
  // the retired marts, which read it first.
  MART_BUCKET: import('./canvas-assets.ts').AssetBucket;
  CLAUDE_CODE_OAUTH_TOKEN: string;
  // web-poc (mounted at the edge): the platform data layer on D1 (ADR-0018) + auth.
  // BETTER_AUTH_SECRET comes from workerSecrets; the two origins are plain vars in
  // wrangler.jsonc.
  PLATFORM_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  WEB_ORIGIN?: string;
  // LOCAL DEV ONLY (#276), emitted only into the GENERATED local dev config (never
  // wrangler.jsonc): local dev runs no container, so `serveWorkspace` proxies to the dev
  // stack instead. See `localBridgeOrigin` in sandbox-resolver.ts for the two belts guarding
  // it, and for why this is NOT `E2E_MODE` (that one also stubs the agent).
  LOCAL_CONTAINER_SHIM?: string;
  LOCAL_BRIDGE_ORIGIN?: string;
  // Workspaces served from our own hardware instead of a Cloudflare Container
  // (worker/self-hosted.ts). JSON map of workspace id -> https origin (the VM) or
  // { stack, supervisor } origins (a sandbox); absent or malformed means every
  // workspace runs on its CanvasContainer.
  SELF_HOSTED_WORKSPACES?: string;
  // Bearer the guest's supervisor demands on /__boot, and the Cloudflare Access
  // service token that lets this Worker reach the guest's hostname at all.
  WS_SUPERVISOR_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  // Bearer token for the `fredrin` MCP registry entry (ADR-0013 train 2): default-workspace
  // env fallback attached per chat send (worker/mcp-tokens-proxy.ts). Unset ⇒ fredrin is
  // simply not connected; a stored per-workspace token row overrides it.
  FREDRIN_KEY?: string;
  // One per extra Fredrin project (named `fredrin-cedarpad` connection); same fallback rules.
  FREDRIN_CEDARPAD_KEY?: string;
  // The www worker's waitlist D1, also bound here for the admin view (ADR-0014).
  // Unset in local dev ⇒ /api/admin/waitlist answers 503.
  WAITLIST?: D1Database;
  // Huddles (ADR-0017): LiveKit Cloud signing keys, edge-only — the container gets
  // short-lived minted room tokens, never these. Unset ⇒ join answers 503, no UI harm.
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  // The admin host's Cloudflare Access application (ADR-0026): its team domain and audience
  // tag, pushed as secrets from the zbc `admin-access` instance's outputs. Either missing ⇒
  // admin.cedarpad.com refuses everything (503).
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // PostHog project key for edge usage events (worker/analytics.ts). Production-only var;
  // unset (preview, local dev, tests) ⇒ nothing is sent.
  POSTHOG_KEY?: string;
}

/** A request on a non-canonical host 301s to the same path+query on the canonical origin
 * (WEB_ORIGIN), so only one host ever holds a session. Same-host / unset / unparseable origin
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');

    // admin.cedarpad.com (ADR-0026) is its own surface behind Cloudflare Access, ahead of the
    // canonical redirect and the session gate: it reads no Better Auth session at all.
    if (isAdminHost(url)) return handleAdminHost(request, env);

    // app.cedarpad.com is canonical (WEB_ORIGIN); any other host that reaches this Worker
    // 301s to the same path+query there.
    const canonical = canonicalRedirect(url, env.WEB_ORIGIN);
    if (canonical) return canonical;

    // Public build stamp (#74): the SHA the default workspace's stack is running, answered by
    // wherever that stack lives: the self-hosted sandbox when `default` is mapped there, its
    // CanvasContainer otherwise (the bridge's /api/buildrev returns ONLY the SHA, never
    // /api/status's health/client counts). It carries no Better Auth session, so it's routed
    // HERE, ahead of the edge gate. This is the one unauthenticated path that can cold-boot a
    // container, which is why it is not pinned to Cloudflare when `default` is self-hosted:
    // an anonymous poll would otherwise keep a second, unused container awake.
    // A sandbox is the one that sleeps, so there the poll is PASSIVE: it neither wakes the sandbox nor boots its
    // stack (a 503 when they are down), where an anonymous poll would otherwise keep it awake for good.
    if (url.pathname === '/api/buildrev') {
      return serveWorkspace(request, env, resolve(DEFAULT_WORKSPACE), { passive: true });
    }

    // Edge auth (ADR-0007, slice #45) — the SOLE gate now that cs_gate is gone. Better
    // Auth's endpoints are served AT THE EDGE so login/session happen here without ever
    // proxying to a container; every other route must carry a valid session.
    if (url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/')) {
      return handleAuth(request, env);
    }

    // Verify the session and decide the gate BEFORE the resolver/proxy below — an
    // unauthenticated request never reaches serveWorkspace, so it never reaches the
    // container.
    // #177 inbound MCP: OAuth discovery at the origin root (public — clients fetch these
    // before they hold any token) and the /mcp endpoint itself, which self-gates on its
    // bearer (401 + WWW-Authenticate, never the login page, never the session cookie).
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/oauth-protected-resource') {
      return handleOAuthDiscovery(request, env, url.pathname);
    }
    if (url.pathname === '/mcp') {
      return handleMcp(request, env, ctx);
    }

    // The platform RPC (ADR-0018): the container calling back for the two writes that
    // originate inside it. Routed ahead of the session gate for the same reason /mcp is — the
    // caller is a process, not a browser, so it has no Better Auth cookie and the gate would
    // hand it the login page. It SELF-gates on a bearer derived from BETTER_AUTH_SECRET (the
    // same trust root the guest cookie is signed with), so an unauthenticated request cannot
    // invoke either operation.
    if (url.pathname === PLATFORM_RPC_PATH) {
      return handlePlatformRpc(request, env, platformRpcDeps(createDbForWorker(env as unknown as Bindings)));
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
      const accepted = await handleShareAccept(
        request,
        createDbForWorker(env as unknown as Bindings),
        env.BETTER_AUTH_SECRET ?? '',
        shareMatch[1] as string,
      );
      // A guest is a link, not somebody: keyed by the link id, with no person profile.
      if (accepted.status === 302) {
        track(env, ctx, { event: 'guest_link_opened', distinctId: `share:${shareMatch[1]}`, anonymous: true });
      }
      return accepted;
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
        // #320: the LIVE row is read BEFORE the gate decides, because it is the source of
        // the capabilities as well as of liveness. The cookie carries a snapshot of the
        // grants at mint time; a link that has since been downgraded must not keep what it
        // was minted with, exactly as a revoked one does not. One derivation
        // (`guestCapabilities`) feeds this door, the sync handshake and the bridge.
        const live = await getActiveShareLink(createDbForWorker(env as unknown as Bindings), guest.linkId);
        if (live && live.canvasId === guest.canvasId) {
          const caps = guestCapabilities({ ...live, shapeId: live.shapeId ?? guest.shapeId });
          const guestGate = decideGuestGate({ pathname: url.pathname, method: request.method, canvas }, guest, caps);
          if (isGuestProbe || guestHuddleMatch || guestGate.decision === 'allow') {
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
            // A guest is never an addressable viewer: their per-browser identity lives in
            // localStorage and never reaches the edge, so there is nothing truthful to stamp.
            // DELETED rather than left alone — this path returns before the strip block below,
            // and a guest must not be able to name a member as the target of a page switch.
            guestProxied.headers.delete(CANVAS_VIEWER_HEADER);
            // Nor an author: a guest's writes are recorded with none, never a forged member's.
            guestProxied.headers.delete(CANVAS_AUTHOR_HEADER);
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
    // calling serveWorkspace, so browsing the shell never wakes (or bills) a
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

    // The Notebook is retired: an old bookmark lands on the canvas, not a 404.
    if (url.pathname === '/notebook' || url.pathname.startsWith('/notebook/')) {
      return new Response(null, { status: 302, headers: { location: '/' } });
    }

    // Edge Shell (ADR-0007, #46). The launcher + its registry API are served HERE — no
    // container is proxied to for either — so listing/creating a workspace never wakes
    // one. Only opening a workspace (/w/:id) routes to a container.

    // #220 slice 5: a MEMBER session is never a guest — the Shell's boot probe answers
    // null here so the full chrome renders. (The guest branch above answers the scope.)
    if (url.pathname === '/api/guest-session') return Response.json(null);

    // Registry API the launcher calls (owner-OR-member list, admin-only create).
    if (url.pathname === '/api/workspaces') {
      const res = await handleWorkspacesApi(request, createDbForWorker(env as unknown as Bindings), user);
      if (request.method === 'POST' && res.status === 201) {
        const made = (await res.clone().json()) as { id: string };
        track(env, ctx, { event: 'workspace_created', distinctId: user.id, properties: { workspace_id: made.id } });
      }
      return res;
    }

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

    // Admin surface (ADR-0014): waitlist view, role=admin only. Edge-served.
    if (url.pathname === '/api/admin/waitlist') {
      return handleAdminApi(request, createDbForWorker(env as unknown as Bindings), user, env.WAITLIST);
    }

    // Canvas registry API (Canvas app index), scoped to the active workspace via the
    // cs_workspace cookie. Served at the edge like /api/workspaces — no container woken.
    if (url.pathname === '/api/canvases') {
      const res = await handleCanvasesApi(request, createDbForWorker(env as unknown as Bindings), user);
      if (request.method === 'POST' && res.status === 201) {
        const made = (await res.clone().json()) as { id: string };
        track(env, ctx, { event: 'canvas_created', distinctId: user.id, properties: { canvas_id: made.id } });
      }
      return res;
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

    // External MCP owner consent (ADR-0013 train 2, #176): connect/disconnect a registry
    // server's per-workspace bearer token. Edge-only (no container woken) — the token is read
    // back out only when a chat send is proxied (below).
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

    // The Inbox is retired; an old bookmark or link lands on the canvas instead. Behind the
    // gate above, so an unauthenticated hit still gets the login first.
    if (url.pathname === '/inbox') return new Response(null, { status: 302, headers: { location: '/' } });

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

    // The component LIBRARY LISTING (ADR-0022, #363) — edge-served like the marts above, and
    // for the same reason: reading it must never wake (or bill) a container. Own and shared
    // are Records the edge owns; the platform tier comes from the manifest bundled with this
    // worker. Canvas-scoped by `x-canvas-id`, the same selection contract the bridge uses, so
    // the pad's gallery/palette and an in-canvas catalog card reach it unchanged. Only the
    // GET moves: every write below still belongs to the bridge, the single writer of the
    // container filesystem.
    if (url.pathname === BRIDGE_ROUTES.components && request.method === 'GET') {
      return handleComponentsApi(
        createDbForWorker(env as unknown as Bindings),
        user,
        workspaceId,
        request.headers.get(CANVAS_ID_HEADER) ?? DEFAULT_CANVAS_ID,
      );
    }

    // The workspace-wide Component inventory (the Components stage). Spans canvases, which
    // is the whole point: the palette and gallery above are scoped to the canvas you have
    // open, so a Component generated on another canvas is invisible until you go looking.
    if (url.pathname === INVENTORY_PATH) {
      // `?workspace=` wins over the cookie, matching `/api/canvases`. The rail knows which
      // workspace it is showing; the cookie is a separate piece of state that can lag it,
      // and an inventory answered for a DIFFERENT workspace than the one on screen would
      // put the wrong Components in front of a delete button. Access is re-checked inside
      // either way, so naming a workspace is never a way into one.
      const named = url.searchParams.get('workspace');
      return handleComponentInventory(request, env, createDbForWorker(env as unknown as Bindings), user, named || workspaceId);
    }

    // Container debug routes, gated like everything else here: `/__recycle` destroys the
    // workspace's container (the next request boots fresh) and `/__bootlog` reports its last
    // boot. The CanvasContainer DO answers both itself, without booting anything.
    if (url.pathname === '/__recycle' || url.pathname === '/__bootlog') {
      return serveCanvasContainer(request, env, coords);
    }

    // ADR-0013 train 2 (#176): the chat send path (the pad's <ChatView>) gets the workspace's
    // connected external-MCP tokens — "no tokens ⇒ untouched".
    const isChatSend = request.method === 'POST' && IS_CHAT_SEND.test(url.pathname);
    // The canvas SSE subscribe — the one request whose IDENTITY the bridge has to remember,
    // because `select_page` addresses a frame at one subscriber later (server/screenshot-channel.ts).
    const isCanvasStream = request.method === 'GET' && url.pathname === '/api/canvas/stream';
    // The edge-owned headers below are answers the edge alone writes, so a client-sent copy of
    // any of them must never survive into the container — on ANY request, not only a send.
    // Cloning is skipped entirely when the client sent none (the overwhelmingly common case).
    const forged = [CANVAS_VIEWER_HEADER, CANVAS_AUTHOR_HEADER];
    // A write's author (CANVAS_AUTHOR_HEADER): attribution for the Record it may land.
    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    let proxied = request;
    if (isChatSend || isCanvasStream || isWrite || forged.some((h) => request.headers.has(h))) {
      proxied = new Request(request);
      for (const h of forged) proxied.headers.delete(h);
    }
    // Who is looking / who is asking, for presentation-only targeting (CANVAS_VIEWER_HEADER).
    // Stamped on exactly the two requests that need it: the stream subscribe binds an
    // identity to a browser, and a send carries the asker's into the turn it starts. Written
    // AFTER the strip above, so the client's own copy is always the one that loses.
    if (isChatSend || isCanvasStream) proxied.headers.set(CANVAS_VIEWER_HEADER, user.id);
    if (isWrite) proxied.headers.set(CANVAS_AUTHOR_HEADER, user.id);
    if (isChatSend) {
      proxied = await withMcpTokensHeader(proxied, env, workspaceId);
    }

    const res = await serveWorkspace(proxied, env, coords);
    const usage = res.ok ? proxiedRequestEvent(request.method, url.pathname, request.headers.get(CANVAS_ID_HEADER)) : null;
    if (usage) {
      track(env, ctx, { event: usage.event, distinctId: user.id, properties: { workspace_id: workspaceId, ...usage.properties } });
    }
    return res;
  },
};
