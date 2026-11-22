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
`gunzip`, make it executable (`chmod +x`) and run it. The macOS binaries are signed ad hoc, not notarized: a file
downloaded in a browser needs `xattr -d com.apple.quarantine <file>` first.

Full guide: [README](https://github.com/howznguyen/nookdeck#readme) · Tiếng Việt: [README.vi](https://github.com/howznguyen/nookdeck/blob/main/README.vi.md) · 中文: [README.zh](https://github.com/howznguyen/nookdeck/blob/main/README.zh.md)
