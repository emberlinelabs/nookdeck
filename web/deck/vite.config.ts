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

/**
 * Notices that have to travel with the code (THIRD_PARTY_NOTICES.md has the same). The minifier drops comments, so they are
 * put on the app's bundle after it has run.
 */
const NOTICES = `/*!
 * Parts of the month and week cards are adapted from Knowns UI (https://github.com/knowns-dev/knowns-ui).
 * MIT License, Copyright (c) 2026 Knowns Lab
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
 * persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and
 * this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
 * "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
 * ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
`

function deckNotices(): Plugin {
  return {
    name: 'pd-deck-notices',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.isEntry && file.name !== 'polyfills') file.code = NOTICES + file.code
    },
  }
}

export default defineConfig({
  base: '/',
  plugins: [
    preact(),
    // Old iPhones (iOS 12 / Safari 12): ship only the transpiled SystemJS bundle with polyfills.
    legacy({ targets: ['ios >= 12', 'safari >= 12'], renderModernChunks: false }),
    deckBuild(),
    deckNotices(),
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
