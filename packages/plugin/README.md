# @nookdeck/plugin

The author SDK for [Nookdeck](https://nookdeck.app) plugins. It is not published to npm yet (the npm org is unclaimed), so the package is marked private.

- `PluginContext` and related types, re-exported from the agent's own `src/plugins/api.ts`.
- `schema/nookdeck.schema.json`: a JSON Schema for `nookdeck.json`, generated from the agent's validator constants (`bun run schema`, checked with `bun run schema:check`).
- `definePlugin()`: a typed identity helper for the entry module.
- `template/`: the files `nookdeck plugin new` copies.

See [docs/plugins.md](../../docs/plugins.md) for the guide.
