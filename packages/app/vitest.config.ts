import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    include: ['modules/**/*.test.ts', 'src-sidecar/**/*.test.ts', 'src/**/*.test.ts', 'e2e/tests/**/*.spec.ts'],
    // e2e/webview/** runs under WebDriver (`bun run test:e2e:webview`), not vitest.
    exclude: ['e2e/webview/**'],
  },
})
