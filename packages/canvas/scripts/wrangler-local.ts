// Run wrangler against LOCAL dev's generated config + per-worktree miniflare state
// (ADR-0018, #263). Used two ways:
//
//   bun run scripts/wrangler-local.ts d1 migrations apply PLATFORM_DB --local
//   scripts/dev.ts -> spawnWrangler(['dev', '--port', …])
//
// Never touches production: the generated config carries no routes, no crons, and a
// local-only D1 binding.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeDevWorkerConfig } from '../server/dev-worker-config.ts';
import { localD1StateDir } from '../server/local-d1.ts';

const WRANGLER = fileURLToPath(new URL('../node_modules/.bin/wrangler', import.meta.url));

/** The origin the browser uses — the vite dev server (with-worktree-port.sh sets PORT). */
export const webOrigin = () => `http://localhost:${process.env.PORT ?? 4510}`;

/** Spawn wrangler with this worktree's dev config and state dir bolted on. */
export async function spawnWrangler(args: string[]) {
  const stateDir = localD1StateDir();
  const config = await writeDevWorkerConfig(stateDir, webOrigin());
  // wrangler looks for `.dev.vars` next to the config file; ours is generated into the
  // state dir, so point it at the package's real one (the bridge reads the same file).
  const devVars = fileURLToPath(new URL('../web-poc/.dev.vars', import.meta.url));
  const envFile = existsSync(devVars) ? ['--env-file', devVars] : [];
  return Bun.spawn(
    [WRANGLER, ...args, ...envFile, '--config', config, '--persist-to', stateDir],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  );
}

if (import.meta.main) {
  const proc = await spawnWrangler(process.argv.slice(2));
  process.exit(await proc.exited);
}
