import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Shell SPA (ADR-0007, PRD #103): the ONE chrome, built to `shell/dist` and served by
// the edge Worker from its static-assets binding at `/` (see worker/index.ts). Its own root
// is this directory; assets emit under `/assets/*` (vite's default), which cannot collide
// with the container's dev-server paths (`/src/*`, `/@vite/*`, `/node_modules/*`).
//
// One build hosts the shell AND a lazy `web-poc` chunk (slice #107 mounts <WebPocApp/> in the
// Notebook stage via `import('../web-poc/src/embed')`) — the same lazy chunk the container
// app already code-splits today, so no second React app and no second ASSETS directory.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    // shell/dist. The web-poc Notebook SPA builds into dist/notebook (base `/notebook/`),
    // sharing this one directory behind the single ASSETS binding — so emptyOutDir here
    // must run BEFORE that build (see scripts/deploy.sh).
    outDir: 'dist',
    emptyOutDir: true,
  },
});
