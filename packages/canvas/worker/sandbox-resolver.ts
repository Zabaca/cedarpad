import { r2Prefix as deriveR2Prefix, sandboxId as deriveSandboxId } from '../web-poc/lib/db/queries/workspaces.ts';

// The Sandbox resolver (ADR-0007). The PURE core: a mapping from a workspace to its
// runtime coordinates, plus the warm-vs-cold path decision. Kept free of any
// `@cloudflare/sandbox` / `cloudflare:workers` import so it's unit-testable off the
// edge runtime. The wake/expose/proxy orchestration that consumes these lives in
// `sandbox-runtime.ts`.

export interface SandboxCoords {
  sandboxId: string;
  r2Prefix: string;
}

/** A workspace as far as routing cares: its id and whether it's THE legacy default. */
export interface ResolvableWorkspace {
  id: string;
  legacy?: boolean;
}

// Legacy coordinates. On `main` (deployed to poc.cedarpad.com) the single container
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
  if (workspace.legacy) return { sandboxId: LEGACY_SANDBOX_ID, r2Prefix: LEGACY_R2_PREFIX };
  return { sandboxId: deriveSandboxId(workspace.id), r2Prefix: deriveR2Prefix(workspace.id) };
}

export type WarmDecision = 'serve' | 'cold-start';

// Pure warm-vs-cold path selection, extracted from the fetch handler so it's
// unit-testable without a live sandbox. Return REAL app responses as-is — any status
// vite or the bridge produced, including 401/403/404/5xx (a failed login is a legit
// 401, not a cold start). Only the SANDBOX PROXY's not-ready signals fall through to
// the cold start:
//   - 410: container stopped/gone (returning it left the site stuck 410).
//   - 404/5xx whose body is the sandbox {"code":"INVALID_TOKEN"} / "port not exposed"
//     error — a never-warmed or recycled container.
// `peekBody` is lazy so the fast 2xx/3xx path never reads the body.
export function decideWarm(status: number, peekBody: () => string): WarmDecision {
  if (status === 410) return 'cold-start';
  if (status < 400) return 'serve';
  return /INVALID_TOKEN|port not exposed/.test(peekBody()) ? 'cold-start' : 'serve';
}
