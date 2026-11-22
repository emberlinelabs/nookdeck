# Contributing to Nookdeck

Thanks for helping. This page is short on purpose: what to do, how to run the project, and the rules a pull request has to follow.

## Ways to help

- **Report a bug.** Open an [issue](https://github.com/howznguyen/nookdeck/issues/new?template=bug_report.md) and paste the output of `nookdeck doctor`. Say which phone and browser you use.
- **Translate.** The UI is in English, Vietnamese and Chinese (English text is the key).
  - Management page: `web/manage/src/i18n/<lang>/`
  - Phone: `web/deck/src/i18n-<lang>.ts`
  - Agent messages: `src/i18n.ts`
  - To add a language, copy an existing one, register it next to the others, and open a PR. Partial translations are welcome.
- **Write a plugin.** See [Plugins](#plugins) and [docs/plugins.md](docs/plugins.md).
- **Fix code or docs.** Small PRs are the easiest to review.

## Dev setup

You need [Bun](https://bun.sh) 1.3 or newer (CI uses 1.3.12).

```sh
bun install
bun run build   # web apps and dist/nookdeck
bun test        # runs ensure-icons, ensure-web and gen-assets first, then the tests
bun run typecheck
```

### Run the agent from source without touching a real install

Always use a temporary home and a spare port, so a dev agent never reads or changes your real `~/.nookdeck`, your paired phones or your hooks:

```sh
NOOKDECK_HOME="$(mktemp -d)" NOOKDECK_PORT=7455 bun run start
```

Open `http://localhost:7455/manage/`. The real agent uses 7420.

### Web dev servers

`web/deck` (the phone page) and `web/manage` (the management page) are Vite apps. Point them at the dev agent:

```sh
cd web/manage && bun install && NOOKDECK_AGENT=http://localhost:7455 bunx --bun vite
cd web/deck   && bun install && NOOKDECK_AGENT=http://localhost:7455 bunx --bun vite
```

After changing the web apps, run `bun scripts/gen-assets.ts` (or `bun run build`) so the agent embeds the new files.

### macOS signing

A local build is signed ad hoc, which is fine for development. Accessibility permission may reset after each local rebuild. Release builds use a signing identity that only CI has. Never ask for it and never share it.

## Project layout

| Path | What it is |
|---|---|
| `src/` | The agent (Bun): server, layout, pairing, actions, doctor, update |
| `src/platform/` | The only place that reads `process.platform` (macOS, Windows, Linux) |
| `src/plugins/` | Plugin manifest, store, runtime and permissions |
| `src/hass/` | Home Assistant client and sign-in |
| `src/ai/` | Claude Code, Codex, Grok, Antigravity and OpenCode integrations |
| `web/deck/` | The phone page (Preact, must run on Safari 12) |
| `web/manage/` | The management page (React, Tailwind, Knowns UI) |
| `web/shared/` | Code both web apps use (icons, grid logic) |
| `site/` | The landing page (Astro, its own `package.json`, not part of the root build) |
| `scripts/` | Build helpers (assets, icons, signing) |
| `test/` | Tests (`bun test`) |
| `docs/` | Plugin guide, brand files, images |

## Hard rules

A pull request must keep all of these true.

1. **The deck runs on Safari 12.** No optional chaining (`?.`) and no nullish coalescing (`??`) in `web/deck`. The build targets iOS and Safari 12 and the bundle must stay free of them.
2. **Every user-facing string exists in English, Vietnamese and Chinese.**
3. **Tests never touch the real machine.** Not the real `HOME`, `~/.claude`, `~/.codex`, or LaunchAgents. Use temp directories and the env overrides (`NOOKDECK_HOME`, `NOOKDECK_CLAUDE_DIR`, `NOOKDECK_CODEX_DIR`, `NOOKDECK_LAUNCH_AGENTS_DIR`, `NOOKDECK_LAUNCHCTL`).
4. **Secrets never reach phones or logs.** Home Assistant tokens, plugin secrets and keys stay on the computer.
5. **No new runtime dependency without a reason** written in the PR.
6. **Keep the agent light.** It runs all day, so watch memory and idle CPU.

## Commits and pull requests

- Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- One concern per PR. Add tests for behaviour changes. `bun test` must pass.
- For UI changes, add screenshots made with demo data only. Never include personal data (names, addresses, device names, tokens).
- The PR template has a checklist that mirrors the hard rules above.

## Plugins

A plugin is a folder with a `nookdeck.json`. The full format is in [docs/plugins.md](docs/plugins.md), and `examples/plugins/` has a working one. There are three tiers:

1. **Community.** The plugin lives in your own repo and you maintain it. To list it, open a PR to [howznguyen/nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins) that adds your entry to `plugins.json` (this comes with the Store). Until then, share your GitHub URL: people can install from it directly.
2. **Verified.** A reviewed community plugin with real users and minimal permissions gets a badge and a place under Featured. It is still not bundled.
3. **Core.** A PR to this repo under `plugins/core/`. It is accepted only when it is:
   - useful to most users;
   - free of any required paid service or private API key;
   - tested and translated into en, vi and zh;
   - Safari 12 safe, with no heavy dependencies.

   After the merge, the project maintains it.

## Security

Do not report vulnerabilities in public issues. Use GitHub's private reporting: on the repo, open **Security**, then **Report a vulnerability** ([Security Advisories](https://github.com/howznguyen/nookdeck/security/advisories/new)).

## License and credit

Contributions are under the [MIT License](LICENSE). Contributors are shown in the README (see [Contributors](README.md#contributors)).
