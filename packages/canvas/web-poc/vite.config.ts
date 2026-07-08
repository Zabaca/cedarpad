import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Notebook SPA static build (ADR-0007, PRD #49 slice #58). This is the standalone
// build of web-poc's React SPA (`src/main.tsx` → `index.html`), served by the edge
// Worker under `/notebook` as the Notebook app surface — no container, no dev vite.
//
// `base: '/notebook/'` so the built index.html references its assets at
// `/notebook/assets/*`; the edge Worker strips the `/notebook` prefix before handing
// the request to the Workers static-assets binding (see worker/index.ts). The SPA's
// client uses relative paths (`VITE_API_URL` unset → ""), so it calls `/v1` and
// `/api/auth/*` on the same edge origin — already workspace-scoped by `cs_workspace`.
export default defineConfig({
  base: '/notebook/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
