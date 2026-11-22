//go:build windows

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

	"github.com/howznguyen/nookdeck/apps/windows/internal/core"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

//go:embed assets/*.ico
var assets embed.FS

const (
	createNoWindow = 0x08000000
	runKeyPath     = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValue       = "Nookdeck"
	themeKeyPath   = `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`
)

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

// run starts a program without a console window and returns stdout+stderr and the exit code (127: it could not start).
func run(ctx context.Context, exe string, args ...string) (string, int) {
	out, err := hidden(exec.CommandContext(ctx, exe, args...)).CombinedOutput()
	if err == nil {
		return string(out), 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return string(out), ee.ExitCode()
	}
	return err.Error(), 127
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

func powershell(ctx context.Context, script string) (string, int) {
	return run(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
}

// stopService stops the agent; an agent from before `service stop` existed is ended through the task and by its program path.
func stopService(ctx context.Context, exe string) error {
	if _, code := run(ctx, exe, "service", "stop"); code == 0 {
		return nil
	}
	run(ctx, "schtasks.exe", "/End", "/TN", "Nookdeck")
	q := strings.ReplaceAll(exe, "'", "''")
	powershell(ctx, "Get-Process | Where-Object { $_.Path -eq '"+q+"' } | Stop-Process -Force")
	return nil
}

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
	return os.Rename(tmp, dst) // replaces the old file (the agent is stopped, so it is not locked)
}

func ops() core.Ops {
	return core.Ops{
		Exists:      func(p string) bool { _, err := os.Stat(p); return err == nil },
		ReadFile:    func(p string) (string, error) { b, err := os.ReadFile(p); return string(b), err },
		Copy:        copyFile,
		Run:         run,
		StopService: stopService,
		Running:     agentRunning,
		Logf:        logf,
	}
}

func paths() core.Paths {
	local := os.Getenv("LOCALAPPDATA")
	home := os.Getenv("USERPROFILE")
	if local == "" {
		local = filepath.Join(home, "AppData", "Local")
	}
	return core.Paths{Local: local, Home: home}
}

func messageBox(title, text string, yesNo bool) bool {
	flags := uint32(windows.MB_OK | windows.MB_ICONINFORMATION)
	if yesNo {
		flags = windows.MB_YESNO | windows.MB_ICONQUESTION
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(title)
	r, _ := windows.MessageBox(0, t, c, flags)
	return r == 6 || r == 1 // IDYES, IDOK
}

// singleInstance returns false when another copy of the tray app is already running.
func singleInstance() bool {
	name, _ := windows.UTF16PtrFromString(`Local\NookdeckTrayApp`)
	_, err := windows.CreateMutex(nil, false, name)
	return err != windows.ERROR_ALREADY_EXISTS
}

func uiLanguage() string {
	if v := os.Getenv("NOOKDECK_LANG"); v != "" {
		return core.Lang(v)
	}
	if langs, err := windows.GetUserPreferredUILanguages(windows.MUI_LANGUAGE_NAME); err == nil && len(langs) > 0 {
		return core.Lang(langs[0])
	}
	return "en"
}

// lightTaskbar is true when the taskbar is light (SystemUsesLightTheme = 1): the tray needs the dark glyph then.
func lightTaskbar() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, themeKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemUsesLightTheme")
	return err == nil && v == 1
}

func loginItemEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKeyPath, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValue)
	return err == nil
}

func setLoginItem(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKeyPath, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue(runValue, `"`+exe+`"`)
}

// openURL opens a link in the default browser.
func openURL(u string) { hidden(exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", u)).Start() }

func openFolder(dir string) {
	os.MkdirAll(dir, 0o755)
	exec.Command("explorer.exe", dir).Start()
}

// openAppWindow shows a page in its own small window (Edge or Chrome app mode); the default browser if neither is found.
func openAppWindow(u string, w, h int) {
	pf := []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")}
	rel := []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`}
	for _, r := range rel {
		for _, base := range pf {
			if base == "" {
				continue
			}
			p := filepath.Join(base, r)
			if _, err := os.Stat(p); err == nil {
				args := []string{"--app=" + u, "--window-size=" + itoa(w) + "," + itoa(h), "--user-data-dir=" + filepath.Join(os.TempDir(), "nookdeck-pair-profile"), "--no-first-run"}
				if exec.Command(p, args...).Start() == nil {
					return
				}
			}
		}
	}
	openURL(u)
}

func itoa(n int) string { return strconv.Itoa(n) }

// openConsole opens a console window running `exe args` and keeps it open (nookdeck doctor).
func openConsole(exe string, args ...string) {
	cmdline := `"` + exe + `"`
	for _, a := range args {
		cmdline += " " + a
	}
	c := exec.Command("cmd.exe", "/c", "start", "", "cmd.exe", "/k", cmdline)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	c.Start()
}


// hidden0 starts a program and does not wait for it (the installer, which closes this app).
func hidden0(exe string, args ...string) error {
	return exec.Command(exe, args...).Start()
}
