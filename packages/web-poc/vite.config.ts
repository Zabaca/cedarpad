import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'

// Worktree-safe dev port (CLAUDE.md §6 / ADR-0003): never hardcode 5173.
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? process.env.PORT ?? 5173),
    strictPort: true,
  },
})
