//go:build linux

package main

import (
	"context"
	"embed"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/howznguyen/nookdeck/apps/desktop/internal/core"
)

//go:embed assets/*.png
var assets embed.FS

// run starts a program and returns stdout+stderr and the exit code (127: it could not start).
func run(ctx context.Context, exe string, args ...string) (string, int) {
	out, err := exec.CommandContext(ctx, exe, args...).CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return string(out), ee.ExitCode()
	}
	return err.Error(), 127
}

// detach starts a program in its own session and does not wait for it (a browser, a terminal, the file manager).
func detach(exe string, args ...string) error {
	c := exec.Command(exe, args...)
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := c.Start(); err != nil {
		return err
	}
	go c.Wait() // reap it
	return nil
}

// agentRunning: anything that answers on the port (even a 404) counts; a refused connection does not.
func agentRunning(ctx context.Context, port int) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(port)+"/", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

// stopService stops the agent; an agent too old to know `service stop` is stopped through systemd.
func stopService(ctx context.Context, exe string) error {
	if _, code := run(ctx, exe, "service", "stop"); code == 0 {
		return nil
	}
	run(ctx, "systemctl", "--user", "stop", "nookdeck.service")
	return nil
}

// serviceRunning: the systemd unit is active, or the agent started from the autostart entry is alive (used when nothing answers).
func serviceRunning(ctx context.Context) bool {
	if out, code := run(ctx, "systemctl", "--user", "is-active", "nookdeck.service"); code == 0 && strings.TrimSpace(out) == "active" {
		return true
	}
	b, err := os.ReadFile(filepath.Join(paths().DataDir(), "service.pid"))
	if err != nil {
		return false
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

// startService starts the agent without its own `service start` (an agent too old to know it).
func startService(ctx context.Context) bool {
	if _, code := run(ctx, "systemctl", "--user", "start", "nookdeck.service"); code == 0 {
		return true
	}
	if script := paths().AutostartScript(); fileExists(script) {
		return detach("/bin/sh", script) == nil
	}
	return false
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, dst) // a running agent keeps its old file open; the rename is still fine
}

func ops() core.Ops {
	return core.Ops{
		Exists:      fileExists,
		ReadFile:    func(p string) (string, error) { b, err := os.ReadFile(p); return string(b), err },
		Copy:        copyFile,
		Run:         run,
		StopService: stopService,
		Running:     agentRunning,
		Logf:        logf,
	}
}

func paths() core.Paths {
	home, _ := os.UserHomeDir()
	return core.Paths{Home: home, Linux: true, Config: os.Getenv("XDG_CONFIG_HOME")}
}

// bundledAgent is the agent a package or tarball ships next to the tray program (/usr/lib/nookdeck/nookdeck for the .deb).
func bundledAgent() string {
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	c := core.BundledAgentCandidates(exe)
	for _, p := range c {
		if fileExists(p) {
			return p
		}
	}
	return c[0]
}

// messageBox shows a message with zenity or kdialog when one is installed, else a notification; the answer of a question
// without either is "no".
func messageBox(title, text string, yesNo bool) bool {
	ctx := context.Background()
	if p, err := exec.LookPath("zenity"); err == nil {
		kind := "--info"
		if yesNo {
			kind = "--question"
		}
		_, code := run(ctx, p, kind, "--title="+title, "--text="+text, "--no-markup")
		return code == 0
	}
	if p, err := exec.LookPath("kdialog"); err == nil {
		kind := "--msgbox"
		if yesNo {
			kind = "--yesno"
		}
		_, code := run(ctx, p, "--title", title, kind, text)
		return code == 0
	}
	if p, err := exec.LookPath("notify-send"); err == nil {
		run(ctx, p, "--app-name=Nookdeck", "--icon=dev.nookdeck.app", title, text)
	}
	return !yesNo
}

func uiLanguage() string {
	for _, k := range []string{"NOOKDECK_LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"} {
		if v := os.Getenv(k); v != "" && v != "C" && v != "POSIX" {
			return core.Lang(v)
		}
	}
	return "en"
}

// lightPanel is true when the panel is light and needs the dark glyph. GNOME's top bar is always dark; KDE says it in kdeglobals.
// NOOKDECK_TRAY_THEME=light|dark overrides it.
func lightPanel() bool {
	switch os.Getenv("NOOKDECK_TRAY_THEME") {
	case "light":
		return true
	case "dark":
		return false
	}
	if strings.Contains(strings.ToUpper(os.Getenv("XDG_CURRENT_DESKTOP")), "KDE") {
		cfg := os.Getenv("XDG_CONFIG_HOME")
		if cfg == "" {
			home, _ := os.UserHomeDir()
			cfg = filepath.Join(home, ".config")
		}
		b, err := os.ReadFile(filepath.Join(cfg, "kdeglobals"))
		if err == nil {
			for _, line := range strings.Split(string(b), "\n") {
				if strings.HasPrefix(line, "ColorScheme=") {
					return !strings.Contains(strings.ToLower(line), "dark")
				}
			}
			return true // Breeze (light) is the default
		}
	}
	return false
}

func icon(st core.State) []byte {
	theme := "dark"
	if lightPanel() {
		theme = "light"
	}
	b, err := assets.ReadFile("assets/tray-" + theme + "-" + string(st) + "-48.png")
	if err != nil {
		b, _ = assets.ReadFile("assets/tray-" + theme + "-running-48.png")
	}
	return b
}

func trayExe() string {
	exe, _ := os.Executable()
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return exe
}

func loginItemEnabled() bool { return fileExists(paths().TrayAutostart()) }

// setLoginItem writes or removes ~/.config/autostart/nookdeck-tray.desktop.
func setLoginItem(on bool) error {
	f := paths().TrayAutostart()
	if !on {
		if err := os.Remove(f); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return err
	}
	return os.WriteFile(f, []byte(core.TrayAutostartEntry(trayExe())), 0o644)
}

// openURL opens a link in the default browser.
func openURL(u string) {
	if err := detach("xdg-open", u); err != nil {
		logf("xdg-open %s: %v", u, err)
	}
}

func openFolder(dir string) {
	os.MkdirAll(dir, 0o755)
	openURL(dir)
}

// openAppWindow shows a page in its own small window (a Chromium-family browser in app mode); the default browser otherwise.
func openAppWindow(u string, w, h int) {
	home, _ := os.UserHomeDir()
	cache := os.Getenv("XDG_CACHE_HOME")
	if cache == "" {
		cache = filepath.Join(home, ".cache")
	}
	for _, name := range core.AppBrowsers {
		p, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		if detach(p, core.AppWindowArgs(p, u, w, h, home, cache)...) == nil {
			logf("app window: %s", p)
			return
		}
	}
	openURL(u)
}

// openDoctor runs `nookdeck doctor` in a terminal window that stays open.
func openDoctor() {
	script := core.TerminalScript(agentExe(), "doctor")
	for _, term := range core.Terminals {
		p, err := exec.LookPath(term[0])
		if err != nil {
			continue
		}
		if detach(p, append(append([]string{}, term[1:]...), script...)...) == nil {
			return
		}
	}
	notice(t("error.noTerminal", "command", agentExe()+" doctor"))
}

func afterSetup(context.Context, string) {} // the firewall (ufw) is a doctor item with its command, never changed from here
func beforePair(context.Context)         {}

// The firewall (ufw) is a doctor item with its command, never changed from the tray.
const firewallFixable = false

func fixFirewall() {}
