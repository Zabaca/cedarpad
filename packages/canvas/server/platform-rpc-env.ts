import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';
import { WORKSPACE_KEY_LABEL } from '../shared/workspace-key.ts';
import { type PlatformRpc, platformRpc } from './platform-rpc-client.ts';

// How a container-side process WIRES the platform RPC from its environment (ADR-0018). Lifted
// out of `bridge.ts` when a second process needed the same hop: the vite dev server, which
// materializes a Component from its Record on a module miss (ADR-0022) and is not the bridge.
// One derivation, so the two cannot drift into "works in the bridge, 401s in vite".

/**
 * The platform data layer's env — since #266 that means just the two values the platform RPC
 * needs: its edge origin and the key its bearers derive from. In a container both arrive as real
 * process.env, and the key is that workspace's `WORKSPACE_KEY` (#374), never the shared secret.
 * Local dev reads `web-poc/.dev.vars`, the same file `wrangler dev` loads for the edge Worker,
 * and derives its own workspace's key from the dev secret there (`withDevWorkspaceKey`).
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
  return withDevWorkspaceKey({ ...vars, ...process.env } as Record<string, string>);
}

/**
 * LOCAL DEV ONLY: with no `WORKSPACE_KEY` and an edge on localhost, derive the key for this
 * process's workspace (`CANVAS_WORKSPACE`, else `default`) from the dev secret, as the edge
 * does for a container (shared/workspace-key.ts). The dev secret is the one in `.dev.vars` or
 * the built-in dev default, which the edge Worker also falls back to. It is never done for a
 * non-localhost edge: there a container must have been handed its key, and a process that was
 * not is unconfigured, not a candidate for deriving one from a secret it should not hold.
 *
 * Node's crypto (synchronous) here, WebCrypto at the edge, one value: a test pins them equal.
 */
export function withDevWorkspaceKey(env: Record<string, string>): Record<string, string> {
  if (env.WORKSPACE_KEY || !isLocalhostEdge(env.PLATFORM_RPC_ORIGIN)) return env;
  const secret = env.BETTER_AUTH_SECRET || LOCAL_DEV_PLATFORM_SECRET;
  const key = createHmac('sha256', secret)
    .update(`${WORKSPACE_KEY_LABEL}${env.CANVAS_WORKSPACE || 'default'}`)
    .digest('base64url');
  return { ...env, WORKSPACE_KEY: key };
}

/** Is the edge this process talks to on localhost? Gates the dev-only fallback secret. */
export const isLocalhostEdge = (origin: string | undefined): boolean =>
  /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(origin ?? '');

/**
 * The client, or null when there is no edge in front of this process — which is an explicit
 * state, not a fallback.
 *
 * `env` is `loadWebPocEnv()`'s, which has already derived the key for local dev. A process with
 * no `WORKSPACE_KEY` has nothing to authenticate with and gets no client.
 */
export function platformRpcFromEnv(env: Record<string, string | undefined>): PlatformRpc | null {
  return platformRpc({ origin: env.PLATFORM_RPC_ORIGIN, secret: env.WORKSPACE_KEY });
}
