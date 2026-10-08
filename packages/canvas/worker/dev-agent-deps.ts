import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import type { DevAgentTriggerDeps } from './dev-agent.ts';
import { mintDevAgentGitToken } from './github-app.ts';
import { resolveDevAgentRepo } from './github-connection.ts';
import { discoverJobs } from './repo-jobs.ts';
import { serveWorkspace, warehouseExec } from './sandbox-runtime.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import { kickWarehouseMaterialize } from './warehouse-dispatch.ts';
import type { Env } from './index.ts';

// The dev-agent's live wiring — the deps dev-agent.ts's pure core takes, bound to the real
// edge collaborators. Shared by the /api/jobs/dev-agent/run route (index.ts) and the MCP
// run_dev_agent tool (mcp-server.ts); its own module because index.ts imports mcp-server.ts,
// so mcp-server.ts importing it from index.ts would be a cycle.

// The kick's repo resolution (ADR-0015): runs target the default workspace's container, so
// its repository connection (row, else the transitional env fallback) names the repo set.
// Best-effort like the mint itself: a DB failure kicks token-less rather than failing the run.
export const defaultWorkspaceRepo = async (env: Env, requested?: string) => {
  try {
    return await resolveDevAgentRepo(env, createDbForWorker(env as unknown as Bindings), DEFAULT_WORKSPACE_ID, requested);
  } catch (e: unknown) {
    console.error(`[dev-agent] repo resolution failed — kicking token-less: ${String(e)}`);
    return null;
  }
};

/** The manual trigger's deps (triggerDevAgentRun) — one construction for both surfaces. */
export const devAgentTriggerDeps = (env: Env): DevAgentTriggerDeps => ({
  mint: mintDevAgentGitToken,
  serve: serveWorkspace,
  resolveRepo: defaultWorkspaceRepo,
  discover: (e) =>
    discoverJobs(e, createDbForWorker(e as unknown as Bindings), DEFAULT_WORKSPACE_ID, {
      nowSec: Math.floor(Date.now() / 1000),
    }),
  kickWarehouse: () => kickWarehouseMaterialize(env, { exec: warehouseExec }),
});
