// Run the bridge (canvas store + agent), the vite dev server, and the edge Worker
// together. Bridge on :4511, web on :4510 (vite proxies /api -> bridge), edge Worker
// on :4513.
export {};

import { spawnWrangler } from './wrangler-local.ts';

// Bridge listen port comes from env (with-worktree-port.sh derives it per
// worktree); unset falls back to 4511. We derive the vite /api proxy target from
// the same port so the browser always proxies to the bridge this stack started.
const BRIDGE_PORT = process.env.CANVAS_BRIDGE_PORT ?? '4511';
const BRIDGE = process.env.CANVAS_BRIDGE ?? `http://localhost:${BRIDGE_PORT}`;

// The edge Worker (ADR-0018, #263): it serves the platform data layer's routes — the
// Notebook API `/v1/*` and Better Auth `/api/auth/*` — against miniflare's local D1,
// exactly as it does in production. Port from env, +2 off the bridge (the +1 slot the
// removed extension server held stays vacant so every worktree's ports keep their offsets).
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
  // ADR-0018 / #266: the bridge has no database, so the edge Worker we just started IS its
  // platform data layer — point its RPC at it. In the container (IS_SANDBOX) the real edge is
  // the deployed Worker and `PLATFORM_RPC_ORIGIN` already arrives in the injected env.
  env: edge ? { ...process.env, PLATFORM_RPC_ORIGIN: EDGE } : process.env,
});
// `bun run dev:web`, not `bunx vite`: the container base image ships `bun` but
// not the `bunx` shim, so `bunx` ENOENTs and the dev stack dies on boot.
const web = Bun.spawn(['bun', 'run', 'dev:web'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  // Point vite's proxies at the bridge and edge ports this stack is using.
  env: { ...process.env, CANVAS_BRIDGE: BRIDGE, CANVAS_EDGE: EDGE },
});

let shuttingDown = false;

// Console PTY server (ADR-0021). SUPERVISED, not part of the critical pair — node-pty is
// a native module, and a segfault must restart THIS process, not take the critical pair
// (bridge + web) down with it.
//
// Spawned with `node`, not `bun`, and deliberately: node-pty is completely
// non-functional under bun (zero bytes, EBADF on resize — measured across two bun
// versions and two platforms). See pty-server/README.md before "unifying" the runtime.
//
// Optional in local dev: pty-server is its own npm-installed island (bun install cannot
// build node-pty), so a checkout that hasn't run `npm install` there simply gets no
// Console rather than a crash-looping stack.
const PTY_PORT = process.env.CANVAS_PTY_PORT ?? String(Number(BRIDGE_PORT) + 3);
const PTY_DIR = new URL('../pty-server/', import.meta.url).pathname;
let ptyServer: ReturnType<typeof Bun.spawn> | null = null;
const startPtyServer = () => {
  ptyServer = Bun.spawn(['node', 'server.mjs'], {
    cwd: PTY_DIR,
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, CANVAS_PTY_PORT: PTY_PORT },
  });
  void ptyServer.exited.then((code) => {
    if (shuttingDown) return;
    console.error(`[console] pty-server exited (${code}); restarting in 1s`);
    setTimeout(startPtyServer, 1000);
  });
};
if (await Bun.file(`${PTY_DIR}node_modules/node-pty/package.json`).exists()) {
  startPtyServer();
} else {
  console.warn('[console] pty-server not installed — run `cd pty-server && npm install` (npm, not bun)');
}

const killAll = () => {
  shuttingDown = true;
  bridge.kill();
  web.kill();
  ptyServer?.kill();
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
