# Nookdeck for Windows (tray app)

A small Go program (systray, no cgo) that controls the Nookdeck agent. Spec: Knowns doc `specs/desktop-apps` (A1 to A7).

- The agent keeps running as the per-user scheduled task; quitting the tray app never stops the phone panel.
- On start the app installs, updates or adopts the agent (`internal/core/setup.go`): the bundled `agent\nookdeck.exe` goes to
  `%LOCALAPPDATA%\Nookdeck\bin` (where `setup.ps1` puts it), then `nookdeck migrate` and `nookdeck service install|restart`.
  An existing CLI install on the same path is adopted; a service that runs another program is left alone; it never downgrades.
- It talks to the agent only over `127.0.0.1` with the `x-nookdeck` header: `/api/devices`, `/api/pairing`, `/api/doctor`, `/api/update`.
- "Pair a phone" serves a small page from the app itself on `127.0.0.1:<random>/<token>/` and opens it in an Edge/Chrome app window (QR, PIN, address picker).
- Start / Stop / Restart run `nookdeck service start|stop|restart`.
- Updates: the menu shows a new version from `/api/update`; "Update now" downloads `Nookdeck-Setup.exe` of that release, checks it against the release's
  `SHA256SUMS`, and runs it silently (it closes the app, replaces it, runs `Nookdeck.exe --setup`, starts it again).
- Strings: `apps/shared/strings.json` (en, vi, zh), icons: `apps/shared/icons/windows`. `build.sh` copies them next to the code for `go:embed`.

## Build

```sh
sh apps/windows/build.sh                  # tests, then dist/Nookdeck.exe (cross-compiles from macOS or Linux; no cgo)
bun run build:win                         # the agent: dist/nookdeck-windows-x64.exe
sh apps/windows/build.sh                  # run again: also writes dist/Nookdeck-portable.zip (Nookdeck.exe + agent\)
```

The installer needs Inno Setup 6 on Windows (`winget install JRSoftware.InnoSetup`):

```powershell
iscc /DAppVersion=0.4.0 /DDistDir=apps\windows\dist /DAgentExe=dist\nookdeck-windows-x64.exe /DSharedDir=apps\shared apps\windows\installer\nookdeck.iss
# -> apps\windows\dist\Nookdeck-Setup.exe
```

`Nookdeck-Setup.exe` is per user (no admin): `%LOCALAPPDATA%\Programs\Nookdeck`. The uninstaller removes the app, the agent, the sign-in task, our
Claude/Codex hooks and the firewall rule (one UAC prompt); `~/.nookdeck` stays unless the box is ticked. Silent: `Nookdeck-Setup.exe /SILENT`, `/VERYSILENT`.
CI (`release.yml`, jobs `windows-app` / `mac-app` / `publish`) builds both and attaches them to the release.
