// Run the bridge (canvas store + agent) and the vite dev server together.
// Bridge on :4511, web on :4510 (vite proxies /api -> bridge), extension server on
// :4512 (the bridge proxies /api/custom/* -> it).
export {};

// Bridge listen port comes from env (with-worktree-port.sh derives it per
// worktree); unset falls back to 4511. We derive the vite /api proxy target from
// the same port so the browser always proxies to the bridge this stack started.
const BRIDGE_PORT = process.env.CANVAS_BRIDGE_PORT ?? '4511';
const BRIDGE = process.env.CANVAS_BRIDGE ?? `http://localhost:${BRIDGE_PORT}`;

// --watch only in LOCAL dev (restart the bridge when we edit its code). In the
// container (IS_SANDBOX) the bridge code only changes via a redeploy, so --watch
// buys nothing and a stray file touch restarting the live bridge mid-session just
// risks dropping in-flight state. vite still HMRs the agent's components regardless.
const bridgeArgs = process.env.IS_SANDBOX
  ? ['bun', 'run', 'server/bridge.ts']
  : ['bun', 'run', '--watch', 'server/bridge.ts'];
const bridge = Bun.spawn(bridgeArgs, {
  stdio: ['inherit', 'inherit', 'inherit'],
});
// `bun run dev:web`, not `bunx vite`: the container base image ships `bun` but
// not the `bunx` shim, so `bunx` ENOENTs and the dev stack dies on boot.
const web = Bun.spawn(['bun', 'run', 'dev:web'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  // Point vite's /api proxy at the bridge port this stack is using.
  env: { ...process.env, CANVAS_BRIDGE: BRIDGE },
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
