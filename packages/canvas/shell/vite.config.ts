import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Shell SPA (ADR-0007, PRD #103): the ONE chrome, built to `shell/dist` and served by
// the edge Worker from its static-assets binding at `/` (see worker/index.ts). Its own root
// is this directory; assets emit under `/assets/*` (vite's default), which cannot collide
// with the container's dev-server paths (`/src/*`, `/@vite/*`, `/node_modules/*`).
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    // shell/dist, served behind the edge Worker's ASSETS binding.
    outDir: 'dist',
    emptyOutDir: true,
  },
});
