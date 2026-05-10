import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'threads',
    isolate: true,
    include: ['modules/**/*.test.ts'],
  },
})
