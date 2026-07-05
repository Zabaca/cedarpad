// Run the bridge (canvas store + agent) and the vite dev server together.
// Bridge on :4511, web on :4510 (vite proxies /api -> bridge), extension server on
// :4512 (the bridge proxies /api/custom/* -> it).
export {};

const BRIDGE = process.env.CANVAS_BRIDGE ?? 'http://localhost:4511';

// Internal key for in-stack calls to the bridge's canvas API, minted fresh per
// boot. The bridge gates /api/* behind a Better Auth session; the extension
// server's handlers have no session, so they authenticate with this key
// (x-internal-key). Never leaves the process family; unset = bypass disabled.
// Passed via explicit spawn env: Bun.spawn's default env inheritance does NOT
// see runtime process.env mutations, so relying on it silently drops the key.
const INTERNAL_KEY = crypto.randomUUID();
const stackEnv = { ...process.env, CANVAS_INTERNAL_KEY: INTERNAL_KEY };

// --watch only in LOCAL dev (restart the bridge when we edit its code). In the
// container (IS_SANDBOX) the bridge code only changes via a redeploy, so --watch
// buys nothing and a stray file touch restarting the live bridge mid-session just
// risks dropping in-flight state. vite still HMRs the agent's components regardless.
const bridgeArgs = process.env.IS_SANDBOX
  ? ['bun', 'run', 'server/bridge.ts']
  : ['bun', 'run', '--watch', 'server/bridge.ts'];
const bridge = Bun.spawn(bridgeArgs, {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: stackEnv,
});
// `bun run dev:web`, not `bunx vite`: the container base image ships `bun` but
// not the `bunx` shim, so `bunx` ENOENTs and the dev stack dies on boot.
const web = Bun.spawn(['bun', 'run', 'dev:web'], {
  stdio: ['inherit', 'inherit', 'inherit'],
  env: stackEnv,
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
    env: { ...stackEnv, CANVAS_BRIDGE: BRIDGE },
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
