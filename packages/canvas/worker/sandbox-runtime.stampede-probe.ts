// Test-only subprocess harness for sandbox-runtime.test.ts (#138). NOT a `.test.ts`, so `bun test`
// doesn't collect it. It fires N concurrent cold requests at a sleeping container through the REAL
// serveWorkspace and reports how many times the container was actually started — proving the
// single-flight collapses the page-load stampede into ONE boot instead of N racing kill+starts.
//
// Same subprocess isolation rationale as sandbox-runtime.boot-probe.ts: sibling test files
// wholesale-mock `./sandbox-runtime.ts` via bun's process-global registry, so a fresh `bun` process
// is the clean way to exercise the real module with `@cloudflare/sandbox` stubbed.

import { plugin } from 'bun';

import { type BootableSandbox, BootLock, bootCanvasStack, type CanvasBootSpec } from './canvas-boot.ts';

const calls = { started: [] as string[], exposed: [] as number[] };
let bootComplete = false;
// One lock for the whole probe, as production has one per container: `getSandbox` is called
// per request, but every call resolves to the SAME DO — so a per-stub lock would prove
// nothing about the stampede.
const lock = new BootLock();

plugin({
  name: 'stub-cloudflare-sandbox',
  setup(build) {
    build.module('@cloudflare/sandbox', () => ({
      loader: 'object',
      exports: {
        getSandbox: () => {
          const stub = {
            ensureCanvasStack: (spec: CanvasBootSpec) => lock.run(() => bootCanvasStack(stub as BootableSandbox, spec)),
            // The warm probe misses for EVERY caller until the boot finishes (exposePort), so all N
            // concurrent requests fall into the cold path together — exactly the stampede. After the
            // boot, proxied requests succeed.
            fetch: () => (bootComplete ? Promise.resolve(new Response('proxied', { status: 200 })) : Promise.reject(new Error('container asleep/gone'))),
            setEnvVars: () => Promise.resolve(),
            getProcess: () => Promise.resolve(null),
            writeFile: () => Promise.resolve(),
            startProcess: (command: string) => {
              calls.started.push(command);
              // A slow boot (like a real vite cold start) — the window in which the OLD code let
              // other requests barge in with their own kill+start.
              return Promise.resolve({
                waitForPort: async (port: number) => {
                  await new Promise((r) => setTimeout(r, 20));
                  void port;
                },
              });
            },
            killProcess: () => Promise.resolve(),
            exposePort: (port: number) => {
              calls.exposed.push(port);
              bootComplete = true;
              return Promise.resolve();
            },
          };
          return stub;
        },
      },
    }));
  },
});

const { serveWorkspace } = await import('./sandbox-runtime.ts');

const env = { R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_ENDPOINT: '', CLAUDE_CODE_OAUTH_TOKEN: '', Sandbox: {} } as never;
const coords = { sandboxId: 'canvas', r2Prefix: 'workspaces/default/', canvasWorkspace: 'default' } as const;

// Fire 8 concurrent cold requests, as a single page load would (pad + modules + /api/alive).
const results = await Promise.all(
  Array.from({ length: 8 }, (_, i) => serveWorkspace(new Request(`https://poc.cedarpad.com/w/default/canvas/default/pad?r=${i}`), env, coords)),
);

console.log('__STAMPEDE_PROBE__' + JSON.stringify({ statuses: results.map((r) => r.status), started: calls.started.length, exposed: calls.exposed.length }));
