//go:build windows

// Nookdeck for Windows: a tray app that controls the Nookdeck agent (spec desktop-apps, A1-A7). The agent keeps running as the
// per-user scheduled task, so quitting this app never stops the phone panel.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"fyne.io/systray"
	"github.com/howznguyen/nookdeck/apps/windows/internal/core"
)

var version = "dev"

var (
	lang   string
	logMu  sync.Mutex
	logOut *os.File
)

func logf(format string, args ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	if logOut != nil {
		fmt.Fprintf(logOut, time.Now().Format("2006-01-02 15:04:05 ")+format+"\n", args...)
	}
}

func openLog() {
	p := filepath.Join(paths().SvcDir(), "tray.log")
	os.MkdirAll(filepath.Dir(p), 0o755)
	if st, err := os.Stat(p); err == nil && st.Size() > 256<<10 {
		os.Remove(p)
	}
	logOut, _ = os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

func main() {
	openLog()
	lang = uiLanguage()
	for _, a := range os.Args[1:] {
		if a == "--setup" { // run by the installer: install or adopt the agent, then offer the firewall rule; no tray
			os.Exit(setupOnce(false))
		}
	}
	if !singleInstance() {
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

// setupOnce installs or adopts the agent and handles the firewall. It returns the exit code for --setup.
func setupOnce(tray bool) int {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	res := core.EnsureAgent(ctx, paths(), bundledAgent(), ops())
	logf("setup: %s exe=%s port=%d version=%q err=%v", res.Action, res.Exe, res.Port, strings.TrimSpace(res.Version), res.Err)
	if res.Err != nil {
		if !tray {
			messageBox(core.T(lang, "app.name"), core.T(lang, "error.setupFailed", "error", res.Err.Error()), false)
		}
		return 1
	}
	if !firewallAsked {
		firewallAsked = true
		firewallFlow(ctx, res.Exe, true)
	}
	state.mu.Lock()
	state.exe, state.port = res.Exe, res.Port
	state.mu.Unlock()
	return 0
}

// ---------- state shared between the poller and the menu ----------

var state struct {
	mu        sync.Mutex
	exe       string
	port      int
	phones    int
	st        core.State
	busy      string // a status key while Start/Stop/Restart/setup run
	update    core.Update
	checking  bool
	unreach   bool
}

func client() *core.Client {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.port == 0 {
		state.port = 7420
	}
	return core.NewClient(state.port)
}

func agentExe() string {
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.exe == "" {
		state.exe = paths().Exe()
	}
	return state.exe
}

func manageURL() string { return "http://127.0.0.1:" + strconv.Itoa(client().Port) + "/manage/" }

// ---------- the menu (A6) ----------

var (
	mStatus, mPhones, mPair, mManage, mToggle, mRestart, mUpdate, mUpdateNow, mLogin *systray.MenuItem
	mHelp, mDoctor, mLogs, mDocs, mSite, mVersion, mQuit                           *systray.MenuItem
	pair                                                                           *core.PairServer
)

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

func t(key string, vars ...string) string { return core.T(lang, key, vars...) }

func onReady() {
	state.st = core.StateStopped
	systray.SetIcon(icon(core.StateStopped))
	systray.SetTooltip(t("tray.tooltip.stopped"))
	mStatus = systray.AddMenuItem(t("status.settingUp"), "")
	mStatus.Disable()
	mPhones = systray.AddMenuItem(core.Phones(lang, 0), "")
	mPhones.Disable()
	systray.AddSeparator()
	mPair = systray.AddMenuItem(t("menu.pair"), "")
	mManage = systray.AddMenuItem(t("menu.openManage"), "")
	systray.AddSeparator()
	mToggle = systray.AddMenuItem(t("menu.stop"), "")
	mRestart = systray.AddMenuItem(t("menu.restart"), "")
	systray.AddSeparator()
	mUpdate = systray.AddMenuItem(t("menu.checkUpdates"), "")
	mUpdateNow = systray.AddMenuItem(t("menu.updateNow"), "")
	mUpdateNow.Hide()
	mLogin = systray.AddMenuItemCheckbox(t("menu.openAtLogin"), "", loginItemEnabled())
	mHelp = systray.AddMenuItem(t("menu.help"), "")
	mDoctor = mHelp.AddSubMenuItem(t("menu.help.permissions"), "")
	mLogs = mHelp.AddSubMenuItem(t("menu.help.logs"), "")
	mDocs = mHelp.AddSubMenuItem(t("menu.help.docs"), "")
	mSite = mHelp.AddSubMenuItem(t("menu.help.website"), "")
	systray.AddSeparator()
	mVersion = systray.AddMenuItem(t("menu.version", "version", version), "")
	mVersion.Disable()
	mQuit = systray.AddMenuItem(t("menu.quit"), t("menu.quit.hint"))

	go func() { // install or adopt first, then poll
		setBusy("status.settingUp")
		if setupOnce(true) != 0 {
			notice(t("error.setupFailed", "error", "see tray.log"))
		}
		setBusy("")
		poll()
		tick := time.NewTicker(5 * time.Second)
		for range tick.C {
			poll()
		}
	}()
	go func() {
		for {
			select {
			case <-mPair.ClickedCh:
				go openPair()
			case <-mManage.ClickedCh:
				openURL(manageURL())
			case <-mToggle.ClickedCh:
				go toggle()
			case <-mRestart.ClickedCh:
				go control("restart", "status.restarting", "error.restartFailed")
			case <-mUpdate.ClickedCh:
				go checkUpdate(true)
			case <-mUpdateNow.ClickedCh:
				go updateNow()
			case <-mLogin.ClickedCh:
				on := !mLogin.Checked()
				if err := setLoginItem(on); err != nil {
					notice(t("error.loginItemFailed", "error", err.Error()))
				} else if on {
					mLogin.Check()
				} else {
					mLogin.Uncheck()
				}
			case <-mDoctor.ClickedCh:
				openConsole(agentExe(), "doctor")
			case <-mLogs.ClickedCh:
				openFolder(paths().LogDir())
			case <-mDocs.ClickedCh:
				openURL("https://github.com/howznguyen/nookdeck#readme")
			case <-mSite.ClickedCh:
				openURL("https://nookdeck.app")
			case <-mQuit.ClickedCh:
				if pair != nil {
					pair.Close()
				}
				systray.Quit()
				return
			}
		}
	}()
	go func() { time.Sleep(20 * time.Second); checkUpdate(false); for range time.Tick(6 * time.Hour) { checkUpdate(false) } }()
}

func notice(text string) { logf("notice: %s", text); go messageBox(t("app.name"), text, false) }

func setBusy(key string) {
	state.mu.Lock()
	state.busy = key
	state.mu.Unlock()
	render()
}

// poll asks the agent (cheap: the device list) and the Task Scheduler only when the agent does not answer.
func poll() {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	c := client()
	ds, err := c.Devices(ctx)
	reachable := err == nil
	var doc *core.Doctor
	if reachable {
		if d, err := c.Doctor(ctx); err == nil {
			doc = &d
		}
	}
	running := false
	if !reachable {
		out, code := run(ctx, "schtasks.exe", "/Query", "/TN", "Nookdeck", "/FO", "LIST")
		running = code == 0 && strings.Contains(strings.ToLower(out), "running")
	}
	state.mu.Lock()
	state.st = core.StateOf(reachable, running, doc)
	state.unreach = !reachable
	state.phones = core.Online(ds)
	state.mu.Unlock()
	render()
}

// render shows the state: tray icon and tooltip, the status line, the phone count and the labels of Start/Stop.
func render() {
	state.mu.Lock()
	st, phones, busy, up, unreach := state.st, state.phones, state.busy, state.update, state.unreach
	state.mu.Unlock()
	if mStatus == nil {
		return
	}
	line := map[core.State]string{core.StateRunning: "status.running", core.StateStopped: "status.stopped", core.StateAttention: "status.needsPermission"}[st]
	if st == core.StateAttention && unreach {
		line = "status.unreachable" // the task runs but nothing answers: starting up or crashed
	}
	if busy != "" {
		line = busy
	}
	mStatus.SetTitle("● " + t(line))
	systray.SetIcon(icon(st))
	systray.SetTooltip(t("tray.tooltip." + string(st)))
	mPhones.SetTitle(core.Phones(lang, phones))
	if st == core.StateStopped {
		mToggle.SetTitle(t("menu.start"))
		mRestart.Disable()
	} else {
		mToggle.SetTitle(t("menu.stop"))
		mRestart.Enable()
	}
	if busy != "" {
		mToggle.Disable()
		mRestart.Disable()
	} else {
		mToggle.Enable()
	}
	if up.Available && up.Latest != nil {
		mUpdate.SetTitle(t("menu.updateAvailable", "version", *up.Latest))
		mUpdateNow.Show()
	}
}

func toggle() {
	state.mu.Lock()
	stopped := state.st == core.StateStopped
	state.mu.Unlock()
	if stopped {
		control("start", "status.starting", "error.startFailed")
	} else {
		control("stop", "status.stopping", "error.stopFailed")
	}
}

// control runs `nookdeck service <verb>`; Start/Stop/Restart are the agent's own commands, the same as in a terminal.
func control(verb, busyKey, errKey string) {
	setBusy(busyKey)
	defer func() { setBusy(""); poll() }()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if out, code := run(ctx, agentExe(), "service", verb); code != 0 {
		// an agent from before start/stop existed: do it through the task
		switch verb {
		case "stop":
			stopService(ctx, agentExe())
			return
		case "start":
			if _, c2 := run(ctx, "schtasks.exe", "/Run", "/TN", "Nookdeck"); c2 == 0 {
				return
			}
		}
		notice(t(errKey, "error", strings.TrimSpace(out)))
	}
}

func openPair() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	state.mu.Lock()
	stopped := state.st == core.StateStopped
	state.mu.Unlock()
	if stopped {
		notice(t("pair.notRunning"))
		return
	}
	if pair == nil {
		p, err := core.StartPairServer(client(), lang)
		if err != nil {
			notice(t("error.generic", "error", err.Error()))
			return
		}
		pair = p
	}
	go firewallFlowOnce(ctx)
	openAppWindow(pair.URL(), 460, 760)
}

// firewallFlowOnce re-offers the rule when the owner opens the pairing window and it is still missing (asked once per run).
func firewallFlowOnce(ctx context.Context) {
	if firewallAsked {
		return
	}
	firewallAsked = true
	firewallFlow(ctx, agentExe(), true)
}

func checkUpdate(user bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if user {
		mUpdate.SetTitle(t("menu.checking"))
	}
	u, err := client().Update(ctx, user)
	if err != nil || u.Error != "" {
		if user {
			mUpdate.SetTitle(t("menu.checkUpdates"))
			notice(t("error.updateCheckFailed"))
		}
		return
	}
	state.mu.Lock()
	state.update = u
	state.mu.Unlock()
	if u.Available {
		render()
		return
	}
	mUpdateNow.Hide()
	if user {
		notice(t("menu.upToDate", "version", u.Current))
	}
	mUpdate.SetTitle(t("menu.checkUpdates"))
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
	if err := core.DownloadInstaller(ctx, &http.Client{Timeout: 10 * time.Minute}, *u.Latest, dest); err != nil {
		notice(t("error.updateFailed", "error", err.Error()))
		return
	}
	logf("running %s for %s", dest, *u.Latest)
	if err := hidden0(dest, "/SILENT", "/CLOSEAPPLICATIONS", "/RESTARTAPPLICATIONS", "/NOCANCEL"); err != nil {
		notice(t("error.updateFailed", "error", err.Error()))
		return
	}
	systray.Quit()
}
