## What and why

<!-- One concern per PR. Link the issue if there is one. -->

## How I tested it

<!-- `bun test`, and what you tried by hand. -->

## Checklist

- [ ] `bun test` passes and I added tests for behaviour changes
- [ ] Deck changes are Safari 12 safe: no `?.` or `??` in `web/deck`
- [ ] Every new user-facing string is in English, Vietnamese and Chinese
- [ ] Tests use temp directories and env overrides, never the real HOME, `~/.claude`, `~/.codex` or LaunchAgents
- [ ] No secret (Home Assistant token, key) reaches phones or logs
- [ ] No new runtime dependency, or the reason is written above
- [ ] The agent stays light (memory, idle CPU)
- [ ] UI changes have screenshots with demo data only, no personal data
- [ ] Commits are conventional (`feat:`, `fix:`, `docs:` ...)
