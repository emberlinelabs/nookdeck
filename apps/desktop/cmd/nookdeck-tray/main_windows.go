//go:build windows

// Nookdeck for Windows: the tray app (tray.go) plus what only Windows has: the installer's --setup run, the firewall rule, the
// Task Scheduler and the installer-based update.
package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"fyne.io/systray"
	"github.com/howznguyen/nookdeck/apps/desktop/internal/core"
)

func main() {
	openLog()
	lang = uiLanguage()
	for _, a := range os.Args[1:] {
		if a == "--setup" { // run by the installer: install or adopt the agent, then offer the firewall rule; no tray
			os.Exit(setupOnce(false))
		}
	}
	if !singleInstance() {
		// opening Nookdeck again (Start menu, desktop shortcut) while the tray runs: the tray has no window, so show the
		// manage page instead of doing nothing (Linux does the same through D-Bus)
		logf("already running: opening the manage page")
		openURL(manageURL())
		return
	}
	logf("Nookdeck tray %s starting", version)
	systray.Run(onReady, func() { logf("exit") })
}

// ---------- agent setup (A2) ----------

func bundledAgent() string {
	exe, _ := os.Executable()
	return filepath.Join(filepath.Dir(exe), "agent", "nookdeck.exe")
}

type fwState struct{ asked bool }

// firewallFlow offers the inbound rule (UAC) when the agent has none. Asked once per app run at most.
func firewallFlow(ctx context.Context, exe string, ask bool) {
	out, _ := powershell(ctx, core.FirewallScript(exe))
	if core.FirewallOK(out) {
		return
	}
	logf("no firewall rule for %s (%q)", exe, strings.TrimSpace(out))
	if !ask || !messageBox(core.T(lang, "app.name"), core.T(lang, "firewall.ask"), true) {
		return
	}
	// one elevated command (UAC), the same rule setup.ps1 adds: local subnet only
	script := "Start-Process -FilePath cmd.exe -ArgumentList @('/c', '" + strings.ReplaceAll(core.FirewallAddCommand(exe), "'", "''") + "') -Verb RunAs -Wait -WindowStyle Hidden"
	if o, code := powershell(ctx, script); code != 0 {
		logf("firewall rule not added: %d %s", code, strings.TrimSpace(o))
	}
}

var firewallAsked bool

// afterSetup offers the firewall rule once per app run, right after the agent is set up.
func afterSetup(ctx context.Context, exe string) {
	if !firewallAsked {
		firewallAsked = true
		firewallFlow(ctx, exe, true)
	}
}

// beforePair re-offers the rule when the owner opens the pairing window and it is still missing (asked once per run).
func beforePair(ctx context.Context) {
	if firewallAsked {
		return
	}
	firewallAsked = true
	firewallFlow(ctx, agentExe(), true)
}

// serviceRunning asks the Task Scheduler whether the agent's task runs (used when the agent does not answer).
func serviceRunning(ctx context.Context) bool {
	out, code := run(ctx, "schtasks.exe", "/Query", "/TN", "Nookdeck", "/FO", "LIST")
	return code == 0 && strings.Contains(strings.ToLower(out), "running")
}

// startService starts the agent's task directly (an agent too old to know `service start`).
func startService(ctx context.Context) bool {
	_, code := run(ctx, "schtasks.exe", "/Run", "/TN", "Nookdeck")
	return code == 0
}

func openDoctor() { openConsole(agentExe(), "doctor") }

func platformReady() {}

func configurePair(*core.PairServer) {}

func icon(st core.State) []byte {
	theme := "dark"
	if lightTaskbar() {
		theme = "light"
	}
	b, err := assets.ReadFile("assets/tray-" + theme + "-" + string(st) + ".ico")
	if err != nil {
		b, _ = assets.ReadFile("assets/tray-" + theme + ".ico")
	}
	return b
}


// updateNow downloads the installer of the latest release (checked against SHA256SUMS), runs it and quits; the installer replaces
// the app, then runs `Nookdeck.exe --setup` to update the agent, then starts the app again (A7).
func updateNow() {
	state.mu.Lock()
	u := state.update
	state.mu.Unlock()
	if u.Latest == nil {
		return
	}
	setBusy("update.downloading")
	defer setBusy("")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	dest := filepath.Join(os.TempDir(), core.InstallerName)
	if err := core.DownloadInstaller(ctx, &http.Client{Timeout: 10 * time.Minute}, *u.Latest, dest, updateProgress(*u.Latest)); err != nil {
		updateFailed(*u.Latest, err.Error())
		return
	}
	// the window says so before the installer closes this app; the installer starts it again
	updateState(core.UpdateState{Stage: "installing", Version: *u.Latest})
	time.Sleep(800 * time.Millisecond) // one poll of the window, so "Installing" is on screen
	logf("running %s for %s", dest, *u.Latest)
	if err := hidden0(dest, "/SILENT", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", "/NOCANCEL"); err != nil {
		updateFailed(*u.Latest, err.Error())
		return
	}
	systray.Quit()
}

// selfUpdate: the installer can always replace the app on Windows.
func selfUpdate() (bool, string) { return true, "" }
