## Nookdeck 0.3.1

Upgrading: run the install command below again, or `nookdeck update`.

- **Plugins with code install from GitHub**, from the Store or a repository link. The whole plugin folder is downloaded and checked (size limits, no links or paths outside the folder), and Store installs stay pinned to the reviewed files. GitHub stars and Uptime ping are now in the Store.
- **Wi-Fi first when pairing:** the pairing window and the installer QR use this computer's Wi-Fi or Ethernet address by default; the `.local` name and Tailscale are one pick away.
- **Install links:** `http://localhost:7420/manage#plugins?add=<plugin id>` opens a Store plugin's Add dialog (nookdeck.app/plugins uses it). Nothing installs without your OK.
- **`nookdeck install`:** puts the program in its stable place and sets up the login service, for Homebrew and other package managers.
- Fixed: `nookdeck plugin dev <folder>` and `plugin pack <folder>` used the current folder when no flag was given; the doctor no longer crashes when the home folder cannot be found.

## Nookdeck 0.3.0: plugins with code, and a plugin Store

Coming from PhoneDesk? The install command moves everything over (see the 0.2.0 notes).

### New

- **Plugin Store:** Plugins now has Discover, Installed and Updates tabs. Browse the community registry ([nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins)), see a live preview of each tile, read what a plugin may do, and press **Add**. Store installs are pinned to the reviewed version: if the files differ, nothing is installed. Grid and list views, search, and "Add tile to a screen" in one click.
- **Plugins with code:** a plugin can ship a small TypeScript or JavaScript file. It runs in its own process, so a crash or a hang never takes Nookdeck down, and it restarts with back-off. Everything it does outside (network, shell, keys, storage) goes through Nookdeck and is limited to what you approved. Build one with the `@nookdeck/plugin` types and `nookdeck plugin new`, `nookdeck plugin dev` and `nookdeck plugin pack`: see the [plugin guide](https://github.com/howznguyen/nookdeck/blob/main/docs/plugins.md).
- **Built-in plugins:** Weather and AI usage now run on the same plugin system. Your layouts keep working unchanged.
- **Safer removal:** removing a plugin lists where it is used, can take its tiles off your screens, and can be undone.
- **Sidebar:** Built-in and Community plugins fold into short groups.

### Fixed

- Shell steps in plugins receive settings as environment variables, never pasted into the command.
- Plugins can only import `@nookdeck/plugin`, built-ins and their own files; nothing is fetched from npm at run time.
- The Screens preview shows each plugin's own sample data instead of invented numbers.
- Built-in AI usage and Weather tiles placed as plugin tiles draw correctly on the phone.

### Install statistics

The app itself sends nothing. The website and the installer keep anonymous install counts (OS, version, country); opt out with `NOOKDECK_NO_ANALYTICS=1`. Details in [PRIVACY.md](https://github.com/howznguyen/nookdeck/blob/main/PRIVACY.md#install-statistics-website-and-installer).

## Install

**macOS** (Apple silicon or Intel), in Terminal, no `sudo`:

```sh
curl -fsSL https://nookdeck.app/scripts/install | bash
```

**Windows 10/11** (x64, experimental), in PowerShell:

```powershell
irm https://nookdeck.app/scripts/install.ps1 | iex
```

The installer downloads the right file below, checks it against `SHA256SUMS`, installs it for your user, starts
Nookdeck and prints the phone URL, a pairing PIN and a QR code. Open the URL on a phone on the same Wi-Fi (or scan
the QR with the Camera app), and add the page to the home screen.

- **Update:** run the same command again. Your layout, paired phones and settings are kept.
- **Uninstall:** `curl -fsSL https://nookdeck.app/scripts/uninstall | bash`
  (Windows: `irm https://nookdeck.app/scripts/uninstall.ps1 | iex`). Your data is kept;
  on macOS add `-s -- --purge` after `bash` to delete it too.
- **Manage your panel:** `http://localhost:7420/manage/` on the computer.

## Files

| File | For |
|---|---|
| `nookdeck-darwin-arm64.gz` / `nookdeck-darwin-arm64` | macOS on Apple silicon (M1 and later) |
| `nookdeck-darwin-x64.gz` / `nookdeck-darwin-x64` | macOS on Intel |
| `nookdeck-windows-x64.exe.gz` / `nookdeck-windows-x64.exe` | Windows 10/11 x64 |
| `SHA256SUMS` | Checksums of every file |

The `.gz` files are the same programs compressed (about a third of the size); the installers use them. To install by
hand: download the file for your machine, check it with `shasum -a 256 -c SHA256SUMS --ignore-missing`, unpack it with
`gunzip`, make it executable (`chmod +x`) and run it. The macOS binaries are signed with the Nookdeck release identity (self-signed, not notarized): a file downloaded in a
browser needs `xattr -d com.apple.quarantine <file>` first.

Full guide: [README](https://github.com/howznguyen/nookdeck#readme) · Tiếng Việt: [README.vi](https://github.com/howznguyen/nookdeck/blob/main/README.vi.md) · 中文: [README.zh](https://github.com/howznguyen/nookdeck/blob/main/README.zh.md)
