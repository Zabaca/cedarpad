import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE, type SandboxCoords, resolve } from './sandbox-resolver.ts';
import type { mintDevAgentGitToken } from './github-app.ts';

// The dev-agent, edge side (ADR-0010 → ADR-0011) — PURE core. The dev-agent is a ROLE the
// warm default container plays, and a dev-agent RUN is a chat turn that container's bridge
// runs headlessly (server/bridge.ts `POST /api/dev-agent/run`). The edge's whole job here is
// "mint the per-turn git token, proxy the kick" — there is no exec, no batch env, and no
// separate execution path. Kept free of any `@cloudflare/sandbox` / `cloudflare:workers`
// import so it's unit-testable off the edge runtime (the serve fn is injected).

// The bridge route that runs one dev-agent run as a headless chat turn. The producer side
// of the path contract; the consumer is the route match in server/bridge.ts.
export const DEV_AGENT_RUN_PATH = '/api/dev-agent/run';

export interface DevAgentKickDeps {
  /** The per-turn git-token mint (worker/github-app.ts). Best-effort: null ⇒ token-less kick. */
  mint: (
    env: Env,
    opts: { nowSec: number; installationId: string; repoFullName: string },
  ) => ReturnType<typeof mintDevAgentGitToken>;
  /** The container proxy (sandbox-runtime's serveWorkspace) — injected so this module stays
   *  free of the `cloudflare:workers`-coupled sandbox layer. */
  serve: (request: Request, env: Env, coords: SandboxCoords) => Promise<Response>;
  /** The workspace's repository connection, resolved to one (installation, repo) pair
   *  (github-connection.ts resolveDevAgentRepo, ADR-0015). Null ⇒ token-less kick. */
  resolveRepo: (env: Env, requested?: string) => Promise<{ installationId: string; repoFullName: string } | null>;
}

/**
 * Kick one dev-agent run (ADR-0011 / ADR-0015): resolve the workspace's repo (the explicit
 * `requestedRepo` from the Jobs picker, else the first selected), mint the ~1h token scoped
 * to exactly that repo (best-effort — a failed mint kicks token-less; the run explores but
 * can't open PRs), and proxy the kick to the warm default container's bridge, which
 * dispatches it as a headless, token-armed chat turn. The bridge single-flights runs with
 * JOIN semantics. An explicitly requested repo that is NOT in the workspace's selected set
 * is a 400 — never silently re-targeted.
 */
export async function kickDevAgentRun(
  env: Env,
  deps: DevAgentKickDeps,
  requestedRepo?: string,
  // A repo-defined job's (name, body) — discovered off the repo's DEFAULT branch by the
  // caller (#195); forwarded to the bridge, which wraps the body in the platform law.
  job?: { name: string; prompt: string },
): Promise<Response> {
  const repo = await deps.resolveRepo(env, requestedRepo);
  if (requestedRepo && !repo) {
    return Response.json({ error: `repo not selected for this workspace: ${requestedRepo}` }, { status: 400 });
  }
  const headers = new Headers();
  if (repo) {
    headers.set('x-dev-agent-repo', repo.repoFullName);
    const token = await deps.mint(env, { nowSec: Math.floor(Date.now() / 1000), ...repo });
    if (token) headers.set('x-dev-agent-git-token', token);
  }
  const init: RequestInit = { method: 'POST', headers };
  if (job) {
    headers.set('content-type', 'application/json');
    init.body = JSON.stringify({ job });
  }
  const request = new Request(`https://bridge.internal${DEV_AGENT_RUN_PATH}`, init);
  return deps.serve(request, env, resolve(DEFAULT_WORKSPACE));
}

export interface DevAgentTriggerDeps extends DevAgentKickDeps {
  /** Repo-defined jobs off the selected repos' default branches (worker/repo-jobs.ts
   *  discoverJobs, curried with the db + workspace by the caller). */
  discover: (env: Env) => Promise<Array<{ name: string; repo: string; prompt: string }>>;
}

/**
 * The one manual-trigger core (shared by the /api/jobs/dev-agent/run route and the MCP
 * run_dev_agent tool): validate the optional { repo, job } request, then kick. A named
 * job's prompt is (re-)read off the repo's DEFAULT branch here — the merge armed it; a
 * caller can never inject a prompt (#195). `repo` must be within the selected set
 * (kickDevAgentRun 400s otherwise); an unknown job is a 404.
 */
export async function triggerDevAgentRun(
  env: Env,
  deps: DevAgentTriggerDeps,
  body: { repo?: string; job?: string } | null,
): Promise<Response> {
  let repoArg = typeof body?.repo === 'string' ? body.repo : undefined;
  let job: { name: string; prompt: string } | undefined;
  if (typeof body?.job === 'string') {
    const jobs = await deps.discover(env);
    const found = jobs.find((j) => j.name === body.job && (!repoArg || j.repo === repoArg));
    if (!found) return Response.json({ error: `job not found on a selected repo's default branch: ${body.job}` }, { status: 404 });
    repoArg = found.repo; // a repo job always runs against its home repo
    job = { name: found.name, prompt: found.prompt };
  }
  return kickDevAgentRun(env, deps, repoArg, job);
}

// The cron handler's core, extracted so it's unit-testable without a live cron or container.
// Kill-switch: the cron fires daily, but stays a no-op until DEV_AGENT_ENABLED="true" — the
// flag gates ONLY this scheduled auto-fire; a manual Jobs kick is an explicit user action and
// runs regardless. A failed kick is surfaced (thrown), never silently swallowed.
export async function dispatchDevAgentRun(
  event: { cron: string; scheduledTime: number },
  env: Env,
  kick: (env: Env) => Promise<Response>,
): Promise<void> {
  if (env.DEV_AGENT_ENABLED !== 'true') {
    console.log('[dev-agent] scheduled run skipped — DEV_AGENT_ENABLED is not "true"');
    return;
  }
  console.log(`[dev-agent] scheduled run — cron=${event.cron} at=${new Date(event.scheduledTime).toISOString()}`);
  const res = await kick(env);
  if (!res.ok) throw new Error(`dev-agent kick failed: ${res.status} ${await res.text().catch(() => '')}`);
  console.log(`[dev-agent] scheduled run kicked: ${await res.text().catch(() => '')}`);
}
