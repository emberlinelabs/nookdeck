import preact from '@preact/preset-vite'
import legacy from '@vitejs/plugin-legacy'
import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/** demo.html -> index.html, so the folder can be served as it is. */
const indexName = (): Plugin => ({
  name: 'pd-demo-index',
  closeBundle() {
    const from = join('dist-demo', 'demo.html')
    if (existsSync(from)) renameSync(from, join('dist-demo', 'index.html'))
  },
})


/** The demo deck: the same deck, no agent, relative URLs so a static host can serve it from any folder. Output: dist-demo/ (never embedded in the agent). */
export default defineConfig({
  base: './',
  publicDir: false, // no manifest or app icons: the demo is only embedded
  plugins: [preact(), legacy({ targets: ['ios >= 12', 'safari >= 12'], renderModernChunks: false }), indexName()],
  build: {
    cssTarget: 'safari12',
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: { input: 'demo.html' },
  },
})
