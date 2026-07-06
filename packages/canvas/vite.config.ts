import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Browser app on :4510, bridge (canvas store + agent) on :4511.
// All same-origin /api/* calls proxy to the bridge so the browser never needs
// to know the bridge port.
const BRIDGE = process.env.CANVAS_BRIDGE ?? 'http://localhost:4511';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4510,
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
