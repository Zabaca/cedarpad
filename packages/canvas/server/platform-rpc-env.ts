import { readFileSync } from 'node:fs';

import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';
import { type PlatformRpc, platformRpc } from './platform-rpc-client.ts';

// How a container-side process WIRES the platform RPC from its environment (ADR-0018). Lifted
// out of `bridge.ts` when a second process needed the same hop: the vite dev server, which
// materializes a Component from its Record on a module miss (ADR-0022) and is not the bridge.
// One derivation, so the two cannot drift into "works in the bridge, 401s in vite".

/**
 * The platform data layer's env — since #266 that means just the two values the platform RPC
 * needs (its edge origin and the shared trust root the bearer derives from). The container
 * gets them as real process.env; local dev reads them from `web-poc/.dev.vars`, the same file
 * `wrangler dev` loads for the edge Worker, so both ends of the hop agree.
 */
export function loadWebPocEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  try {
    const text = readFileSync(new URL('../web-poc/.dev.vars', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m?.[1]) vars[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .dev.vars (container/prod): the container supplies these as real env.
  }
  return { ...vars, ...process.env } as Record<string, string>;
}

/** Is the edge this process talks to on localhost? Gates the dev-only fallback secret. */
export const isLocalhostEdge = (origin: string | undefined): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(origin ?? '');

/**
 * The client, or null when there is no edge in front of this process — which is an explicit
 * state, not a fallback.
 *
 * The local-dev fallback secret applies ONLY to a localhost edge: a fresh worktree has no
 * `web-poc/.dev.vars`, and without a shared trust root the dev loop would 401 silently rather
 * than obviously. A real `.dev.vars` (and the container's real env) always wins.
 */
export function platformRpcFromEnv(env: Record<string, string | undefined>): PlatformRpc | null {
  return platformRpc({
    origin: env.PLATFORM_RPC_ORIGIN,
    secret: env.BETTER_AUTH_SECRET || (isLocalhostEdge(env.PLATFORM_RPC_ORIGIN) ? LOCAL_DEV_PLATFORM_SECRET : undefined),
  });
}
