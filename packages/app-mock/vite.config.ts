import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Worktree-safe per CLAUDE.md §6: read PORT from env, default 5174
// (different from the real Slice 1 dev server's 5173).
const port = Number(process.env.PORT ?? 5174);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
  },
});
