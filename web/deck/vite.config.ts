import preact from '@preact/preset-vite'
import legacy from '@vitejs/plugin-legacy'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * Build id of the deck: first 12 hex of sha1 over the sorted names of every emitted file under assets/ (joined by \n).
 * It cannot be a `define` (the names depend on the bundle itself), so it is injected into index.html as
 * <meta name="pd-build" content="...">, and written to dist/build.json ({build, files}) for the agent / gen-assets to read.
 */
function deckBuild(): Plugin {
  let build = ''
  let files: string[] = []
  return {
    name: 'pd-deck-build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        files = Object.keys((ctx && ctx.bundle) || {}).filter((n) => n.indexOf('assets/') === 0).sort()
        build = createHash('sha1').update(files.join('\n')).digest('hex').slice(0, 12)
        return html.replace('<head>', '<head><meta name="pd-build" content="' + build + '">')
      },
    },
    writeBundle(opts) {
      if (build) writeFileSync(join(opts.dir || 'dist', 'build.json'), JSON.stringify({ build: build, files: files }) + '\n')
    },
  }
}

const AGENT = process.env.NOOKDECK_AGENT ?? process.env.PHONEDESK_AGENT ?? 'http://localhost:7420'

export default defineConfig({
  base: '/',
  plugins: [
    preact(),
    // Old iPhones (iOS 12 / Safari 12): ship only the transpiled SystemJS bundle with polyfills.
    legacy({ targets: ['ios >= 12', 'safari >= 12'], renderModernChunks: false }),
    deckBuild(),
  ],
  build: { cssTarget: 'safari12', outDir: 'dist', emptyOutDir: true },
  server: {
    host: true,
    fs: { allow: ['..', '../shared'] },
    proxy: {
      '/api': { target: AGENT, changeOrigin: true },
      '/ws': { target: AGENT, ws: true },
    },
  },
})
