import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const port = Number(process.env.VITE_DEV_PORT ?? process.env.PORT ?? 1420)

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
})
