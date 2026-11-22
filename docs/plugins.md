# Writing Nookdeck plugins

A plugin adds tiles and buttons to Nookdeck. It is a folder (usually a GitHub repo) with a `nookdeck.json` file. This guide starts with **no-code plugins**, which need no JavaScript, and then covers [plugins with code](#plugins-with-code).

## Quick start

1. Copy [`nookdeck-plugins/plugins/crypto-price`](https://github.com/howznguyen/nookdeck-plugins/tree/main/plugins/crypto-price).
2. Change `id`, `name` and the widget.
3. In the manage page open **Plugins**, paste the folder path (or a GitHub address, or an https link to the `nookdeck.json`), read the access list and press **Allow and turn on**.
4. Add your tile to a screen.

## The manifest

```json
{
  "id": "dev.alice.crypto",
  "name": "Crypto price",
  "version": "1.0.0",
  "nookdeck": ">=0.2.0",
  "author": "alice",
  "description": "Live price of a coin",
  "icon": "icon.svg",
  "permissions": { "network": ["api.coingecko.com"] },
  "widgets": [ ... ],
  "actions": [ ... ]
}
```

| Field | Notes |
|---|---|
| `id` | Reverse-DNS style, `dev.<author>.<name>`. `core.*` is reserved for Nookdeck. |
| `version` | Exact version. Each install is pinned to a version and a hash of the package. |
| `nookdeck` | The Nookdeck versions the plugin works with. |
| `permissions` | Everything the plugin may touch. See below. |
| `widgets`, `actions` | What the plugin adds. |

## Permissions

The user sees this list before the plugin turns on, and nothing runs until they agree. An update that asks for more needs a new OK.

| Key | Meaning |
|---|---|
| `network` | A list of hosts the plugin may call. Calls to any other host fail. |
| `shell` | Run commands on the computer (needed by `command` sources). |
| `keyboard` | Press keys and type text. |
| `storage` | Keep the plugin's own data. |

Ask for the least you need. Plugins from a link or a folder are shown as **Unreviewed**.

## Widgets

A widget is a tile. It describes where its data comes from and how to show it.

```json
{
  "id": "price",
  "name": "Price",
  "render": "stat",
  "sizes": ["2x1", "2x2"],
  "settings": [{ "key": "coin", "type": "string", "label": "Coin id", "default": "bitcoin" }],
  "source": {
    "http": { "url": "https://api.coingecko.com/api/v3/simple/price?ids={{coin}}&vs_currencies=usd", "every": 60 },
    "map": { "value": "$.{{coin}}.usd", "unit": "USD", "label": "{{coin}}" }
  }
}
```

`{{key}}` inserts a setting. `every` is the refresh time in seconds.

**Commands never get `{{key}}`.** A `shell` macro step or a `command` source that contains `{{...}}` is rejected at install: a value with a quote, `;` or `$(...)` would run as code. The command reads its settings from the environment instead, as `NOOKDECK_SETTING_<KEY>` (key in capitals): `printf '%s' "$NOOKDECK_SETTING_TEXT" | pbcopy` on macOS/Linux, `$env:NOOKDECK_SETTING_TEXT` in PowerShell. Always put the variable in double quotes in sh.

### Sources

- `http`: GET a URL, then `map` the JSON with dot paths (`$.a.b`). The host must be in `permissions.network`.
- `command`: run a command (needs `shell`). The output is read as JSON or plain text.

### Renderers

The phone draws your data with a built-in renderer. No plugin code runs on the phone.

| `render` | `data` |
|---|---|
| `stat` | `{ value, unit?, label?, delta?, color?, points? }`, `points` up to 60 numbers (the `spark` style draws them) |
| `gauge` | `{ value 0-100, label?, color? }` |
| `text` | `{ title?, body }` |
| `list` | `{ items: [{ title, subtitle?, value?, icon? }] }`, up to 20 items |
| `chart` | `{ points: number[], label?, unit? }`, up to 120 points |
| `image` | `{ url (https or data:), fit? }` |
| `status` | `{ state: ok / warn / error / off, label, title?, value?, unit?, detail?, points? }`: `title` up to 40 characters, `value` up to 12, `unit` up to 8, `detail` up to 60, `points` up to 60 numbers |

If the data does not fit the renderer, the tile shows a neutral error instead of breaking.

### Styles

Each renderer can be drawn in more than one way. The person who adds your tile picks one in the tile's **Style** list. The first style of each renderer is its default.

| `render` | Styles |
|---|---|
| `stat` | `plain`, `spark` (a sparkline, only when `data.points` exist), `big` |
| `gauge` | `arc`, `ring`, `half`, `bar` |
| `text` | `plain`, `minimal` |
| `list` | `rows`, `compact` |
| `chart` | `line`, `area`, `bars`, `dots` |
| `image` | `cover`, `contain` |
| `status` | `card`, `pill`, `dot` |

A widget can suggest a style with `"style"` in its manifest entry, for example `{ "id": "history", "render": "chart", "style": "area", ... }`. It must be one of the renderer's styles. The tile's own choice wins, then your suggestion, then the default. The manage page marks the suggestion "Suggested". The table lives in `web/shared/plugin-styles.ts`.

## Settings

Each widget and action can declare settings. The manage page shows them as a form.

| `type` | Field |
|---|---|
| `string` | Text |
| `number` | Number |
| `boolean` | Switch |
| `select` | Choice (add `options`) |
| `secret` | Password. Stored on the computer, never sent to phones, and never shown again after saving. |
| `entity` | A Home Assistant entity id |

A plugin can also list plugin-wide fields under `settings`, and the Plugins tab shows them under **Settings**.

## Actions

An action is a button behaviour: a `macro` (the same steps as the Automation tab) or an `http` request. In a layout, a button uses `{ "type": "plugin", "plugin": "<id>", "action": "<id>", "settings": { } }`.

## Using a plugin in a layout

```json
{ "kind": "widget", "widget": "plugin", "plugin": { "id": "dev.alice.crypto", "widget": "price", "settings": { "coin": "ethereum" } } }
```

If the plugin is off or removed, its tiles show a neutral placeholder. Nothing else changes.

## Themes and layout packs

Looks of their own are **theme packs**, not plugins: see [Writing Nookdeck themes](themes.md). A plugin can still ship small `themes` and `layouts`. Each shows an **Apply** or **Add screens** button on its card in the Plugins tab. They change your draft, and you press **Save** to keep them.

## Plugins with code

Use code when a widget needs logic a `source` cannot express: several requests, parsing, state, or reacting to a button press. A code plugin sets `"main"` in `nookdeck.json` to its entry file and exports `activate(ctx)`.

```ts
import { definePlugin } from "@nookdeck/plugin";

export default definePlugin({
  activate(ctx) {
    ctx.widgets.provide("stars", async (settings) => {
      const res = await ctx.net.fetch(`https://api.github.com/repos/${settings.repo}`);
      const repo = await res.json();
      return { render: "stat", data: { value: repo.stargazers_count, label: String(settings.repo) } };
    }, { every: 300 });
    ctx.actions.handle("open", async () => { /* ... */ });
  },
});
```

### How it runs

Each code plugin runs in its own process, started by the agent, so a crash or a slow plugin cannot stop Nookdeck. The agent talks to it over JSON-RPC and draws its data with the same built-in renderers as no-code plugins: no plugin code runs on the phone. In the manage page, open the plugin's page to see whether it is running, stopped or crashed, read its last 50 log lines, and restart or stop it.

### The context (`ctx`)

| Member | Needs | What it does |
|---|---|---|
| `ctx.id` | | The plugin id |
| `ctx.log(...)` | | Writes to the plugin's log (shown in manage) |
| `ctx.settings.get()` | | The plugin-wide settings the user saved. `ctx.settings.onChange(fn)` runs after they change |
| `ctx.storage.get/set` | `storage` | The plugin's own saved data |
| `ctx.net.fetch(url, init?)` | `network` hosts | `fetch`, limited to the hosts you list |
| `ctx.shell?.run(cmd)` | `shell` | Run a command, get `{ code, stdout }`. Present only when granted |
| `ctx.keys?.hotkey / type` | `keyboard` | Press keys and type text. Present only when granted |
| `ctx.widgets.provide(id, fn, { every })` | | Supply a widget's data now and every `every` seconds |
| `ctx.widgets.push(id, update)` | | Push new data when something changes |
| `ctx.actions.handle(id, fn)` | | Handle a button press |

`ctx.shell` and `ctx.keys` exist only when the user granted that permission. A call that is not allowed (a host you did not list, storage without `storage`) rejects with a `PluginPermissionError`. A widget provider or an action handler receives the plugin-wide settings overlaid with the tile's own settings. The exact types are in `src/plugins/api.ts`, re-exported by `@nookdeck/plugin` (`PluginContext`, `PluginModule`, `WidgetUpdate`).

### No dependencies

A plugin is one self-contained package. It has no `node_modules` and the agent never installs packages for it. It may import only `@nookdeck/plugin` (the agent's own copy, so it always matches), Node built-ins and its own files. If you use a library, bundle it into one file and point `main` at that file:

```bash
bun build src/index.ts --outfile index.js --target bun --external @nookdeck/plugin
```

An import of any other package stops the plugin with a message that says so. Theme packs follow the same rule: no code and no remote files, only what is in the folder.

### Limits

| What | Limit |
|---|---|
| `net.fetch` | 5 MB response, 15 s, 5 redirects, only your listed hosts (checked on every redirect) |
| `shell.run` | 30 s |
| `storage` | 1 MB in total |
| Widget refresh | `every` defaults to 60 s, minimum 5 s |
| After a crash | restarts after 0.5, 2, 10, then 60 s; marked failed after 8 crashes in a row |
| Idle | a plugin with no calls for 5 minutes is stopped and starts again on the next call |

### Permissions and trust

Plugins that ask for `shell` or `keyboard` run code that can control the computer, so the manage page marks them **Runs trusted code** and the install dialog says so. Ask for the least you need, and list each host exactly. Secrets go in settings of type `secret`, which stay on the computer.

### Dev loop

1. `nookdeck plugin new my-plugin` creates a folder from the template.
2. `nookdeck plugin dev my-plugin` links the folder and reloads on every save.
3. Read the log lines in the plugin's page in manage.
4. `nookdeck plugin pack` makes a zip and its sha256 for release.

### Publishing

Put the plugin in a GitHub repo and tell people the address; it installs directly. To be listed in the Store, open a PR to [howznguyen/nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins) (see below). The three tiers (Community, Verified, Core) are described in [CONTRIBUTING.md](../CONTRIBUTING.md#plugins).

### Samples

- [`github-stars`](https://github.com/howznguyen/nookdeck-plugins/tree/main/plugins/github-stars): code, `net.fetch` to api.github.com, a stat and a chart.
- [`uptime-ping`](https://github.com/howznguyen/nookdeck-plugins/tree/main/plugins/uptime-ping): code, checks a URL, `status` renderer.
- [`clipboard-snippets`](https://github.com/howznguyen/nookdeck-plugins/tree/main/plugins/clipboard-snippets): no code, actions with the `shell` permission.

## Share it

Put the folder in a GitHub repo. Others install it from the link. Say what it needs access to in the README, since that is the first thing people ask.

To be listed in the Store, open a PR to [howznguyen/nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins) that adds your entry to `plugins.json`. The registry comes with the Store; until then, sharing your GitHub URL is enough, because it installs directly.
