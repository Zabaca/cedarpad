import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Worktree-safe: PORT must come from env. Default 5177 is distinct from
// other mock variants (mock = 5175, mock-branches = 5176) per CLAUDE.md §6.
const port = Number(process.env.PORT ?? 5177);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: false,
    host: "127.0.0.1",
  },
  preview: {
    port,
  },
});
