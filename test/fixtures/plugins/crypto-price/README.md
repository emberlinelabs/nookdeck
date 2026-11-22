# Crypto price

A no-code Nookdeck plugin: one tile that shows the live USD price of a coin. It is the smallest useful plugin and the best one to copy.

- The tile uses the built-in `stat` renderer.
- The only access it asks for is `api.coingecko.com` (network). No shell, no keyboard.
- The coin is a setting. Put the CoinGecko id (`bitcoin`, `ethereum`, `solana`) in the tile's settings.

## Try it

1. Open the manage page, go to **Plugins**, then **Discover**.
2. Find **Crypto price** and press **Add**. It comes from the [nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins) registry, pinned to the reviewed version.
3. Read the access list, then **Allow and turn on**.
4. Press **Add tile to a screen**, then pick the coin in the tile settings.

Writing your own? Copy this folder, change the `id`, and install it with **Install from a link** (a GitHub URL or a local folder) while you work on it.

See [docs/plugins.md](../../../docs/plugins.md) for the full manifest.
