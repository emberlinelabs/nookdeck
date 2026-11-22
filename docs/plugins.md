# Writing PhoneDesk plugins

A plugin adds tiles and buttons to PhoneDesk. It is a folder (usually a GitHub repo) with a `phonedesk.json` file. This guide covers the first phase: **no-code plugins**, which need no JavaScript. Code plugins come in a later release.

## Quick start

1. Copy [`examples/plugins/crypto-price`](../examples/plugins/crypto-price).
2. Change `id`, `name` and the widget.
3. In the manage page open **Plugins**, paste the folder path (or a GitHub address, or an https link to the `phonedesk.json`), read the access list and press **Allow and turn on**.
4. Add your tile to a screen.

## The manifest

```json
{
  "id": "dev.alice.crypto",
  "name": "Crypto price",
  "version": "1.0.0",
  "phonedesk": ">=0.2.0",
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
| `id` | Reverse-DNS style, `dev.<author>.<name>`. `core.*` is reserved for PhoneDesk. |
| `version` | Exact version. Each install is pinned to a version and a hash of the package. |
| `phonedesk` | The PhoneDesk versions the plugin works with. |
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

### Sources

- `http`: GET a URL, then `map` the JSON with dot paths (`$.a.b`). The host must be in `permissions.network`.
- `command`: run a command (needs `shell`). The output is read as JSON or plain text.

### Renderers

The phone draws your data with a built-in renderer. No plugin code runs on the phone.

| `render` | `data` |
|---|---|
| `stat` | `{ value, unit?, label?, delta?, color? }` |
| `gauge` | `{ value 0-100, label?, color? }` |
| `text` | `{ title?, body }` |
| `list` | `{ items: [{ title, subtitle?, value?, icon? }] }`, up to 20 items |
| `chart` | `{ points: number[], label?, unit? }`, up to 120 points |
| `image` | `{ url (https or data:), fit? }` |
| `status` | `{ state: ok / warn / error / off, label }` |

If the data does not fit the renderer, the tile shows a neutral error instead of breaking.

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

A plugin can also ship `themes` and `layouts`. Each shows an **Apply** or **Add screens** button on its card in the Plugins tab. They change your draft, and you press **Save** to keep them.

## Share it

Put the folder in a GitHub repo. Others install it from the link. Say what it needs access to in the README, since that is the first thing people ask.
