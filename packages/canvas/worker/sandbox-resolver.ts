import { r2Prefix as deriveR2Prefix, sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';

// The workspace resolver (ADR-0007). The PURE core: a mapping from a workspace to its
// runtime coordinates. Kept free of any `cloudflare:workers` import so it's unit-testable
// off the edge runtime. The routing that consumes these lives in `sandbox-runtime.ts`.

export interface SandboxCoords {
  sandboxId: string;
  r2Prefix: string;
  // The value the container runs with as `CANVAS_WORKSPACE` — the key its bridge
  // uses to scope R2 state. The legacy/default workspace MUST be `'default'` so the
  // deployed prod container keeps restoring from `workspaces/default/`; a new
  // workspace uses its own id, giving it an isolated R2 prefix. (ADR-0007, #46.)
  canvasWorkspace: string;
}

/** A workspace as far as routing cares: its id and whether it's THE legacy default. */
export interface ResolvableWorkspace {
  id: string;
  legacy?: boolean;
}

// Legacy coordinates. Before workspaces existed, the single container
// is `SANDBOX_ID = 'canvas'` and its canvas state persists to R2 under
// `workspaces/default/` (the bridge runs with `CANVAS_WORKSPACE = 'default'`). The
// default workspace MUST resolve here so deploying this slice is behavior-preserving;
// pointing it at the derived `workspace-<id>` sandbox would land on a different,
// empty container and cold-boot blank. Only NEW workspaces use the derived scheme.
export const LEGACY_SANDBOX_ID = 'canvas';
export const LEGACY_R2_PREFIX = 'workspaces/default/';

// The single default workspace this slice selects so the app behaves identically to
// today without a Shell yet. `legacy` routes it to the legacy coordinates above.
export const DEFAULT_WORKSPACE: ResolvableWorkspace = { id: 'default', legacy: true };

/** Pure: a workspace record → its exact runtime coordinates. */
export function resolve(workspace: ResolvableWorkspace): SandboxCoords {
  if (workspace.legacy) return { sandboxId: LEGACY_SANDBOX_ID, r2Prefix: LEGACY_R2_PREFIX, canvasWorkspace: 'default' };
  return {
    sandboxId: deriveSandboxId(workspace.id),
    r2Prefix: deriveR2Prefix(workspace.id),
    canvasWorkspace: workspace.id,
  };
}

/** A workspace id → its runner's coordinates: the legacy `default` id → the legacy/prod
 *  container; any other id → its derived per-workspace container. */
export const coordsForWorkspace = (workspaceId: string): SandboxCoords =>
  resolve(workspaceId === DEFAULT_WORKSPACE.id ? DEFAULT_WORKSPACE : { id: workspaceId });

// An EventSource auto-reconnects only after a NETWORK-level drop; any non-200 or
// non-`text/event-stream` response — the only kind the worker can produce when a cold
// boot fails — closes it PERMANENTLY, killing the tab's canvas sync/presence until a
// manual page refresh. So on the cold path, a stream request that can't be served yet
// gets an immediately-ending VALID event stream carrying only a `retry:` hint: the
// browser's native reconnect stays alive and lands once the container is up.

/** Is this request an EventSource asking for a stream? (EventSource always sends this Accept.) */
export function wantsEventStream(accept: string | null): boolean {
  return accept?.includes('text/event-stream') ?? false;
}

/**
 * LOCAL DEV ONLY (#276): the origin to proxy a workspace request to INSTEAD of its container.
 *
 * Local dev has no container — `server/dev-worker-config.ts` drops `containers` from the
 * generated config, so a container DO proxy throws *"Containers have not been enabled for this
 * Durable Object class"* — but it does have the dev stack, running as plain processes on
 * ports. Returns null (⇒ the real container path) unless BOTH belts hold:
 * `LOCAL_CONTAINER_SHIM` is on, and the target is loopback. Neither var exists in
 * `wrangler.jsonc`, so nothing deployed can reach this; the loopback check is the second belt
 * in case one ever does.
 *
 * The flag is `LOCAL_CONTAINER_SHIM`, NOT `E2E_MODE`, and the split is the point: `E2E_MODE`
 * also swaps the bridge's Claude SDK turn for a stub (`server/bridge.ts`). While the two rode
 * on one flag, the Shell's canvas stage only worked locally in a mode that silently faked the
 * agent, and a plain `bun run dev` hit the Containers error instead. This one is a fact about
 * local dev; the agent stub is a fact about e2e.
 *
 * Placed at the START of `serveWorkspace`, which is downstream of every auth and ownership
 * check — so an unauthenticated or non-owning request is refused before this is consulted
 * (shim rule 2: never paper over a gate).
 */
export function localBridgeOrigin(env: { LOCAL_CONTAINER_SHIM?: string; LOCAL_BRIDGE_ORIGIN?: string }): string | null {
  if (env.LOCAL_CONTAINER_SHIM !== '1') return null;
  const origin = env.LOCAL_BRIDGE_ORIGIN ?? '';
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}

/**
 * The caller's request URL, moved onto `origin`: the same path and query on a different host.
 *
 * The path is the caller's, so it must never be able to choose the host. `new URL(path + search, origin)` does let it:
 * a path that starts with `//` (or `/\\`, which the URL parser reads as `//`) is a scheme-relative reference, so
 * `https://app.cedarpad.com//attacker.example/x` became `https://attacker.example/x`, and a proxy that put its Access
 * service token and the caller's cookies on the request sent them there. Here the origin is parsed first and only its
 * `pathname` and `search` are set, which can change neither the host nor the credentials. A result on another origin
 * is refused all the same: it cannot happen, and a proxy must not rely on that.
 */
export function urlOnOrigin(requestUrl: string, origin: string): URL {
  const from = new URL(requestUrl);
  const to = new URL(origin);
  to.pathname = from.pathname;
  to.search = from.search;
  if (to.origin !== new URL(origin).origin) throw new Error('refusing to forward a request to another origin');
  return to;
}

/** The retryable stand-in for a stream response during a failed/incomplete cold boot. */
export function sseRetryResponse(): Response {
  return new Response('retry: 2000\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });
}
