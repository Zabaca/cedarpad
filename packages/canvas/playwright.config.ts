import { defineConfig, devices } from '@playwright/test';

// PORT / CANVAS_BRIDGE_PORT / CANVAS_D1_STATE are already in the environment: the
// `test:e2e` script runs Playwright through with-worktree-port.sh +
// with-worktree-db.sh, so the webServer below inherits the derived values and
// the dev stack comes up on the same port Playwright targets.
const port = process.env.PORT ?? '4510';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

/** The one spec that mutates the vite root's filesystem — see the `cold-container` project. */
const COLD_CONTAINER = /component-cold-container\.spec\.ts/;

export default defineConfig({
  testDir: './e2e/specs',
  globalSetup: './e2e/globalSetup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // #276: one signed-in user owns the workspace the bridge serves, and
    // seeding that membership writes the live D1 — which the edge Worker holds open. So it
    // happens exactly once, before anything else runs, rather than per test.
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chromium', testIgnore: [/.*\.setup\.ts/, COLD_CONTAINER], dependencies: ['setup'], use: { ...devices['Desktop Chrome'] } },
    // Alone, and last. `component-cold-container` deletes a canvas's materialized directory to
    // simulate a fresh container — and vite answers an unlink under its root by broadcasting a
    // full reload to EVERY connected client, not just this spec's. Run beside the others and it
    // reloads their browsers mid-test (it took `canvas-page-memory` down, reproducibly). CI
    // already runs one worker, so this only bites locally; depending on `chromium` makes the
    // isolation explicit rather than a property of the worker count.
    {
      name: 'cold-container',
      testMatch: COLD_CONTAINER,
      dependencies: ['chromium'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // The canvas dev stack (vite + bun bridge + edge Worker). Inherits PORT / CANVAS_BRIDGE_PORT
    // / CANVAS_D1_STATE from the wrappers the `test:e2e` script already applied.
    command: 'bun run scripts/dev.ts',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
