import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE, type SandboxCoords, resolve } from './sandbox-resolver.ts';
import type { mintDevAgentGitToken } from './github-app.ts';
import type { WorkspaceRepoView } from './github-connection.ts';
import { DEV_AGENT_GIT_TOKEN_HEADER, DEV_AGENT_REPO_HEADER } from '../shared/bridge-wire.ts';

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
    opts: { nowSec: number } & WorkspaceRepoView,
  ) => ReturnType<typeof mintDevAgentGitToken>;
  /** The container proxy (sandbox-runtime's serveWorkspace) — injected so this module stays
   *  free of the `cloudflare:workers`-coupled sandbox layer. */
  serve: (request: Request, env: Env, coords: SandboxCoords) => Promise<Response>;
  /** The workspace's repo, resolved to one (repo, auth) view (github-connection.ts
   *  resolveDevAgentRepo, ADR-0015 → ADR-0016). Null ⇒ token-less kick. */
  resolveRepo: (env: Env, requested?: string) => Promise<WorkspaceRepoView | null>;
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
  requestedRepo: string | undefined,
  // The repo-defined job's (name, body) — discovered off the repo's DEFAULT branch by the
  // caller (#195); forwarded to the bridge, which wraps the body in the platform law.
  // REQUIRED (#100): a run has no task other than a job's.
  job: { name: string; prompt: string },
  // The MANUAL trigger's human initiator (shared inbox): rides as x-inbox-assign so the
  // run's Conversation is assigned to who kicked it. Absent on cron ⇒ unassigned queue work.
  assignUser?: string,
): Promise<Response> {
  const repo = await deps.resolveRepo(env, requestedRepo);
  if (requestedRepo && !repo) {
    return Response.json({ error: `repo not selected for this workspace: ${requestedRepo}` }, { status: 400 });
  }
  const headers = new Headers();
  if (assignUser) headers.set('x-inbox-assign', assignUser);
  if (repo) {
    headers.set(DEV_AGENT_REPO_HEADER, repo.repoFullName);
    const token = await deps.mint(env, { nowSec: Math.floor(Date.now() / 1000), ...repo });
    if (token) headers.set(DEV_AGENT_GIT_TOKEN_HEADER, token);
  }
  headers.set('content-type', 'application/json');
  const init: RequestInit = { method: 'POST', headers, body: JSON.stringify({ job }) };
  const request = new Request(`https://bridge.internal${DEV_AGENT_RUN_PATH}`, init);
  return deps.serve(request, env, resolve(DEFAULT_WORKSPACE));
}

export interface DevAgentTriggerDeps extends DevAgentKickDeps {
  /** Repo-defined jobs off the selected repos' default branches (worker/repo-jobs.ts
   *  discoverJobs, curried with the db + workspace by the caller). */
  discover: (env: Env) => Promise<Array<{ name: string; repo: string; prompt: string; target?: 'agent' | 'warehouse' }>>;
  /** The materialize kick (worker/warehouse-dispatch.ts kickWarehouseMaterialize, curried
   *  with the env + exec dep by the caller — index.ts / mcp-server.ts). This manual
   *  trigger's ONLY route to a `target: warehouse` job (#248): no repo, no prompt, no
   *  assignUser passed through — a materialize run is batch (ADR-0017), never a chat turn. */
  kickWarehouse: () => Promise<Response>;
}

/**
 * The one manual-trigger core (shared by the /api/jobs/dev-agent/run route and the MCP
 * run_dev_agent tool): validate the { repo?, job } request, then kick. The named job's
 * prompt is (re-)read off the repo's DEFAULT branch here — the merge armed it; a caller can
 * never inject a prompt (#195). `repo` must be within the selected set (kickDevAgentRun 400s
 * otherwise); an unknown job is a 404.
 *
 * `job` is REQUIRED (#100): there is exactly one way to get work — a job. A jobless kick used
 * to fall back to a built-in prompt against an arbitrary repo; that layer is retired, so a
 * jobless kick is a 400 naming where jobs come from.
 */
export async function triggerDevAgentRun(
  env: Env,
  deps: DevAgentTriggerDeps,
  body: { repo?: string; job?: string } | null,
  // Manual triggers are human acts: the caller passes the triggering user so the run's
  // Conversation is assigned to them (Jobs route: the session user; MCP: the token's user).
  assignUser?: string,
): Promise<Response> {
  let repoArg = typeof body?.repo === 'string' ? body.repo : undefined;
  if (typeof body?.job !== 'string' || !body.job.trim()) {
    return Response.json(
      {
        error:
          "a dev-agent run requires a job: pass { job: \"<name>\" } naming a job defined in .claude/jobs/ on a selected repo's default branch (list them at /api/workspaces/<id>/jobs, or in the Jobs stage). Add a job by merging a `.claude/jobs/<name>.md` file to that repo.",
      },
      { status: 400 },
    );
  }
  const jobs = await deps.discover(env);
  const found = jobs.find((j) => j.name === body.job && (!repoArg || j.repo === repoArg));
  if (!found) return Response.json({ error: `job not found on a selected repo's default branch: ${body.job}` }, { status: 404 });
  // A `target: warehouse` job is a materialize run, not a dev-agent turn (ADR-0017) — "Run
  // now" parity (#248) routes it to the same batch kick the scheduler uses instead of
  // proxying it into the bridge as a chat turn, which it was never meant to be.
  if (found.target === 'warehouse') return deps.kickWarehouse();
  repoArg = found.repo; // a repo job always runs against its home repo
  return kickDevAgentRun(env, deps, repoArg, { name: found.name, prompt: found.prompt }, assignUser);
}
