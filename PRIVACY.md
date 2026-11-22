# Privacy

PhoneDesk is a small agent that runs on your computer and serves a web page to phones on your own network.
It has **no account, no cloud service, no analytics, no telemetry and no update check**. Nothing is sent to the
PhoneDesk authors. This page lists every connection the agent makes or accepts, and what it reads locally, so you can
verify it (the code is in `src/`).

## Outbound connections (the agent calls out)

| To | When | What is sent | Notes |
|---|---|---|---|
| `https://api.anthropic.com/api/oauth/usage` | Only if you use the Claude quota tiles and Claude Code is signed in on this computer. At most every 5 minutes. | Claude Code's own access token as a Bearer header, to read your plan usage. | Read-only. PhoneDesk never signs in, never refreshes or writes the token, and skips expired tokens. After a 401/403 it leaves that token alone for 30 minutes. Only a 16-character SHA-256 fingerprint of the token is kept in memory (to remember the pause), and the last usage numbers are cached without the token. |
| `https://api.open-meteo.com`, `https://geocoding-api.open-meteo.com` | Only if a weather tile uses Open-Meteo (not when it uses your Home Assistant weather entity). Refreshed at most every 15 minutes. | The latitude/longitude of the location you chose, or the place name you type in the location search. | No API key, no account. |
| `https://github.com/howznguyen/phonedesk/releases/latest` (and `https://api.github.com/repos/howznguyen/phonedesk/releases/latest` as a fallback) | Two cases. (1) You run `phonedesk update` or `phonedesk update --check`. (2) The management page asks whether a newer version exists: at most once a day, and never when you turn it off (Theme setting `updateCheck: false`). Nothing runs in the background without a page open. | A plain GET with the User-Agent `phonedesk-update`. No version, no identifier, no account. | Only the latest version number is read. `phonedesk update` then downloads the release file for your computer from `github.com/howznguyen/phonedesk/releases/download/...` and checks it against the release's `SHA256SUMS` before replacing anything. |
| `grok agent stdio` (a local program, then xAI) | Only if the Grok CLI is installed. At most every 5 minutes, hard timeout 15 seconds, and the process is always stopped afterwards. | PhoneDesk starts `grok agent stdio` and asks it for your plan and weekly credits (the internal, undocumented JSON-RPC method `_x.ai/billing`). The Grok CLI then talks to xAI with its own login, as it normally does. | PhoneDesk never reads `~/.grok/auth.json` or any token, and never touches grok.com cookies. It keeps only the plan name, a percentage, a reset time and the prepaid balance. If xAI changes or removes the method, the quota just shows as unavailable. |
| Your Home Assistant (the URL you enter) | Only if you configure the Home Assistant integration. | A WebSocket connection with your long-lived access token, to read entity states and call services you press. | Goes only to the address you entered. The URL is stored in `~/.phonedesk/hass.json`; the token is stored in the macOS Keychain (item `PhoneDesk-HASS`), or in the same file with owner-only permissions when no Keychain is available. Neither is ever sent to phones. |
| Artwork URL of the track playing | Only while Now Playing is shown and the player (for example Spotify) reports an artwork URL. | A plain GET for the image. | The URL comes from your music player. The image is cached in memory and sent to your phones. |

Local helper programs are also run on your computer: `sips`, `netstat`, `ioreg`, `afplay`, `scutil`,
`security` (see below), `plutil` and, if you have them, `grok` (see the table above), `agy` (Antigravity CLI) or `playerctl`. They do not
talk to PhoneDesk servers; `agy` talks to its own service as it normally does.

## Inbound connections (the agent listens)

- The agent listens on port 7420 (change with `--port`) on your local network. A phone must pair first with a 6-digit
  PIN printed in the terminal; only a hash of each device token is stored. The management page (`/manage/`), the layout
  API and all settings answer only to the computer itself (localhost), and reject cross-site and DNS-rebinding requests.
- **Webhooks** (`/api/push/<key>`, `/api/notify`, `/api/goto/<page>`) accept requests from other programs on your network
  that present the webhook Bearer key. The key is generated on first use and stored under `~/.phonedesk` with
  owner-only permissions.
- **Claude Code and Codex hooks** (opt-in, installed from the management page) call the agent on `127.0.0.1` with a
  local secret. They can show permission prompts and Claude's questions on the phone.

## What is read on your computer

- **Claude Code credentials**: `~/.claude/.credentials.json`, or on macOS the Keychain item `Claude Code-credentials`
  (via `security find-generic-password`; macOS may ask you to allow it). Only the access token and the plan name are used,
  only for the usage request above. Nothing is written back.
- **Codex quota and sessions**: the newest rollout files under `~/.codex/sessions` (only the usage record and session
  metadata, not your prompts). **Claude Code sessions**: metadata in `~/.claude/projects` (project folder, model,
  last modified time; no prompt or response text is sent anywhere).
- **Installed apps and icons** (to build the app picker), **CPU, memory, network and process lists** (for the stat tiles),
  **keyboard idle time** (`ioreg`, only if you turn on "only ask me on the phone when I am away").
- **Media**: what is playing. On macOS PhoneDesk reads what any app is playing (Safari, Chrome, YouTube, Spotify, Music...) through the bundled, BSD-licensed [mediaremote-adapter](THIRD_PARTY_NOTICES.md), run by Apple's own `/usr/bin/perl` only while a phone is connected; if that is unavailable it asks Spotify and Music in its own process (Apple Events, only for a player that is already running). Elsewhere `playerctl` or the Windows media session. Keys, typing, volume and media keys on macOS are native system calls (no helper programs).

## What is stored

Everything is under `~/.phonedesk` (or `$PHONEDESK_HOME`): your layout and its undo history, paired devices (token
hashes), the hook and webhook secrets, uploaded icons and sounds, the Home Assistant URL (and the token when there is no Keychain), quota history (percentages
only), and the last-played track. Delete the folder to remove it. Hook entries added to `~/.claude/settings.json`
or `~/.codex/hooks.json` are removed with the "Remove" buttons on the integrations page.

## What phones receive

Phones on your network receive the layout, system stats, now playing, quota percentages, session names, weather,
Home Assistant entity states for the tiles you placed, and pending prompts. They never receive your Home Assistant
URL or token, your webhook key, or the Claude token.

## Questions

Open an issue in the repository. If you find a connection that is not listed here, please report it as a bug.
