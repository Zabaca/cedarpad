import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// One Vite build: the React SPA (client) + the Hono worker, run in the real
// `workerd` runtime by `@cloudflare/vite-plugin` (HMR for both). No API proxy
// needed — the worker handles /api/* and /v1/* in-process, same origin as the SPA.
export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // Split always-loaded vendors into cacheable chunks. (@xyflow/react and
        // ably are code-split on demand via lazy import — see GraphView/realtime.)
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@mantine")) return "mantine";
          if (id.includes("@tanstack")) return "query";
          if (id.includes("better-auth")) return "auth";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
  // Worktree-safe dev port: never hardcode 5173.
  server: {
    port: Number(process.env.VITE_DEV_PORT ?? process.env.PORT ?? 5173),
    strictPort: true,
  },
});
