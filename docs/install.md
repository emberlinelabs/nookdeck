# Install Nookdeck

Two ways, same result. Pick the **app** if you do not use a terminal. Pick the **one-line install** if you do, or on a computer with no screen.

You need a Mac (macOS 13 or later) or a Windows 10/11 PC, and a phone or tablet on the same Wi-Fi. Nothing is installed on the phone.

## Install the app

The app is a small controller that sits in the menu bar (Mac) or the system tray (Windows). Nookdeck itself keeps running in the background when you quit the app.

### On a Mac

1. Download [Nookdeck.dmg](https://github.com/howznguyen/nookdeck/releases/latest/download/Nookdeck.dmg).
2. Open the dmg and drag **Nookdeck** into **Applications**.
3. Open **Nookdeck** from Applications. A small icon appears in the menu bar. The first time, the app sets Nookdeck up and starts it. The menu shows **Nookdeck is running** when it is ready.

#### "Apple cannot check it for malicious software" (one time)

Nookdeck is not signed with an Apple Developer ID yet, so macOS asks you to confirm the first time you open it. You only do this once:

1. Try to open Nookdeck. macOS shows a message and does not open it. Close the message.
2. Open **System Settings → Privacy & Security** and scroll down to the message about Nookdeck.
3. Click **Open Anyway**, enter your password or use Touch ID, then click **Open Anyway** again.

On macOS 13 and 14 you can instead right-click (or Control-click) **Nookdeck** in Applications, choose **Open**, then **Open**.

### On Windows

1. Download [Nookdeck-Setup.exe](https://github.com/howznguyen/nookdeck/releases/latest/download/Nookdeck-Setup.exe).
2. Run it. It installs for your user only and does not need an administrator.
3. Nookdeck starts and a tray icon appears (click the **^** arrow near the clock if it is hidden). Windows asks once to allow Nookdeck through the firewall, which lets your phone reach it: click **Allow**.

Windows SmartScreen may say "Windows protected your PC", because the installer is not code signed yet. Click **More info**, then **Run anyway**.

## Use the app

Click the icon. The menu has:

- The state of Nookdeck (running, stopped, or needs permission) and how many phones are connected.
- **Pair a phone…**: a small window with the QR code, the PIN and the address picker. Scan the QR code with the phone camera, or open the address and type the PIN.
- **Open manage page**: your screens, theme, plugins and settings in the browser.
- **Start / Stop / Restart** Nookdeck.
- **Check for updates**, and **Update now** when there is one.
- **Open at login**: whether the app itself starts when you sign in. Nookdeck itself always starts at sign-in, with or without the app.
- **Help**: check permissions, show the logs folder, the documentation and the website.
- **Quit**: closes the app only. Your phone keeps working.

The menu follows your system language (English, Tiếng Việt, 中文).

## Already installed with the one-line install?

Open the app. It finds your existing Nookdeck and uses it: same port, same layout and same paired phones. It does not install a second copy.

## Updates

The app checks the [releases](https://github.com/howznguyen/nookdeck/releases) page. When there is a new version, the menu says so; click **Update now**. The app replaces itself and updates Nookdeck. Your layout, plugins and paired phones are kept, and permissions you granted (such as Accessibility on a Mac) stay granted.

## Remove

- **Mac:** quit the app and drag it from Applications to the Trash. To remove Nookdeck itself too, run `curl -fsSL https://nookdeck.app/scripts/uninstall | bash` in Terminal. Your data is kept; add `-s -- --purge` after `bash` to delete it too.
- **Windows:** uninstall **Nookdeck** in **Settings → Apps**. To remove Nookdeck itself too, run `irm https://nookdeck.app/scripts/uninstall.ps1 | iex` in PowerShell.

## The one-line install (alternative)

No app, no window: Nookdeck runs in the background, started at sign-in.

**Mac**: open Terminal and run:

```sh
curl -fsSL https://nookdeck.app/scripts/install | bash
```

**Windows**: open PowerShell and run:

```powershell
irm https://nookdeck.app/scripts/install.ps1 | iex
```

If `nookdeck.app` is blocked on your network, use `https://raw.githubusercontent.com/howznguyen/nookdeck/main/setup.sh` (Windows: `.../setup.ps1`) instead. At the end it prints a QR code, a phone address and a PIN. Options and details are in the README.

## Something not working?

| Problem | What to do |
|---|---|
| The menu says **Nookdeck is stopped** | Choose **Start Nookdeck**. If it stops again, choose **Help → Show logs folder** and look at the newest file. |
| The menu says **needs permission** | Choose **Help → Check permissions** and follow the steps. On a Mac this is usually Accessibility, so keys can be pressed for you. |
| The phone cannot open the address | Make sure the phone and the computer are on the same Wi-Fi. On Windows, allow Nookdeck in the firewall prompt. Pick another address in the pairing window. |
| **Open Anyway** is missing in System Settings | Try to open Nookdeck once first; the button appears after that, for about an hour. |
| `port 7420 is in use` | Another program uses that port. Quit it, or use the one-line install with `--port 7421`. |
