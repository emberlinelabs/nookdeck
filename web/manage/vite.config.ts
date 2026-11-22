import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Served by the Nookdeck agent at http://localhost:7420/manage/ (localhost only).
// Dev: proxies /api and /ws to the agent, and also the phone deck ("/", "/assets", ...) so the
// preview iframe (/?preview=1) stays same-origin. Override the agent with NOOKDECK_AGENT=http://localhost:7431.
const AGENT = process.env.NOOKDECK_AGENT ?? process.env.PHONEDESK_AGENT ?? 'http://localhost:7420'
const proxy = (ws = false) => ({ target: AGENT, changeOrigin: true, ws })

export default defineConfig({
  base: '/manage/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, '../shared'),
    },
  },
  server: {
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
    proxy: {
      '/api': proxy(),
      '/ws': proxy(true),
      '^/(\\?.*)?$': proxy(),
      '/assets': proxy(),
      '/icon.svg': proxy(),
      '/manifest.webmanifest': proxy(),
    },
  },
})
