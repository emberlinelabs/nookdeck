# Uptime ping

A code plugin. A `status` tile that turns green, amber or red depending on whether a web address answers and how fast.

- **Access it asks for:** network, for `nookdeck.app` only. A plugin can only call the hosts its manifest lists, so to check another site add its host to `permissions.network` in `nookdeck.json` (and bump the version); the user then approves the new access.
- **Settings:** the address and a "slow after" time (per tile).
- **Develop:** `nookdeck plugin dev examples/plugins/uptime-ping`.
