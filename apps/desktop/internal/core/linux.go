package core

import (
	"path"
	"strconv"
	"strings"
)

// The Linux parts of the tray app that are plain decisions (spec linux-support L6, L8, L9), tested on any OS.

// Watcher is the D-Bus name of the StatusNotifierWatcher: without an owner there is no tray to show an icon in (GNOME without the
// AppIndicator extension, for example).
const Watcher = "org.kde.StatusNotifierWatcher"

// AppBrowsers are the Chromium-family programs that can show a page as its own small window (--app), in the order they are tried.
var AppBrowsers = []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave-browser", "brave", "microsoft-edge", "microsoft-edge-stable"}

// AppWindowArgs are the arguments for `browser --app=url`. A separate profile keeps the window out of the person's browser
// session; a snap browser can only write under ~/snap/<name>, so its profile goes there.
func AppWindowArgs(browser, url string, w, h int, home, cache string) []string {
	profile := path.Join(cache, "nookdeck", "app-window")
	if strings.HasPrefix(browser, "/snap/bin/") {
		profile = path.Join(home, "snap", path.Base(browser), "common", "nookdeck-app-window")
	}
	return []string{"--app=" + url, "--window-size=" + strconv.Itoa(w) + "," + strconv.Itoa(h), "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check"}
}

// DesktopArg quotes one argument of a .desktop Exec line (the same rule as src/service.ts desktopArg).
func DesktopArg(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", `$`, `\$`)
	q := r.Replace(s)
	q = strings.ReplaceAll(q, `\`, `\\`)
	q = strings.ReplaceAll(q, "%", "%%")
	return `"` + q + `"`
}

// TrayAutostartEntry is ~/.config/autostart/nookdeck-tray.desktop: start the tray app at login.
func TrayAutostartEntry(exe string) string {
	return "[Desktop Entry]\nType=Application\nName=Nookdeck\nComment=Nookdeck in the tray\nExec=" + DesktopArg(exe) +
		"\nIcon=dev.nookdeck.app\nTerminal=false\nX-GNOME-Autostart-enabled=true\nX-GNOME-Autostart-Delay=3\n"
}

// PackageKind is how the tray app was installed: "deb", "rpm", or "" (a tarball or a build: no package to update).
type PackageKind string

// PackageAsset is the release file that updates a package install, for a Go architecture (amd64, arm64).
func PackageAsset(kind PackageKind, version, goarch string) (string, bool) {
	v := strings.TrimPrefix(version, "v")
	switch kind {
	case "deb":
		if goarch == "amd64" || goarch == "arm64" {
			return "nookdeck_" + v + "_" + goarch + ".deb", true
		}
	case "rpm":
		arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[goarch]
		if arch != "" {
			return "nookdeck-" + v + "." + arch + ".rpm", true
		}
	}
	return "", false
}

// InstallCommand installs a downloaded package with the desktop's password prompt (polkit). The path must be absolute so apt reads
// it as a file, not a package name.
func InstallCommand(kind PackageKind, file string) []string {
	if kind == "rpm" {
		return []string{"pkexec", "dnf", "install", "-y", file}
	}
	return []string{"pkexec", "apt", "install", "-y", file}
}

// ReleasePage is the page of a release, for when the update cannot be installed from here.
func ReleasePage(version string) string {
	return "https://github.com/" + Repo + "/releases/tag/v" + strings.TrimPrefix(version, "v")
}

// Terminals are the terminal programs tried to show `nookdeck doctor`, each with the arguments that run a command in it.
var Terminals = [][]string{
	{"x-terminal-emulator", "-e"}, {"gnome-terminal", "--"}, {"kgx", "--"}, {"konsole", "-e"}, {"xfce4-terminal", "-x"}, {"mate-terminal", "-x"}, {"xterm", "-e"},
}

// TerminalScript keeps the window open after the command, so its output can be read.
func TerminalScript(exe string, args ...string) []string {
	cmd := "'" + strings.ReplaceAll(exe, "'", `'\''`) + "'"
	for _, a := range args {
		cmd += " '" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return []string{"sh", "-c", cmd + "; echo; printf 'Press Enter to close. '; read x"}
}

// BundledAgentCandidates are where a package or a tarball puts the agent next to the tray program: <dir>/agent/nookdeck (tarball),
// <prefix>/lib/nookdeck/nookdeck for <prefix>/bin/nookdeck-tray, and /usr/lib/nookdeck/nookdeck (the .deb and .rpm).
func BundledAgentCandidates(trayExe string) []string {
	dir := path.Dir(trayExe)
	out := []string{path.Join(dir, "agent", "nookdeck"), path.Join(path.Dir(dir), "lib", "nookdeck", "nookdeck")}
	if out[1] != "/usr/lib/nookdeck/nookdeck" {
		out = append(out, "/usr/lib/nookdeck/nookdeck")
	}
	return out
}
