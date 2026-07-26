import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE, type SandboxCoords, resolve } from './sandbox-resolver.ts';

// The materialize dispatch, edge side (#240, ADR-0017). A materialize run is BATCH, not
// an agent turn (ADR-0017): running SQL is deterministic, so unlike kickDevAgentRun this
// never proxies into the canvas container's bridge, wraps a prompt in the platform law,
// or opens a chat Conversation. It wakes the WAREHOUSE container (no agent SDK, #236) and
// runs the pipeline's CLI entrypoint (warehouse/materialize.ts) one-shot. Kept free of any
// `@cloudflare/sandbox` / `cloudflare:workers` import so it's unit-testable off the edge
// runtime (the exec fn is injected), same split as dev-agent.ts / sandbox-runtime.ts.

export interface WarehouseExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface WarehouseKickDeps {
  /** One-shot `bun run warehouse/materialize.ts` against the workspace's Warehouse
   *  container (worker/index.ts `warehouseExec` — a dynamic `import('@cloudflare/sandbox')`,
   *  see its comment for why). Injected so this module stays pure. */
  exec: (env: Env, coords: SandboxCoords) => Promise<WarehouseExecResult>;
}

/**
 * Kick one materialize run (#240): wake the Warehouse container — never the canvas
 * container/bridge — and run the pipeline one-shot. No git token, no prompt, no
 * Conversation: a job's `prompt` body plays no role here, because there is no judgment
 * to steer. Mirrors kickDevAgentRun's 202/`{joined:false}` success shape so
 * evaluateScheduledJobs's stamp logic needs no branch between the two dispatch targets.
 */
export async function kickWarehouseMaterialize(env: Env, deps: WarehouseKickDeps): Promise<Response> {
  // v1: one container = one workspace (sandbox-resolver.ts) — the default workspace's
  // Warehouse container, same coordinates the canvas container resolves to.
  const coords = resolve(DEFAULT_WORKSPACE);
  const result = await deps.exec(env, coords);
  if (!result.success) {
    return Response.json({ error: 'materialize failed', stderr: result.stderr }, { status: 502 });
  }
  return Response.json({ joined: false }, { status: 202 });
}
