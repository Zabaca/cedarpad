import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The workspace-level shared component library (ADR-0007). A component authored in any
// canvas dir imports a promoted module by reference — `import Foo from '@shared/Foo'` —
// and `component-loader` dynamic-imports a placed shared instance from the same dir.
// "promote" moves a file here; the single source then propagates to every canvas.
const SHARED_COMPONENTS = fileURLToPath(new URL('./shared/components', import.meta.url));

// Browser app on :4510, bridge (canvas store + agent) on :4511.
// All same-origin /api/* calls proxy to the bridge so the browser never needs
// to know the bridge port.
const BRIDGE = process.env.CANVAS_BRIDGE ?? 'http://localhost:4511';
// The edge Worker (ADR-0018, #263): the platform data layer's routes are served by the
// edge locally, as they are in production. scripts/dev.ts sets this from the derived port.
const EDGE = process.env.CANVAS_EDGE ?? 'http://localhost:4513';
// Worktree-safe: the dev/e2e port comes from env (with-worktree-port.sh sets it);
// unset falls back to 4510 so a plain `bun run dev` is unchanged.
const PORT = Number(process.env.PORT ?? 4510);

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `@shared/<Name>` resolves to the workspace shared library, so a promoted module is
    // imported by reference (one live source) from any per-canvas dir.
    alias: { '@shared': SHARED_COMPONENTS },
  },
  server: {
    port: PORT,
    host: true, // bind 0.0.0.0 so the app is reachable from other machines on the LAN (e.g. http://192.168.0.233:4510). The /api proxy still targets the bridge on the host.
    // The container deploy reaches vite through the Cloudflare sandbox preview
    // proxy under an arbitrary Host; the Worker is the gate, so accept any host.
    allowedHosts: true,
    proxy: {
      // The platform data layer's routes go to the EDGE WORKER (matched first — vite
      // tries proxy keys in insertion order): Better Auth at /api/auth/* and the
      // Notebook API at /v1/*, both against miniflare's local D1. That is the same
      // split production runs (worker/index.ts handles them ahead of the container
      // proxy), so dev no longer simulates the datastore.
      '/api/auth': { target: EDGE, changeOrigin: true },
      // Canvas sync (ADR-0019) and its asset bucket are EDGE routes: the sync room lives
      // in a Durable Object, not the container. In production the pad is served through
      // the Worker so these are already same-origin; in dev the origin is vite, so they
      // proxy. `ws: true` is required — the sync route is a WebSocket upgrade.
      '/api/canvas-sync': { target: EDGE, changeOrigin: true, ws: true },
      '/api/canvas-assets': { target: EDGE, changeOrigin: true },
      '/v1': { target: EDGE, changeOrigin: true },
      // The guest door (#220) and its probe are EDGE-answered too — the share cookie is
      // minted and read by the Worker, and nothing downstream knows about it. Without
      // these two, guest mode is unreachable in local dev (the bridge 404s the probe, so
      // every guest reads as a member) and #294's read path cannot be exercised at all.
      // Regex, not a prefix: a plain '/share' key also swallows '/shared/…', which is the
      // pad app's second import root — proxying it to the edge 404s the module graph.
      '^/share/[^/]+$': { target: EDGE, changeOrigin: true },
      '/api/guest-session': { target: EDGE, changeOrigin: true },
      // Everything else under /api/* → canvas bridge (canvas sync + chat).
      '/api': { target: BRIDGE, changeOrigin: true },
    },
  },
});
