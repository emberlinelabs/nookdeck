package core

import (
	"context"
	"path/filepath"
	"strconv"
	"strings"
)

// Paths are where the agent lives, the same places setup.ps1 uses, so an existing CLI install is adopted and never duplicated.
type Paths struct {
	Local string // %LOCALAPPDATA%
	Home  string // %USERPROFILE%
}

func (p Paths) SvcDir() string   { return filepath.Join(p.Local, "Nookdeck") }
func (p Paths) BinDir() string   { return filepath.Join(p.SvcDir(), "bin") }
func (p Paths) Exe() string      { return filepath.Join(p.BinDir(), "nookdeck.exe") }
func (p Paths) Launcher() string { return filepath.Join(p.SvcDir(), "launch.vbs") }
func (p Paths) DataDir() string  { return filepath.Join(p.Home, ".nookdeck") }
func (p Paths) LogDir() string   { return filepath.Join(p.DataDir(), "logs") }

// Ops are the side effects of setup, injected so the decisions are tested without a Windows machine.
type Ops struct {
	Exists   func(path string) bool
	ReadFile func(path string) (string, error)
	// Copy puts src at dst atomically (temp file, then rename).
	Copy func(src, dst string) error
	// Run runs a program (no console window) and returns stdout+stderr and the exit code.
	Run func(ctx context.Context, exe string, args ...string) (string, int)
	// StopService stops the agent (and frees its exe). Must work on an agent too old to know `service stop`.
	StopService func(ctx context.Context, exe string) error
	// Running reports whether something answers on the agent's local port. nil skips the check.
	Running func(ctx context.Context, port int) bool
	Logf    func(format string, args ...any)
}

type Action string

const (
	ActionOK        Action = "ok"        // nothing to do
	ActionInstalled Action = "installed" // a fresh install
	ActionUpdated   Action = "updated"   // the bundled agent is newer
	ActionAdopted   Action = "adopted"   // an install that was not ours (or ours, already current): kept as is
)

type Result struct {
	Action  Action
	Exe     string // the agent program in use
	Port    int
	Version string // its version line
	Err     error
}

// EnsureAgent installs, updates or adopts the agent (spec A2). bundled is the nookdeck.exe shipped inside the app.
// It never touches data (~/.nookdeck): `migrate` and `service install` are the same idempotent steps the CLI installer runs.
func EnsureAgent(ctx context.Context, p Paths, bundled string, o Ops) Result {
	launcher, err := o.ReadFile(p.Launcher())
	haveService := err == nil
	port := 7420
	target := p.Exe()
	if haveService {
		port = PortFromLauncher(launcher)
		// a service that runs some other copy of the program (a custom install, a dev build): that is the agent, leave its file alone
		if prog := ProgramFromLauncher(launcher); prog != "" && !samePath(prog, p.Exe()) && !isBun(prog) {
			target = prog
		}
	}
	managed := samePath(target, p.Exe())
	res := Result{Exe: target, Port: port}

	bundledVer, _ := o.Run(ctx, bundled, "--version")
	haveTarget := o.Exists(target)
	targetVer := ""
	if haveTarget {
		targetVer, _ = o.Run(ctx, target, "--version")
	}

	needCopy := managed && bundledVer != "" && (!haveTarget || Newer(bundledVer, targetVer))
	switch {
	case needCopy:
		if haveTarget {
			o.Logf("stopping the agent to update it")
			if err := o.StopService(ctx, target); err != nil {
				res.Err = err
				return res
			}
		}
		if err := o.Copy(bundled, target); err != nil {
			res.Err = err
			return res
		}
		res.Action = ActionUpdated
		if !haveTarget && !haveService {
			res.Action = ActionInstalled
		}
		// 0.1.x (PhoneDesk) data, hooks and aliases; idempotent, never deletes data. The service step is ours, below.
		o.Run(ctx, target, "migrate", "--no-service")
	case haveTarget || haveService:
		res.Action = ActionAdopted
		if managed && !haveService {
			res.Action = ActionOK
		}
	default:
		res.Err = errNoAgent
		return res
	}

	args := []string{"service", "install"}
	if port != 7420 {
		args = append(args, "--port", strconv.Itoa(port))
	}
	switch {
	case !haveService:
		if out, code := o.Run(ctx, target, args...); code != 0 {
			res.Err = &runError{"service install", out}
			return res
		}
	case needCopy:
		if out, code := o.Run(ctx, target, "service", "restart"); code != 0 {
			// the launcher may point at a program that has just changed place: install writes it again
			if out2, code2 := o.Run(ctx, target, args...); code2 != 0 {
				res.Err = &runError{"service restart", out + out2}
				return res
			}
		}
	}
	// "adopted" or "ok" must never leave the deck down: an agent that is installed but not running (stopped by hand, killed by an
	// upgrade, a crash before the task restarted it) is started, even when its version did not change
	if haveService && !needCopy && o.Running != nil && !o.Running(ctx, port) {
		o.Logf("the agent is not answering on port %d: starting it", port)
		if out, code := o.Run(ctx, target, "service", "start"); code != 0 {
			if out2, code2 := o.Run(ctx, target, args...); code2 != 0 {
				res.Err = &runError{"service start", out + out2}
				return res
			}
		}
	}
	res.Version, _ = o.Run(ctx, target, "--version")
	return res
}

// samePath compares Windows paths (case-insensitive, either slash).
func samePath(a, b string) bool {
	n := func(s string) string { return strings.ToLower(strings.TrimRight(strings.ReplaceAll(s, "/", `\`), `\`)) }
	return n(a) == n(b)
}

func isBun(path string) bool {
	b := strings.ToLower(filepath.Base(path))
	return b == "bun.exe" || b == "bun"
}

type runError struct{ what, out string }

func (e *runError) Error() string { return e.what + " failed: " + strings.TrimSpace(e.out) }

var errNoAgent = &runError{"setup", "no agent program to install"}

// FirewallScript is the PowerShell that prints the Action of every enabled inbound rule for exe ("Allow,Block"). Locale-proof
// (it reads enum values, not netsh text), the same query setup.ps1 uses.
func FirewallScript(exe string) string {
	q := strings.ReplaceAll(exe, "'", "''")
	return "$r=@(Get-NetFirewallApplicationFilter -Program '" + q + "' -ErrorAction SilentlyContinue | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }); ($r | ForEach-Object { $_.Action }) -join ','"
}

// FirewallOK parses the FirewallScript output: allowed, and not overridden by a BLOCK rule (an unanswered Windows popup makes one).
func FirewallOK(out string) bool {
	return strings.Contains(out, "Allow") && !strings.Contains(out, "Block")
}

// FirewallAddCommand is the elevated command line that replaces any rule for exe with one allow rule, local subnet only (as setup.ps1).
func FirewallAddCommand(exe string) string {
	return `netsh advfirewall firewall delete rule name=all program="` + exe + `" >nul 2>&1 & netsh advfirewall firewall add rule name="Nookdeck" dir=in action=allow program="` + exe + `" profile=any remoteip=localsubnet enable=yes`
}
