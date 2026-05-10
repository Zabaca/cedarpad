import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    include: ['modules/**/*.test.ts', 'src-sidecar/**/*.test.ts', 'src/**/*.test.ts', 'e2e/**/*.spec.ts'],
  },
})
