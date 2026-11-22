# Writing Nookdeck themes

A theme pack changes how every tile on the phone looks: colors, fonts, corners, backgrounds, icons and, if you want, your own CSS. A pack never runs code. It is a folder with one `nookdeck.json`, plus optional CSS, fonts, icons and images.

- **Use one:** open **Theme → Packs** in the manage page, pick a pack, a variant and press **Apply**. Undo is right there.
- **Make one in 5 minutes:** see [First theme in 5 minutes](#first-theme-in-5-minutes).
- **Share one:** see [Share it](#share-it).

Official packs live in [howznguyen/nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins/tree/main/themes) next to the plugins. The `nookdeck` and `nookdeck-classic` packs ship inside the app.

## Contents

1. [First theme in 5 minutes](#first-theme-in-5-minutes)
2. [The manifest](#the-manifest)
3. [The look: every field](#the-look-every-field)
4. [Variants, Auto and options](#variants-auto-and-options)
5. [Per-kind tokens](#per-kind-tokens)
6. [Assets and limits](#assets-and-limits)
7. [Custom CSS (`theme.css`)](#custom-css-themecss)
8. [The theming API](#the-theming-api)
9. [Safety, safe mode and reset](#safety-safe-mode-and-reset)
10. [Share it](#share-it)

## First theme in 5 minutes

1. Open **Theme → Customize** and make the deck look the way you like: colors, corners, fonts, background.
2. Export it. Either press **Export this look** (Customize, at the bottom), or run:

   ```bash
   nookdeck theme export ./my-theme --id dev.yourname.my-theme --name "My theme"
   ```

   You get a folder with a `nookdeck.json` that holds your look (and the background image, if you use one).
3. Open `nookdeck.json` and fill in `author` and `description`. Add a second variant if you want one (see [Variants](#variants-auto-and-options)).
4. Install it from the folder: **Theme → Packs → Install from a link**, then paste the folder path or a GitHub address. Or call `POST /api/themes/install` with `{ "source": "/path/to/my-theme" }`. It shows up in **Installed**.
5. Want more? Add a `theme.css` next to the manifest and reference it with `"css": "theme.css"`, then install again.

Nothing leaves your computer. To get it listed in the Store, see [Share it](#share-it).

## The manifest

```json
{
  "$schema": "https://nookdeck.app/schema/plugin.json",
  "type": "theme",
  "id": "dev.alice.sunrise",
  "name": "Sunrise",
  "version": "1.0.0",
  "nookdeck": ">=0.4.0",
  "author": "Alice",
  "description": "Warm light and dark looks.",
  "preview": "previews/day.png",
  "css": "theme.css",
  "auto": { "light": "day", "dark": "night" },
  "theme": { "radius": 16, "gap": 10 },
  "variants": [
    { "id": "day", "name": "Day", "mode": "light", "preview": "previews/day.png",
      "theme": { "accent": "#d9480f", "background": "#fff8f0", "tile": "#ffffff", "text": "#2b2118" } },
    { "id": "night", "name": "Night", "mode": "dark", "preview": "previews/night.png",
      "theme": { "accent": "#ffa94d", "background": "#17120e", "tile": "#241d17", "text": "#f3e9dc" } }
  ],
  "options": [
    { "id": "accent", "name": "Accent",
      "values": [
        { "id": "orange", "name": "Orange", "theme": { "accent": "#ff922b" } },
        { "id": "teal", "name": "Teal", "theme": { "accent": "#12b886" } }
      ] }
  ]
}
```

| Field | Required | What it is |
|---|---|---|
| `type` | yes | Always `"theme"`. |
| `id` | yes | Reverse-domain id, like `dev.alice.sunrise`. Lower case letters, digits, `.`, `-`. |
| `name`, `version` | yes | Shown in the Store. Version is `1.2.3`. |
| `nookdeck` | no | The oldest Nookdeck it works with, like `">=0.4.0"`. A dev build satisfies any minimum. |
| `author`, `description` | no | Shown on the card. |
| `preview` | no | A picture of the pack for its card (png, jpg or webp). A missing file does not fail the install. |
| `theme` | no | The look shared by every variant (see below). |
| `css` | no | A CSS file inside the package. See [Custom CSS](#custom-css-themecss). |
| `auto` | no | `{ "light": "<variant id>", "dark": "<variant id>" }`: the default pair for **Auto**. |
| `variants` | yes | 1 to 12 looks the user can pick between. |
| `options` | no | Up to 4 choices that change a little (like the accent) on top of any variant. |

A pack with one variant is fine: the card then shows a single look. Keep to 12 variants. If you have more, split them into two packs.

## The look: every field

A **look** is a plain object. Everything is optional; a missing field keeps the default (or the value from the shared `theme`).

| Field | Values | Notes |
|---|---|---|
| `mode` | `dark`, `light`, `auto` | Set by the variant's own `mode`. |
| `accent` | CSS color | Highlights, active tiles, charts. |
| `background` | CSS color | The screen. |
| `tile` | CSS color | Tile fill. |
| `text`, `muted` | CSS color | Main and secondary text. |
| `radius` | 0 to 40 (px) | Corner size. |
| `gap` | 0 to 40 (px) | Space between tiles. |
| `fontScale` | 0.5 to 2 | Text size. |
| `tileStyle` | `tint`, `solid`, `outline`, `ios` | How tiles are filled. |
| `iconScale` | 0.5 to 2 | Icon size. |
| `iconStroke` | 1 to 3 | Line icon thickness. |
| `iconStyle` | `line`, `filled` | |
| `showLabels` | true, false | |
| `labelPosition` | `bottom`, `top`, `hidden` | |
| `labelWeight` | `regular`, `medium`, `bold` | |
| `font`, `numberFont` | `system`, `rounded`, `mono`, `serif`, `condensed`, or `pkg:<Family>` | `pkg:` is a font the pack ships (see [Assets](#assets-and-limits)). `numberFont` is for big numbers and the clock. |
| `backgroundImage` | `theme:<pack id>/<file>` | A file inside the pack, under `backgrounds/`. |
| `backgroundFit` | `cover`, `contain` | |
| `backgroundDim` | 0 to 0.9 | A dark veil over the image, so text stays readable. |
| `backgroundBlur` | 0 to 30 (px) | |
| `gradient` | `{ "from": "#...", "to": "#...", "angle": 180 }` | Replaces the plain background. |
| `tileOpacity` | 0.05 to 1 | Lower it for glass looks. |
| `tileBlur` | 0 to 30 (px) | Blurs what is behind a tile. |
| `border` | `{ "width": 0 to 3, "color": "#..." }` | |
| `shadow` | `none`, `soft`, `strong` | |
| `palette` | `{ "ok", "warn", "error", "info" }` | Status colors used by gauges and plugin tiles. |
| `chartColors` | up to 6 colors | Series colors in charts. |

A look never changes **behaviour**: language, orientation, header, screen settings, update checks and temperature unit stay as the user set them. Applying a pack also keeps per-tile colors.

## Variants, Auto and options

Each variant is a look plus a name and a light or dark `mode`:

```json
{ "id": "night", "name": "Night", "mode": "dark", "theme": { "accent": "#ffa94d" } }
```

The look of a variant is built in this order: the pack's shared `theme`, then the variant's `theme`, then the user's **option** choices. A variant's `kinds.<kind>` replaces the shared kind as a whole, and a variant's `fonts` replaces the shared font list.

**Auto** applies a light and a dark variant together. The deck follows the phone's light or dark setting. If the user set a dim schedule in **Screen & alarms**, Auto means dark inside the schedule and light outside it. Give your pack an `auto` pair so Auto is one tap.

**Options** are small choices on top of a variant, such as the accent color:

```json
{ "id": "accent", "name": "Accent", "values": [
  { "id": "mauve", "name": "Mauve", "variants": { "latte": { "accent": "#8839ef" }, "mocha": { "accent": "#cba6f7" } } },
  { "id": "green", "name": "Green", "theme": { "accent": "#40a02b" } }
] }
```

- A value carries `theme` (the same for every variant) or `variants` (a patch per variant id), or both. `variants` wins for that variant.
- At most 4 options per pack and 16 values per option.
- An option patch may not carry `kinds` or `fonts`.

## Per-kind tokens

Tiles come in kinds. A look can restyle one kind without touching the rest with `kinds`:

```json
"kinds": {
  "clock": { "numberFont": "pkg:Orbitron", "accent": "#ff7edb" },
  "button": { "radius": 6, "states": { "pressed": { "tile": "#3a2b52" } } }
}
```

Kinds: `button`, `clock`, `metric`, `media`, `weather`, `quota`, `entity`, `plugin`, `folder`, `header`, `standby`, `sheet`.

| Token | Notes |
|---|---|
| `tile`, `text`, `muted`, `accent` | Colors for that kind. |
| `radius`, `border`, `shadow` | Corners, outline, depth. |
| `tileOpacity`, `tileBlur` | `tileOpacity` only applies when that kind also sets `tile`. |
| `font`, `numberFont` | |
| `labelPosition`, `labelWeight`, `tileStyle` | |
| `states.pressed` | While the tile is pressed (`:active`). |
| `states.active` | When the tile is on or playing (`data-state="on"` or `"playing"`). |
| `states.alert` | When the tile warns or fails (`data-state="warn"` or `"error"`). |

## Assets and limits

Put files in the package and refer to them by relative path.

| Asset | Where | Limit |
|---|---|---|
| Fonts | `fonts/<name>.woff` or `.woff2`, declared in `fonts` | At most 4 files, 400 KB each. |
| Icons | `icons/<name>.svg` | Cleaned of scripts and external links. 20 KB each. Replaces the built-in icon of the same name. It is drawn in the brand style: keep its colors or use `currentColor`. |
| Backgrounds | `backgrounds/*.png`, `.jpg`, `.webp` | 2 MB each. |
| Previews | `previews/*` | Shown on cards. |
| Standby | `standby/face.(png/jpg/webp)` is the analog dial. `standby/background.(png/jpg/webp)` is the standby background. | 2 MB each. |
| Whole package | | 5 MB. |
| `theme.css` | | 64 KB. |
| Other files | `LICENSE`, `LICENSE.md`, `LICENSE-*`, `NOTICE`, `COPYING`, `AUTHORS`, `README.md` | Served as plain text. |

Declare fonts in the look:

```json
"fonts": [{ "family": "Orbitron", "file": "fonts/Orbitron-Bold.woff2", "weight": 700 }],
"numberFont": "pkg:Orbitron"
```

The family is 1 to 40 letters, digits, spaces, `-` or `_`. Bundle the font's licence next to it. Fonts under the SIL Open Font License are fine. Do not ship fonts you do not have the right to redistribute.

A pack does **not** run code and cannot install anything: no `node_modules`, no scripts, no remote files. Everything the theme needs is in the folder.

`data-part="background"` is the layer behind everything. A pack may paint it (gradients, patterns, package images) with `background-image`, `background-color` and so on; its colour defaults to `--nd-bg`. Whenever a pack is applied the deck guarantees that layer is shown and that the panel and sheet are transparent over it, so no override is needed. `data-part="clock-card"` is the flip card of a flip clock and `data-part="clock-digit"` each half of a digit on it.

`data-part="num"` marks every number the deck draws (clock digits, metric and weather values, media times, deltas, ring centres, entity values); together with `tile-value` it takes the pack's `numberFont`, with `font` as the fallback. Big text is fitted to its box after the fonts load: row text and ring centres are scaled down when a wide font (Orbitron, Press Start 2P) would overflow, ring centres drop their unit first, and button labels wrap to two lines, then step down, then end in an ellipsis. Tiles clip their content, so a pack never needs its own overflow rules.

## Custom CSS (`theme.css`)

For things a look cannot say (glows, pseudo-element decoration, animations) add a CSS file and set `"css": "theme.css"` in the manifest. The agent parses it with a real CSS parser when you install it, then scopes every rule under your pack, so it cannot style anything else:

```css
/* you write */
[data-part="tile-value"] { text-shadow: 0 0 8px var(--nd-accent); }

/* the agent serves */
.pd-root[data-theme-pkg="dev.alice.sunrise"] [data-part="tile-value"] { text-shadow: 0 0 8px var(--nd-accent); }
```

`:root` and `.pd-root` in your CSS mean the deck root itself. A variant can also have its own CSS (`variants[].css`). It then applies only when that variant is on.

**Allowed:** normal properties and selectors, `@media`, `@supports`, `@keyframes` (names may not start with `pd-`), and `@font-face` with a font from your package.

**Rejected on install** (the pack does not install, with the reason): `@import`, `@namespace`, `@charset`, `url()` that points outside the package, attribute selectors on `value` or on `data-*` (they would let CSS read tile data), `expression()`, `behavior`, `position: fixed`, a `z-index` above the sheet layer, selectors on `html` or `body`, and backslash escapes in selectors.

**Be kind to the phone:**

- Animations are turned off in lite mode and under `prefers-reduced-motion`. Do not rely on them for meaning.
- Keep it safe for old phones (Safari 12): avoid `aspect-ratio`, `gap` on flexbox, `:is()` and `inset`, and add the `-webkit-` prefix for `clip-path`, `transform` and `mask`.
- Prefer cheap effects: shadows over big blurs, no huge filters.

Use the data hooks below instead of guessing class names. Class names can change between versions. The hooks do not.

## The theming API

What a theme can reach on the deck:

```
  nookdeck.json ── look ──► CSS variables on the deck root (--nd-*)
        │                        │
        └─ theme.css ────────────┴──► styles tiles through data-* hooks
                                         [data-part] [data-kind] [data-state] [data-size]
```

### Data hooks

| Attribute | Values |
|---|---|
| `data-part` | `tile`, `tile-icon`, `tile-label`, `tile-value`, `tile-sub`, `chart`, `gauge`, `button`, `header`, `page-dots`, `sheet`, `standby`, `background`, `clock-digit`, `clock-card`, `num` |
| `data-kind` | `button`, `clock`, `metric`, `media`, `weather`, `quota`, `entity`, `plugin`, `folder`, `header`, `standby`, `sheet` |
| `data-state` | `on`, `off`, `playing`, `ok`, `warn`, `error` |
| `data-size` | The tile's size in cells, like `"2x1"` |
| On the root: `data-theme-pkg`, `data-theme-variant` | The applied pack id and variant id. |

Which tiles set `data-state`:

| Tile | State |
|---|---|
| Button | `playing` while a sound or a busy state runs |
| Media | `playing` or `off` |
| Entity (Home Assistant) | `on` or `off` |
| Plugin | `ok`, `warn`, `error` or `off` |
| CPU and memory | `ok`, then `warn` from 75 percent, `error` from 90 percent |
| Others | none |

State colors are yours to style: the deck does not color `ok`, `warn` and `error` for you.

### CSS variables

`--nd-accent`, `--nd-bg`, `--nd-tile-bg`, `--nd-tile-opacity`, `--nd-text`, `--nd-muted`, `--nd-radius`, `--nd-gap`, `--nd-font`, `--nd-number-font`, `--nd-border-width`, `--nd-border-color`, `--nd-shadow`, `--nd-tile-blur`, `--nd-ok`, `--nd-warn`, `--nd-error`, `--nd-info`, and `--nd-chart-1` to `--nd-chart-6`.

### Example: a glowing clock

```css
[data-kind="clock"] [data-part="tile-value"] {
  font-family: var(--nd-number-font);
  text-shadow: 0 0 6px var(--nd-accent), 0 0 18px var(--nd-accent);
}
[data-part="tile"][data-state="warn"]  { box-shadow: 0 0 0 1px var(--nd-warn); }
[data-part="tile"][data-state="error"] { box-shadow: 0 0 0 1px var(--nd-error); }
```

### Local HTTP API

These are on the agent (localhost, with the header `x-nookdeck: 1`). The manage page uses them.

| Call | What it does |
|---|---|
| `GET /api/themes` | `{ themes, registry, applied }`: installed packs, the Store, and which one is applied. |
| `POST /api/themes/install` | `{ "source": "<folder or GitHub address>" }` or `{ "id": "<store id>" }`. |
| `POST /api/themes/<id>/apply` | `{ "variant": "night" }` or `{ "auto": { "light": "day", "dark": "night" } }`, plus optional `"options": { "accent": "teal" }`. Returns `{ ok, theme, previous, source }`. An empty body re-applies. |
| `POST /api/themes/<id>/fork` | `{ "name"?, "variant"?, "options"? }`: a local editable copy (`local.fork.<name>-xxxx`) with one variant. Copies fonts, icons, the background and the CSS. Does not apply it. |
| `DELETE /api/themes/<id>` | Removes a pack. Built-in packs answer 409. |
| `POST /api/themes/export` | `{ "id", "name", "version"?, "author"?, "description"?, "preview"? }`: the current look as a zip. |
| `GET /api/themes/<id>/files/<path>` | A file of an installed pack. |
| `GET /api/themes/<id>/css?variant=<v>` | The scoped CSS. |

To undo an apply, `PUT /api/layout` with `theme: previous`, or `POST /api/layout/undo`.

CLI:

```bash
nookdeck theme export <dir> [--id dev.me.name] [--name "My theme"]   # current look to a folder
nookdeck theme reset                                                 # back to the default look
```

## Safety, safe mode and reset

- A theme is data and CSS. It cannot run code, read your data, or reach the network.
- Packs from the Store are pinned to a checked file hash. A pack from a link is marked **not reviewed**.
- If a theme makes the phone hard to read, open the deck with `/?theme=off`: it ignores the theme for that page load.
- To go back for good, run `nookdeck theme reset` or press **Reset to defaults** in Theme → Customize.

## Share it

1. Put the folder in a public GitHub repo (anyone can install it by address), or
2. Open a pull request to [howznguyen/nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins) under `themes/<your-pack>/`. Keep it small, add previews of each variant and a `LICENSE`. If it is based on another theme, say so and keep that theme's licence.

Rules for a listed pack:

- Original work, or a port with a licence that allows it (MIT, Apache-2.0 and similar). Say who made the original, and include its licence text.
- No logos or names of games, films or brands you do not own.
- Previews are 16:9 pictures of the deck, rendered from a real screen.
- Fonts and images must be free to redistribute, with their licence files in the folder.

## Preview a theme without Nookdeck

The real deck also builds as a **demo deck**: the same code in preview mode, with no agent, no pairing and no network, so a website can show a theme exactly as a phone would draw it.

```bash
cd web/deck && bun run build:demo      # writes web/deck/dist-demo/ (index.html + assets/, relative urls)
```

Host `dist-demo/` as static files on the same origin as the page that embeds it (an `<iframe src="demo/index.html">`). The page has a Content-Security-Policy that allows only its own files (`default-src 'none'`, `connect-src 'self'`), and a runtime guard that refuses every request to `/api`, `/ws` or another host. Sample stats, sparklines and media drift a little, deterministically.

### The message

The embedding page sends the iframe a message. It may send it again at any time to change the preview; only the parent window can drive the demo.

```js
frame.contentWindow.postMessage({
  type: "nd-demo",
  theme: { /* the variant's resolved look: look fields, kinds, fonts */ },
  pkg: "dev.author.name",        // becomes data-theme-pkg
  variant: "night",              // becomes data-theme-variant
  css: "…",                      // the pack's css, already checked and scoped (see below)
  fonts: [{ family: "Orbitron", url: "fonts/Orbitron-Bold.woff2", weight: 700 }],
  icons: { home: "<svg viewBox=…>…</svg>" },   // optional icon pack, whole svg documents
  files: { "theme:dev.author.name/bg.png": "bg.png" },   // urls for package files the look names
  layout: { pages: […] },        // optional; default is a sample Overview
  page: "overview",              // optional page id or index
  np: "last"                     // optional: playing (default) | last | empty
}, location.origin);
```

- The iframe tells the parent it is ready with `{ type: "nd-demo-ready" }`. The same object (base64url JSON) also works as `?d=` or `#d=` in the iframe address.
- Every field is optional. `theme` replaces the look fields of the layout's theme; `pkg` and `variant` set the root attributes your css selects on.
- **Urls** (`css`, `fonts`, `files`) may be relative (the demo's own files), `data:` images and fonts, `blob:`, or absolute on the demo's own origin. Anything else makes the demo ignore that css, font or file. `@import`, `@namespace`, `@charset`, `expression()` and `behavior` are refused too. css is at most 128 KB.
- **Icons** that contain a script, `foreignObject`, an event handler or an external reference are dropped.

### Getting the message from a pack

`nookdeck theme demo` builds the whole message from a theme folder, with the same checks and scoping the agent uses on install:

```bash
nookdeck theme demo ./my-theme --variant night --base https://example.com/themes/my-theme > night.json
nookdeck theme demo ./my-theme --variant day --options accent=mauve --base …
```

`--base` is where the pack's files (fonts, backgrounds, css images) are hosted; the css and the font urls in the output point there. Send the JSON as the message.
