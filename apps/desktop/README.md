# Nookdeck tray app (Windows and Linux)

A small Go program (systray, no cgo) that controls the Nookdeck agent. One module: `internal/core` is shared, `cmd/nookdeck-tray/tray.go`
is the shared menu, `main_windows.go`/`sys_windows.go` and `main_linux.go`/`sys_linux.go` are behind build tags.
Specs: Knowns docs `specs/desktop-apps` (A1 to A7, Windows) and `specs/linux-support` (L6, L8, L9, Linux).

## Windows

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
sh apps/desktop/build.sh                  # tests, then dist/Nookdeck.exe (cross-compiles from macOS or Linux; no cgo)
bun run build:win                         # the agent: dist/nookdeck-windows-x64.exe
sh apps/desktop/build.sh                  # run again: also writes dist/Nookdeck-portable.zip (Nookdeck.exe + agent\)
```

The installer needs Inno Setup 6 on Windows (`winget install JRSoftware.InnoSetup`):

```powershell
iscc /DAppVersion=0.4.0 /DDistDir=apps\windows\dist /DAgentExe=dist\nookdeck-windows-x64.exe /DSharedDir=apps\shared apps\windows\installer\nookdeck.iss
# -> apps\windows\dist\Nookdeck-Setup.exe
```

`Nookdeck-Setup.exe` is per user (no admin): `%LOCALAPPDATA%\Programs\Nookdeck`. The uninstaller removes the app, the agent, the sign-in task, our
Claude/Codex hooks and the firewall rule (one UAC prompt); `~/.nookdeck` stays unless the box is ticked. Silent: `Nookdeck-Setup.exe /SILENT`, `/VERYSILENT`.
CI (`release.yml`, jobs `windows-app` / `mac-app` / `publish`) builds both and attaches them to the release.

## Linux

Same menu and agent handling, over StatusNotifierItem (D-Bus, `fyne.io/systray`), so it needs a desktop with a tray: KDE, Cinnamon, XFCE,
MATE, Budgie, or GNOME with the AppIndicator extension.

- The agent is `~/.nookdeck/bin/nookdeck`, run by the systemd user unit `~/.config/systemd/user/nookdeck.service`, or without systemd by
  `~/.config/autostart/nookdeck.desktop` + `~/.nookdeck/autostart.sh` (both written by `nookdeck service install`, `src/service.ts`). On start
  the app copies the packaged agent (`/usr/lib/nookdeck/nookdeck`, or `agent/nookdeck` next to the tray in the tarball) there, the same way as on
  Windows: adopt a `setup.sh` install, never downgrade, keep the port.
- One copy per session: the D-Bus name `dev.nookdeck.Tray`; a second launch (the app menu) asks the first to show itself and exits.
  Without a session bus a lock file in `$XDG_RUNTIME_DIR` does the same.
- No tray (no owner of `org.kde.StatusNotifierWatcher`): a window opens with how to turn the tray on (`sudo apt install
  gnome-shell-extension-appindicator`, Extensions, log out and in) and the Pair a phone / Open manage page buttons. It is served like the
  pairing page (`127.0.0.1:<random>/<token>/tray`). The app keeps checking; the icon appears as soon as a tray does.
- Windows open in a Chromium, Chrome, Brave or Edge `--app` window, else the default browser. "Open at login" is
  `~/.config/autostart/nookdeck-tray.desktop`, turned on the first time the app runs.
- Tray icon: `NOOKDECK_TRAY_THEME=light|dark` picks the glyph; otherwise KDE's `kdeglobals` color scheme, else the white glyph (GNOME's bar is dark).
- "Update now": a `.deb` or `.rpm` install (`dpkg -S` / `rpm -qf` on the program) downloads `nookdeck_<v>_<arch>.deb` or
  `nookdeck-<v>.<arch>.rpm`, checks it against `SHA256SUMS`, installs it with `pkexec apt|dnf install -y` and starts again. A tarball, a build,
  or no `pkexec`: the release page opens.
- Icons: `apps/shared/icons/linux` (`app-<N>.png`, `app.svg` for hicolor `dev.nookdeck.app`; `tray-{light,dark}-{state}-<N>.png`).

```sh
sh apps/desktop/build.sh linux amd64      # tests, then dist/linux-amd64/nookdeck-tray (static, no cgo; arm64 too)
```

The `.deb`, `.rpm` and tarball are made by `scripts/package-linux.sh` (CI job `linux-packages`).
