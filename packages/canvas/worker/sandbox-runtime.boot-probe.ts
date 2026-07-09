// Test-only subprocess harness for sandbox-runtime.test.ts (NOT a `.test.ts`, so `bun test`
// doesn't collect it). It exercises the REAL `serveWorkspace` boot for the dev-agent coords with
// the `@cloudflare/sandbox` layer stubbed, and prints what the orchestration asked of the
// container as JSON on stdout.
//
// Why a subprocess: two sibling worker test files wholesale-mock `./sandbox-runtime.ts` via bun's
// PROCESS-GLOBAL mock registry, which leaks across files and would hand this test their stub
// instead of the real module. Running in a fresh `bun` process is the clean isolation; a
// `Bun.plugin` virtual module stubs `@cloudflare/sandbox` (which otherwise pulls `cloudflare:workers`)
// before the real module is imported.

import { plugin } from 'bun';

const calls = { getSandboxIds: [] as string[], started: [] as string[], waited: [] as number[], exposed: [] as number[] };
let fetchN = 0;

plugin({
  name: 'stub-cloudflare-sandbox',
  setup(build) {
    build.module('@cloudflare/sandbox', () => ({
      loader: 'object',
      exports: {
        getSandbox: (_ns: unknown, id: string) => {
          calls.getSandboxIds.push(id);
          return {
            // First fetch (warm probe) misses so the cold boot path — the one that starts the
            // stack — runs, exactly as a freshly-woken container with no exposed port would.
            fetch: () => {
              fetchN += 1;
              if (fetchN === 1) throw new Error('container asleep/gone');
              return Promise.resolve(new Response('proxied', { status: 200 }));
            },
            setEnvVars: () => Promise.resolve(),
            getProcess: () => Promise.resolve(null), // no running process ⇒ fresh start
            writeFile: () => Promise.resolve(),
            startProcess: (command: string) => {
              calls.started.push(command);
              return Promise.resolve({
                waitForPort: (port: number) => {
                  calls.waited.push(port);
                  return Promise.resolve();
                },
              });
            },
            killProcess: () => Promise.resolve(),
            exposePort: (port: number) => {
              calls.exposed.push(port);
              return Promise.resolve();
            },
          };
        },
      },
    }));
  },
});

const { serveWorkspace } = await import('./sandbox-runtime.ts');

// The dev-agent coords the edge chat proxy hands serveWorkspace (matches inbox-bridge.ts
// `coordsForWorkspace(DEV_AGENT_WORKSPACE_ID)`).
const res = await serveWorkspace(
  new Request('https://poc.cedarpad.com/api/chat/c1/transcript'),
  { R2_BUCKET: '', R2_ACCESS_KEY_ID: '', R2_SECRET_ACCESS_KEY: '', R2_ENDPOINT: '', CLAUDE_CODE_OAUTH_TOKEN: '', Sandbox: {} } as never,
  { sandboxId: 'dev-agent', r2Prefix: 'workspaces/dev-agent/', canvasWorkspace: 'dev-agent' },
);

console.log('__BOOT_PROBE__' + JSON.stringify({ status: res.status, ...calls }));
