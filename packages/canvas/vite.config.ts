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
      // /api/* → canvas bridge (canvas sync + chat, and web-poc's Better Auth at
      // /api/auth/*). /v1/* → web-poc's data API, also served by the bridge.
      '/api': { target: BRIDGE, changeOrigin: true },
      '/v1': { target: BRIDGE, changeOrigin: true },
    },
  },
});
