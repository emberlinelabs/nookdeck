Nookdeck for Linux (experimental)

Run ./nookdeck-tray. On its first start it copies agent/nookdeck to ~/.nookdeck/bin,
starts the agent as a per-user service and puts the Nookdeck icon in the tray.
Nothing here needs root.

For the app menu, copy the shared files once:
  cp -r share/applications share/icons ~/.local/share/
  and set Exec= in ~/.local/share/applications/dev.nookdeck.app.desktop to the full path of nookdeck-tray.

On Debian or Ubuntu the .deb is easier: sudo apt install ./nookdeck_<version>_amd64.deb
Without a tray (Debian GNOME): install gnome-shell-extension-appindicator, enable it, then log out and in.
Command line only: curl -fsSL https://raw.githubusercontent.com/howznguyen/nookdeck/main/setup.sh | bash
