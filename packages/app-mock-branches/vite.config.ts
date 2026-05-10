import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Worktree-safe: read PORT from env, default 5176 (distinct from other mocks)
const port = Number(process.env.PORT ?? 5176);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: false,
  },
});
