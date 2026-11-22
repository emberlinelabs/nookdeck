# Desktop app icons

Made from the Nookdeck mark (`web/manage/public/favicon.svg`). Sources are in `src/`; `sh build.sh` regenerates every file below (needs `rsvg-convert` and `magick`, plus macOS `iconutil` for the `.icns`).

## macOS (`macos/`)

| File | Use |
|---|---|
| `nookdeckTemplate.png`, `@2x`, `.pdf` | Menu bar icon, same as the running one. 18 pt. |
| `nookdeck-runningTemplate.*` | Running: filled dot. |
| `nookdeck-stoppedTemplate.*` | Stopped: hollow dot. |
| `nookdeck-attentionTemplate.*` | Needs permission or attention: dot with an exclamation mark. |
| `AppIcon.icns`, `AppIcon-1024.png` | The app icon (Dock, Finder, dmg). |

The menu bar files are black on transparent and end in `Template`, so AppKit treats them as template images and tints them for light, dark and highlighted menu bars. In Swift: `NSImage(named: "nookdeck-runningTemplate")` or set `isTemplate = true`. Do not colour them. The status shows through the shape of the dot, not a colour, because template images are monochrome.

## Windows (`windows/`)

| File | Use |
|---|---|
| `tray-light.ico`, `tray-dark.ico` | Tray icon, running. 16, 20, 24 and 32 px. |
| `tray-{light,dark}-{running,stopped,attention}.ico` | The same for each state. |
| `app.ico` | The app: exe, installer, shortcuts. 16 to 256 px. |

`light` is for a light taskbar (dark glyph); `dark` is for a dark taskbar (white glyph). Read the taskbar theme from `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, value `SystemUsesLightTheme` (1 = light taskbar), and switch when it changes.

## Other

`app-512.png`: the app mark for the website and the installer art.
