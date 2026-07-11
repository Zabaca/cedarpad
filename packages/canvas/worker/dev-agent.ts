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
  mint: (env: Env, opts: { nowSec: number }) => ReturnType<typeof mintDevAgentGitToken>;
  /** The container proxy (sandbox-runtime's serveWorkspace) — injected so this module stays
   *  free of the `cloudflare:workers`-coupled sandbox layer. */
  serve: (request: Request, env: Env, coords: SandboxCoords) => Promise<Response>;
}

/**
 * Kick one dev-agent run (ADR-0011): mint the ~1h repo-scoped token (best-effort — a failed
 * mint kicks token-less; the run explores but can't open PRs) and proxy the kick to the warm
 * default container's bridge, which dispatches it as a headless, token-armed chat turn. The
 * bridge single-flights runs with JOIN semantics, so concurrent kicks (cron + clicks) answer
 * with the one running run's chatId. Returns the bridge's response ({ chatId, joined }).
 */
export async function kickDevAgentRun(env: Env, deps: DevAgentKickDeps): Promise<Response> {
  const token = await deps.mint(env, { nowSec: Math.floor(Date.now() / 1000) });
  const headers = new Headers();
  if (token) headers.set('x-dev-agent-git-token', token);
  const request = new Request(`https://bridge.internal${DEV_AGENT_RUN_PATH}`, { method: 'POST', headers });
  return deps.serve(request, env, resolve(DEFAULT_WORKSPACE));
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
