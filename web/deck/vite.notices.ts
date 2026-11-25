import type { Plugin } from 'vite'

/**
 * Notices that have to travel with the code (THIRD_PARTY_NOTICES.md has the same). The minifier drops comments, so they are
 * put on the bundle after it has run: on whichever chunk holds the adapted code, which in a build with two pages (the demo) is
 * a shared chunk and not an entry. For both the deck and the demo build.
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

export function deckNotices(): Plugin {
  return {
    name: 'pd-deck-notices',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) if (file.type === 'chunk' && file.moduleIds.some((id) => /\/card-calendar\.tsx$/.test(id))) file.code = NOTICES + file.code
    },
  }
}
