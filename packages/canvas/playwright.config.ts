import { defineConfig, devices } from '@playwright/test';

// PORT / CANVAS_BRIDGE_PORT / CANVAS_D1_STATE are already in the environment: the
// `test:e2e` script runs Playwright through with-worktree-port.sh +
// with-worktree-db.sh, so the webServer below inherits the derived values and
// the dev stack comes up on the same port Playwright targets.
const port = process.env.PORT ?? '4510';
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

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
    // #276: one signed-in user owns the workspace the bridge files Conversations into, and
    // seeding that membership writes the live D1 — which the edge Worker holds open. So it
    // happens exactly once, before anything else runs, rather than per test.
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    { name: 'chromium', testIgnore: /.*\.setup\.ts/, dependencies: ['setup'], use: { ...devices['Desktop Chrome'] } },
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
