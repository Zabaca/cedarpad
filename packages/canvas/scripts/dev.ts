// Run the bridge (canvas store + agent), the vite dev server, and the edge Worker
// together. Bridge on :4511, web on :4510 (vite proxies /api -> bridge), extension
// server on :4512 (the bridge proxies /api/custom/* -> it), edge Worker on :4512+1.
export {};

import { spawnWrangler } from './wrangler-local.ts';

// Bridge listen port comes from env (with-worktree-port.sh derives it per
// worktree); unset falls back to 4511. We derive the vite /api proxy target from
// the same port so the browser always proxies to the bridge this stack started.
const BRIDGE_PORT = process.env.CANVAS_BRIDGE_PORT ?? '4511';
const BRIDGE = process.env.CANVAS_BRIDGE ?? `http://localhost:${BRIDGE_PORT}`;

// The edge Worker (ADR-0018, #263): it serves the platform data layer's routes — the
// Notebook API `/v1/*` and Better Auth `/api/auth/*` — against miniflare's local D1,
// exactly as it does in production. Port from env, +2 off the bridge so it clears the
// extension server's 4512.
const EDGE_PORT = process.env.CANVAS_EDGE_PORT ?? String(Number(BRIDGE_PORT) + 2);
const EDGE = process.env.CANVAS_EDGE ?? `http://localhost:${EDGE_PORT}`;

// --watch only in LOCAL dev (restart the bridge when we edit its code). In the
// container (IS_SANDBOX) the bridge code only changes via a redeploy, so --watch
// buys nothing and a stray file touch restarting the live bridge mid-session just
// risks dropping in-flight state. vite still HMRs the agent's components regardless.
const bridgeArgs = process.env.IS_SANDBOX
  ? ['bun', 'run', 'server/bridge.ts']
  : ['bun', 'run', '--watch', 'server/bridge.ts'];
// The edge Worker only runs in LOCAL dev: in the container (IS_SANDBOX) the real edge
// is the deployed Worker in front of it.
const edge = process.env.IS_SANDBOX
  ? null
  : await spawnWrangler(['dev', '--port', EDGE_PORT, '--inspector-port', String(Number(EDGE_PORT) + 1000)]);

const bridge = Bun.spawn(bridgeArgs, {
  stdio: ['inherit', 'inherit', 'inherit'],
});
// `bun run dev:web`, not `bunx vite`: the container base image ships `bun` but
// not the `bunx` shim, so `bunx` ENOENTs and the dev stack dies on boot.
const web = Bun.spawn(['bun', 'run', 'dev:web'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  // Point vite's proxies at the bridge and edge ports this stack is using.
  env: { ...process.env, CANVAS_BRIDGE: BRIDGE, CANVAS_EDGE: EDGE },
});

// Extension server: isolated agent-authored backend handlers (ADR 0002). SUPERVISED,
// not part of the critical pair — if a bad handler fatally crashes it, restart just
// this process; the canvas (bridge + web) is untouched. Handlers hot-reload via
// cache-bust, so no --watch needed. CANVAS_BRIDGE lets a handler call the core API.
let shuttingDown = false;
let extension: ReturnType<typeof Bun.spawn> | null = null;
const startExtension = () => {
  extension = Bun.spawn(['bun', 'run', 'server/extension-server.ts'], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, CANVAS_BRIDGE: BRIDGE },
  });
  void extension.exited.then(() => {
    if (shuttingDown) return;
    console.error('[custom] extension server exited; restarting in 1s');
    setTimeout(startExtension, 1000);
  });
};
startExtension();

const killAll = () => {
  shuttingDown = true;
  bridge.kill();
  web.kill();
  extension?.kill();
  edge?.kill();
};
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killAll();
  process.exit(0);
});

// If either process dies, take the other down so the operator isn't left with a
// half-running stack.
await Promise.race([bridge.exited, web.exited]);
killAll();
