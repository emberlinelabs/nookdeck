## Nookdeck 0.2.0: PhoneDesk is now Nookdeck

PhoneDesk has a new name. The repo moved to [howznguyen/nookdeck](https://github.com/howznguyen/nookdeck) (old links redirect) and the site is [nookdeck.app](https://nookdeck.app).

**Upgrading from PhoneDesk:** run the install command below, or `phonedesk update`. Your layout, paired phones, sounds and settings move to `~/.nookdeck` on their own, the login service and hooks are switched over, and `phonedesk` keeps working as an alias. On macOS, grant Accessibility to `nookdeck` once more; from now on updates keep it.

### New

- **Plugins (no code):** install community plugins from a GitHub URL, approve what they may do, and drop their tiles and buttons on your screens. Write one with a single `nookdeck.json`: see the [plugin guide](https://github.com/howznguyen/nookdeck/blob/main/docs/plugins.md) and [nookdeck-plugins](https://github.com/howznguyen/nookdeck-plugins).
- **New manage layout:** a sidebar with foldable groups; Claude Code, Codex, Grok, Antigravity, OpenCode, Home Assistant and Weather each get their own page under Plugins; a new About page with an update check.
- **Sign in with Home Assistant:** connect with your HA login (OAuth), no long-lived token to paste. Tokens stay on the computer.
- **Pair over any network:** choose the address the phone uses: the computer name, any Wi-Fi or Ethernet subnet, Tailscale (IP or MagicDNS name) or a VPN. `nookdeck pair` lists them all.
- **Accessibility survives updates on macOS:** builds are signed with one Nookdeck identity instead of ad hoc.

### Fixed

- Windows: GPU load now matches Task Manager (video decode counts), app icons are no longer upside down, `setup.ps1` switches work, and old firewall, PATH and startup entries are cleaned up.
- Antigravity quota is found when `agy` lives in `~/.local/bin`, with clear messages when it is missing or signed out.
- Messages no longer say "this Mac" on Windows.

### Install statistics

The app itself still sends nothing. The website and the installer now keep anonymous install counts (OS, version, country); opt out with `NOOKDECK_NO_ANALYTICS=1`. Details in [PRIVACY.md](https://github.com/howznguyen/nookdeck/blob/main/PRIVACY.md#install-statistics-website-and-installer).

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
