package core

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Texts as src/service.ts writes them (buildUnit, buildAutostartScript), with a space and a quote to make the quoting matter.
const unitText = `[Unit]
Description=Nookdeck agent
PartOf=graphical-session.target

[Service]
Type=simple
ExecStart="/home/a b/.nookdeck/bin/nookdeck" "--port" "7421"
Environment="PATH=/home/a b/.local/bin:/usr/bin:/bin"
Environment="X=it's 50%%"
Restart=on-failure
`

const autostartText = `#!/bin/sh
# Nookdeck agent, started at login by the XDG autostart entry (nookdeck service install)
exec env 'PATH=/home/a b/.local/bin:/usr/bin' 'X=it'\''s 50%' '/home/a b/.nookdeck/bin/nookdeck' '--port' '7421' >>'/home/a b/.nookdeck/logs/agent.out.log' 2>>'/home/a b/.nookdeck/logs/agent.err.log'
`

func linuxPaths() Paths { return Paths{Home: "/home/a b", Linux: true} }

func TestLinuxPaths(t *testing.T) {
	p := linuxPaths()
	want := map[string]string{
		p.Exe():             "/home/a b/.nookdeck/bin/nookdeck",
		p.Launcher():        "/home/a b/.config/systemd/user/nookdeck.service",
		p.AutostartScript(): "/home/a b/.nookdeck/autostart.sh",
		p.TrayAutostart():   "/home/a b/.config/autostart/nookdeck-tray.desktop",
		p.LogDir():          "/home/a b/.nookdeck/logs",
		p.SvcDir():          "/home/a b/.nookdeck",
	}
	for got, w := range want {
		if got != w {
			t.Errorf("got %q want %q", got, w)
		}
	}
	p.Config = "/x/cfg"
	if p.Launcher() != "/x/cfg/systemd/user/nookdeck.service" || len(p.Launchers()) != 2 {
		t.Errorf("XDG_CONFIG_HOME: %v", p.Launchers())
	}
	// Linux paths are case-sensitive; Windows ones are not
	if p.samePath("/home/A/nookdeck", "/home/a/nookdeck") || !p.samePath("/x/y/", "/x/y") {
		t.Error("linux samePath")
	}
	if !(Paths{}).samePath(`C:\A\b.exe`, "c:/a/B.EXE") {
		t.Error("windows samePath")
	}
}

func TestLinuxLaunchers(t *testing.T) {
	for name, text := range map[string]string{"unit": unitText, "autostart": autostartText} {
		if got := ProgramFromLauncher(text); got != "/home/a b/.nookdeck/bin/nookdeck" {
			t.Errorf("%s program %q", name, got)
		}
		if PortFromLauncher(text) != 7421 {
			t.Errorf("%s port", name)
		}
	}
	if got := programFromUnit(`ExecStart="/opt/x \"q\"/100%%/$$HOME/nookdeck"`); got != `/opt/x "q"/100%/$HOME/nookdeck` {
		t.Errorf("unit unescape %q", got)
	}
	if ProgramFromLauncher("[Service]\nType=simple\n") != "" || PortFromLauncher(strings.Replace(unitText, ` "--port" "7421"`, "", 1)) != 7420 {
		t.Error("no program / default port")
	}
}

func linuxSys() (*fakeSys, Paths) {
	p := linuxPaths()
	b := "/usr/lib/nookdeck/nookdeck"
	return &fakeSys{files: map[string]string{b: "bundled"}, versions: map[string]string{b: "nookdeck 0.6.0 (abc)"}, failRun: map[string]int{}}, p
}

func TestEnsureAgentLinux(t *testing.T) {
	const bundled = "/usr/lib/nookdeck/nookdeck"
	// .deb on a fresh machine: copy to ~/.nookdeck/bin, migrate, service install
	f, p := linuxSys()
	r := EnsureAgent(context.Background(), p, bundled, f.ops())
	if r.Err != nil || r.Action != ActionInstalled || r.Exe != "/home/a b/.nookdeck/bin/nookdeck" || f.files[p.Exe()] != "bundled" {
		t.Fatalf("fresh: %+v", r)
	}
	if !has(f.runs, "migrate --no-service") || !has(f.runs, "service install") {
		t.Errorf("fresh steps %v", f.runs)
	}
	// a setup.sh install (systemd unit, port 7421), same version: adopted, port kept, nothing replaced
	f, p = linuxSys()
	f.files[p.Exe()], f.versions[p.Exe()] = "cli", "nookdeck 0.6.0"
	f.files[p.Launcher()] = unitText
	if r = EnsureAgent(context.Background(), p, bundled, f.ops()); r.Err != nil || r.Action != ActionAdopted || r.Port != 7421 || f.files[p.Exe()] != "cli" || has(f.runs, "service install") {
		t.Fatalf("adopt: %+v %v", r, f.runs)
	}
	// the autostart fallback (no systemd) is a service too
	f, p = linuxSys()
	f.files[p.Exe()], f.versions[p.Exe()] = "cli", "nookdeck 0.5.0"
	f.files[p.AutostartScript()] = autostartText
	r = EnsureAgent(context.Background(), p, bundled, f.ops())
	if r.Err != nil || r.Action != ActionUpdated || r.Port != 7421 || f.files[p.Exe()] != "bundled" || !has(f.runs, "service restart") || has(f.runs, "service install") {
		t.Fatalf("autostart update: %+v %v", r, f.runs)
	}
	// never a downgrade
	f, p = linuxSys()
	f.files[p.Exe()], f.versions[p.Exe()] = "newer", "nookdeck 0.7.0"
	f.files[p.Launcher()] = unitText
	if r = EnsureAgent(context.Background(), p, bundled, f.ops()); r.Action != ActionAdopted || f.files[p.Exe()] != "newer" {
		t.Errorf("downgrade: %+v", r)
	}
	// a unit that runs a dev checkout through bun is not "another program": ours stays the target
	f, p = linuxSys()
	f.files[p.Launcher()] = `ExecStart="/home/a b/.bun/bin/bun" "/src/index.ts"`
	if r = EnsureAgent(context.Background(), p, bundled, f.ops()); r.Exe != p.Exe() {
		t.Errorf("bun: %+v", r)
	}
	// no bundled agent (a tray-only build) and nothing installed: an error, not a crash
	f, p = linuxSys()
	delete(f.files, bundled)
	delete(f.versions, bundled)
	if r = EnsureAgent(context.Background(), p, bundled, f.ops()); r.Err == nil {
		t.Error("want an error")
	}
}

