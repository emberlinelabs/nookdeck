//go:build linux

// Nookdeck for Linux: the tray app (tray.go) over StatusNotifierItem (fyne.io/systray, D-Bus, no cgo), plus what only Linux has:
// one instance per session through a D-Bus name, the "turn the tray on" window when the desktop has no tray (spec linux-support
// L9, AC-12), and updates through the .deb or .rpm with pkexec (L8).
package main

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"fyne.io/systray"
	"github.com/godbus/dbus/v5"
	"github.com/howznguyen/nookdeck/apps/desktop/internal/core"
)

const (
	busName  = "dev.nookdeck.Tray"
	busPath  = dbus.ObjectPath("/dev/nookdeck/Tray")
	busIface = "dev.nookdeck.Tray"
)

var (
	bus       *dbus.Conn
	trayOn    atomic.Bool
	restartTo string // set by updateNow: the program to run again once the tray has quit
)

// activator is the object a second launch calls (opening Nookdeck from the app menu while it runs).
type activator struct{}

func (activator) Activate() *dbus.Error { go show(); return nil }

func main() {
	openLog()
	lang = uiLanguage()
	for _, a := range os.Args[1:] {
		if a == "--setup" { // install or adopt the agent, no tray (the package's first-run helper, a terminal)
			os.Exit(setupOnce(false))
		}
	}
	if !singleInstance() {
		return
	}
	logf("Nookdeck tray %s starting (%s)", version, os.Getenv("XDG_CURRENT_DESKTOP"))
	firstRun()
	systray.Run(onReady, func() { logf("exit") })
	if restartTo != "" {
		logf("starting %s after the update", restartTo)
		syscall.Exec(restartTo, []string{restartTo}, os.Environ())
	}
}

// singleInstance owns dev.nookdeck.Tray on the session bus; when another copy owns it, that copy is asked to show itself and this
// one ends. Without a session bus a lock file in the runtime dir does the same, minus the "show".
func singleInstance() bool {
	conn, err := dbus.SessionBus()
	if err != nil {
		logf("no session bus (%v): using a lock file", err)
		return lockFile()
	}
	bus = conn
	reply, err := conn.RequestName(busName, dbus.NameFlagDoNotQueue)
	if err != nil {
		logf("RequestName: %v", err)
		return lockFile()
	}
	if reply != dbus.RequestNameReplyPrimaryOwner {
		logf("already running: asking it to show itself")
		conn.Object(busName, busPath).Call(busIface+".Activate", 0)
		return false
	}
	if err := conn.Export(activator{}, busPath, busIface); err != nil {
		logf("export: %v", err)
	}
	return true
}

func lockFile() bool {
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = os.TempDir()
	}
	f, err := os.OpenFile(filepath.Join(dir, "nookdeck-tray.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return true
	}
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) == nil // f stays open (and locked) for the life of the process
}

// firstRun turns "Open at login" on the first time the app runs for this user (the package cannot write per-user autostart).
func firstRun() {
	marker := filepath.Join(paths().DataDir(), "tray-first-run")
	if fileExists(marker) {
		return
	}
	if err := setLoginItem(true); err != nil {
		logf("open at login: %v", err)
	}
	os.MkdirAll(filepath.Dir(marker), 0o755)
	os.WriteFile(marker, []byte(version+"\n"), 0o644)
}

// watcherPresent: a StatusNotifierWatcher owns its name, so a tray can show our icon.
func watcherPresent() bool {
	if bus == nil {
		return false
	}
	var has bool
	if err := bus.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, core.Watcher).Store(&has); err != nil {
		return false
	}
	return has
}

// platformReady checks for a tray once the agent is set up. Without one it opens the "turn the tray on" window, then keeps
// looking every 10 s: when a watcher appears, systray registers the icon by itself (it follows NameOwnerChanged) and the window
// says so.
func platformReady() {
	go func() {
		select {
		case <-agentReady:
		case <-time.After(90 * time.Second):
		}
		on := watcherPresent()
		trayOn.Store(on)
		logf("tray watcher present: %v", on)
		if !on {
			showTrayHelp()
		}
		for range time.Tick(10 * time.Second) {
			now := watcherPresent()
			if now != trayOn.Swap(now) {
				logf("tray watcher present: %v", now)
			}
		}
	}()
}

