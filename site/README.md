# Nookdeck landing page

The marketing site for [Nookdeck](https://github.com/howznguyen/nookdeck), served at <https://nookdeck.app>. It is a static [Astro](https://astro.build) site with no analytics and no third-party scripts. Fonts are self-hosted through Fontsource. It has its own `package.json` and is not part of the root build or tests.

## Run it

```sh
cd site
bun install && bun run build   # writes dist/
bun run dev                    # dev server on http://localhost:4321
bun run preview                # serve dist/ locally
```

## Deploy

Cloudflare serves this as static assets through a Worker. `wrangler.toml` points `[assets] directory` at `./dist` and serves `404.html` for unknown paths.

```sh
bun run build && bunx wrangler deploy
```

Live at <https://nookdeck.knowns.workers.dev>; attach the nookdeck.app domain in the Cloudflare dashboard.

## Where things are

| Path | What |
|---|---|
| `src/pages/index.astro`, `vi/`, `zh/` | One page per language, all rendering `Landing.astro` |
| `src/components/Landing.astro` | Every section and the small inline script (OS toggle, copy button, theme) |
| `src/i18n/en.ts`, `vi.ts`, `zh.ts` | All copy. English is the source of truth; the others are typed against it |
| `src/styles/global.css` | Design tokens, light and dark themes, layout |
| `public/img/` | Brand mark, apple-touch icon, the hero crop used for the OG image |

## Placeholders to swap

The phone screenshots in `public/img/deck-*.jpg` and `glance-*.jpg` are crops of `docs/images/promo-*.png`, taken so the old PhoneDesk name is not visible. `deck-claude.jpg` still shows the old name in small text inside the prompt. Re-crop them from the regenerated images when those exist.

## Design

"A nook on your desk": warm evening-desk (dark) and morning-desk (light) palettes, Fraunces for display, Instrument Sans for text, JetBrains Mono for commands. The phone's own cyan is the only cool colour on the page.

The phone in the hero and the sticky one in the story section are a live React component (`src/components/deck/Deck.tsx`, drawn in an 880x426 box and scaled). The clock, CPU and now-playing bar move, it cycles Overview, Keys, AI and Home, and the keys, lamps, play button and permission prompt react to taps. Data on it is demo data. `src/components/PluginDemo.tsx` renders the plugin manifest, the stat tile it makes, and a reconstruction of the permission prompt from `docs/plugins.md` (not a screenshot of the manage page).

## Built with Knowns UI

`CommandChip`, `MediaFrame` helpers and `FooterMinimal` come from [Knowns UI](https://ui.knowns.dev) (Pro), installed as source under `src/components/ui/knowns` with `npx knowns-ui@latest add hero-split feature-split cta-section feature-grid footer-minimal`, and restyled in `src/styles/global.css`. Several installed items are unused (`hero-split`, `feature-split`, `feature-grid`, `cta-section`); delete them if you want a smaller tree. Installing more Pro items needs `KNOWNS_LICENSE_KEY` in the environment (never commit it; `site/.gitignore` ignores `.env*`). Building the site needs no key, and the CLI needs Node on the PATH.

React islands are `Hero`, `Story`, `PluginDemo`, `Install` and `Footer`; everything else is static Astro. Theme tokens live in `src/styles/tw.css`.

## Placeholders to swap

`public/og.png` is rendered from `public/img/deck-hero.jpg`, a crop of `docs/images/promo-hero.png` with the old name cropped out. Re-render it if the promo images are regenerated.