func TestLinuxHelpers(t *testing.T) {
	if n, ok := PackageAsset("deb", "v0.6.0", "amd64"); !ok || n != "nookdeck_0.6.0_amd64.deb" {
		t.Errorf("deb %q", n)
	}
	if n, ok := PackageAsset("rpm", "0.6.0", "arm64"); !ok || n != "nookdeck-0.6.0.aarch64.rpm" {
		t.Errorf("rpm %q", n)
	}
	if _, ok := PackageAsset("", "0.6.0", "amd64"); ok {
		t.Error("no package: no asset")
	}
	if _, ok := PackageAsset("deb", "0.6.0", "386"); ok {
		t.Error("386 has no package")
	}
	if got := strings.Join(InstallCommand("deb", "/tmp/x/n.deb"), " "); got != "pkexec apt install -y /tmp/x/n.deb" {
		t.Error(got)
	}
	if got := strings.Join(InstallCommand("rpm", "/tmp/x/n.rpm"), " "); got != "pkexec dnf install -y /tmp/x/n.rpm" {
		t.Error(got)
	}
	if ReleasePage("0.6.0") != "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.0" {
		t.Error("release page")
	}
	a := AppWindowArgs("/usr/bin/chromium", "http://127.0.0.1:1/t/", 460, 760, "/home/u", "/home/u/.cache")
	if a[0] != "--app=http://127.0.0.1:1/t/" || a[1] != "--window-size=460,760" || a[2] != "--user-data-dir=/home/u/.cache/nookdeck/app-window" {
		t.Errorf("app args %v", a)
	}
	if a = AppWindowArgs("/snap/bin/chromium", "u", 1, 1, "/home/u", "/home/u/.cache"); a[2] != "--user-data-dir=/home/u/snap/chromium/common/nookdeck-app-window" {
		t.Errorf("snap profile %v", a)
	}
	e := TrayAutostartEntry(`/opt/my "apps"/100%/nookdeck-tray`)
	if !strings.Contains(e, `Exec="/opt/my \\"apps\\"/100%%/nookdeck-tray"`) || !strings.Contains(e, "Icon=dev.nookdeck.app") || !strings.Contains(e, "X-GNOME-Autostart-enabled=true") {
		t.Errorf("entry:\n%s", e)
	}
	if got := BundledAgentCandidates("/usr/bin/nookdeck-tray"); len(got) != 2 || got[1] != "/usr/lib/nookdeck/nookdeck" || got[0] != "/usr/bin/agent/nookdeck" {
		t.Errorf("deb candidates %v", got)
	}
	if got := BundledAgentCandidates("/opt/nookdeck/nookdeck-tray"); len(got) != 3 || got[0] != "/opt/nookdeck/agent/nookdeck" || got[2] != "/usr/lib/nookdeck/nookdeck" {
		t.Errorf("tarball candidates %v", got)
	}
	ts := TerminalScript("/home/a b/it's/nookdeck", "doctor")
	if ts[2] != `'/home/a b/it'\''s/nookdeck' 'doctor'; echo; printf 'Press Enter to close. '; read x` {
		t.Errorf("terminal %q", ts[2])
	}
}

func TestTrayPage(t *testing.T) {
	c := fakeAgent(t)
	ps, err := StartPairServer(c, "en")
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	get := func(u string) (int, string) {
		res, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	// not configured (Windows): no tray page
	if code, _ := get(ps.TrayURL()); code != 404 {
		t.Errorf("unconfigured %d", code)
	}
	on := false
	ps.TrayOn = func() bool { return on }
	ps.TrayCommand = "sudo apt install gnome-shell-extension-appindicator"
	code, body := get(ps.TrayURL())
	if code != 200 || !strings.Contains(body, "Turn on the tray icon") || !strings.Contains(body, "gnome-shell-extension-appindicator") || !strings.Contains(body, c.ManageURL()) {
		t.Fatalf("tray page %d %.200s", code, body)
	}
	if _, s := get(ps.TrayURL() + "/status"); !strings.Contains(s, `"trayOn":false`) {
		t.Errorf("status %s", s)
	}
	on = true
	if _, s := get(ps.TrayURL() + "/status"); !strings.Contains(s, `"trayOn":true`) {
		t.Errorf("status %s", s)
	}
	// the texts are JSON in a script: nothing can close the tag
	if strings.Contains(TrayPage("en", "</script><b>", "x"), "</script><b>") {
		t.Error("escape")
	}
	for _, l := range []string{"vi", "zh"} {
		if TrayPage(l, "c", "m") == TrayPage("en", "c", "m") {
			t.Errorf("%s not translated", l)
		}
	}
}