// show is what opening Nookdeck again does: the tray help window when there is no tray, else the manage page.
func show() {
	if !trayOn.Load() {
		showTrayHelp()
		return
	}
	openURL(manageURL())
}

func showTrayHelp() {
	p, err := pairServer()
	if err != nil {
		notice(t("error.generic", "error", err.Error()))
		return
	}
	openAppWindow(p.TrayURL(), 520, 620)
}

func configurePair(p *core.PairServer) {
	p.TrayOn = trayOn.Load
	p.TrayCommand = "sudo apt install gnome-shell-extension-appindicator"
	if _, err := exec.LookPath("apt"); err != nil {
		if _, err := exec.LookPath("dnf"); err == nil {
			p.TrayCommand = "sudo dnf install gnome-shell-extension-appindicator"
		}
	}
}

// packageKind asks dpkg, then rpm, which package owns the running program.
func packageKind(ctx context.Context) core.PackageKind {
	exe := trayExe()
	if _, err := exec.LookPath("dpkg"); err == nil {
		if _, code := run(ctx, "dpkg", "-S", exe); code == 0 {
			return "deb"
		}
	}
	if _, err := exec.LookPath("rpm"); err == nil {
		if _, code := run(ctx, "rpm", "-qf", exe); code == 0 {
			return "rpm"
		}
	}
	return ""
}

// updateNow downloads the release's .deb or .rpm for this machine (checked against SHA256SUMS) and installs it with pkexec
// (the desktop's password prompt), then starts the new tray app, which updates the agent. A tarball or a build, or no pkexec:
// the release page opens instead.
func updateNow() {
	state.mu.Lock()
	u := state.update
	state.mu.Unlock()
	if u.Latest == nil {
		return
	}
	latest := *u.Latest
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	manual := func(why string) {
		logf("update %s by hand: %s", latest, why)
		openURL(core.ReleasePage(latest))
		notice(t("update.manual", "version", latest))
	}
	kind := packageKind(ctx)
	name, ok := core.PackageAsset(kind, latest, runtime.GOARCH)
	if !ok {
		manual("not installed from a package")
		return
	}
	if _, err := exec.LookPath("pkexec"); err != nil {
		manual("no pkexec")
		return
	}
	setBusy("update.downloading")
	defer setBusy("")
	dir, err := os.MkdirTemp("", "nookdeck-update-")
	if err != nil {
		notice(t("error.updateFailed", "error", err.Error()))
		return
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, name)
	if err := core.DownloadAsset(ctx, &http.Client{Timeout: 10 * time.Minute}, latest, name, file); err != nil {
		notice(t("error.updateFailed", "error", err.Error()))
		return
	}
	// apt runs as root from a polkit prompt: the file must be readable by the "_apt" user, so the folder is opened up
	os.Chmod(dir, 0o755)
	os.Chmod(file, 0o644)
	setBusy("update.installing")
	argv := core.InstallCommand(kind, file)
	logf("running %v", argv)
	if out, code := run(ctx, argv[0], argv[1:]...); code != 0 {
		logf("install failed (%d): %s", code, out)
		if code == 126 || code == 127 { // the prompt was dismissed, or pkexec could not run
			return
		}
		notice(t("error.updateFailed", "error", lastLine(out)))
		return
	}
	restartTo = trayExe()
	systray.Quit()
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	return s[strings.LastIndexByte(s, '\n')+1:]
}

// selfUpdate: only a .deb or .rpm install with pkexec can replace itself; a tarball or a build gets the download page.
func selfUpdate() (bool, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, pk := exec.LookPath("pkexec")
	if packageKind(ctx) == "" || pk != nil {
		return false, filepath.Dir(trayExe())
	}
	return true, ""
}
