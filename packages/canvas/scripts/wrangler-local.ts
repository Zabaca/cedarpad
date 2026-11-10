// Run wrangler against LOCAL dev's generated config + per-worktree miniflare state
// (ADR-0018, #263). Used two ways:
//
//   bun run scripts/wrangler-local.ts d1 migrations apply PLATFORM_DB --local
//   scripts/dev.ts -> spawnWrangler(['dev', '--port', …])
//
// Never touches production: the generated config carries no routes, no crons, and a
// local-only D1 binding.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeDevWorkerConfig } from '../server/dev-worker-config.ts';
import { localD1StateDir } from '../server/local-d1.ts';

const WRANGLER = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));

/** The origin the browser uses — the vite dev server (with-worktree-port.sh sets PORT). */
export const webOrigin = () => `http://localhost:${process.env.PORT ?? 4510}`;

/**
 * Where the edge should proxy a workspace request, since local dev runs no container (#276).
 *
 * Unconditional, and that is the fix for a bug that bit twice: this generator only ever
 * writes the LOCAL config, so the stand-in is right for every local run, not just e2e. It
 * used to be gated on `E2E_MODE` — which ALSO stubs the bridge's Claude SDK turn
 * (`server/bridge.ts`). So a plain `bun run dev` left the Shell's canvas stage dead with
 * *"Containers have not been enabled for this Durable Object class"*, and the only way to
 * revive it was a mode that silently replaced the agent with a stub. The two flags are now
 * separate: this emits `LOCAL_CONTAINER_SHIM`, and `E2E_MODE` stays e2e's alone.
 *
 * VITE, not the bridge — the container exposes ONE port and vite is what listens on it,
 * proxying `/api` to the bridge beside it (vite.config.ts). Pointing this at the bridge
 * matched the API routes but not the pad HTML, so the Shell's canvas stage 404'd on
 * `/w/:ws/canvas/:id/pad` locally while every API call worked. e2e never noticed: Playwright
 * loads the pad from vite directly and opens no Shell iframe.
 *
 * No loop: the edge answers `/api/auth`, `/api/canvas-sync` and `/api/guest-session`
 * itself, well before anything reaches the workspace proxy — so the routes vite would send
 * BACK to the edge never travel this way.
 */
export const localContainerOrigin = () => webOrigin();

/** Spawn wrangler with this worktree's dev config and state dir bolted on.
 *
 * `node:child_process`, not `Bun.spawn`: Playwright's globalSetup imports this under
 * NODE, where `Bun` is undefined. */
export async function spawnWrangler(args: string[]) {
  const stateDir = localD1StateDir();
  const config = await writeDevWorkerConfig(stateDir, webOrigin(), localContainerOrigin());
  // wrangler looks for `.dev.vars` next to the config file; ours is generated into the
  // state dir, so point it at the package's real one (the bridge reads the same file).
  const devVars = fileURLToPath(new URL('../web-poc/.dev.vars', import.meta.url));
  const envFile = existsSync(devVars) ? ['--env-file', devVars] : [];
  return spawn(WRANGLER, [...args, ...envFile, '--config', config, '--persist-to', stateDir], {
    stdio: 'inherit',
  });
}

/** Spawn wrangler and wait for it — the one-shot form (migrations). */
export async function runWrangler(args: string[]): Promise<number> {
  const proc = await spawnWrangler(args);
  return new Promise((resolve) => proc.on('exit', (code) => resolve(code ?? 1)));
}

if (import.meta.main) {
  process.exit(await runWrangler(process.argv.slice(2)));
}
