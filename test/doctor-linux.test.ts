import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake probes only: nothing here runs ufw, ydotool or systemctl, or reads the real /etc.
process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-doc-linux-"));
const D = await import("../src/doctor");
const I = await import("../src/i18n");
afterAll(() => I.setLanguage("en"));

type P = import("../src/doctor").Probes;
const EXE = "/home/me/.nookdeck/bin/nookdeck";
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n';
const X11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" };
const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", XDG_CURRENT_DESKTOP: "GNOME" };
const YDO_1 = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  key\n  type\n  bakers\n  debug\n";
const YDO_01 = "Usage: ydotool <cmd> <args>\nAvailable commands:\n  click\n  key\n  type\n  recorder\n";

function probes(o: {
  tools?: string[]; files?: Record<string, string>; env?: Record<string, string>; outputs?: Record<string, { code: number; out: string }>;
  uinput?: ReturnType<NonNullable<P["uinput"]>>; sockets?: Record<string, "ok" | "denied">; service?: { installed: boolean; running: boolean; kind?: string }; addresses?: string[]; asService?: boolean;
} = {}) {
  const calls: string[][] = [];
  const tools = o.tools ?? ["xdotool", "playerctl", "pactl", "paplay"];
  const files = { "/etc/os-release": UBUNTU, ...(o.files ?? {}) };
  const p: P = {
    platform: "linux", exe: EXE, program: [EXE], version: "nookdeck 1.2.3", asService: o.asService ?? true,
    run: async (argv) => { calls.push(argv); return o.outputs?.[argv.slice(0, 2).join(" ")] ?? o.outputs?.[argv[0]!] ?? { code: 1, out: "" }; },
    axTrusted: () => { throw new Error("no macOS probe on Linux"); },
    automation: () => { throw new Error("no macOS probe on Linux"); },
    requestAccessibility: () => null, requestAutomation: () => "unknown",
    nowPlaying: async () => { throw new Error("no macOS probe on Linux"); },
    installed: () => false,
    which: (n) => (tools.includes(n) ? `/usr/bin/${n}` : null),
    hookFiles: () => ({}),
    desktop: () => ({ station: null, idle: null }), helperPing: async () => false,
    fileExists: (f) => f in files,
    claudeCredentialsFile: () => "/home/me/.claude/.credentials.json",
    env: o.env ?? X11,
    readText: (f) => files[f] ?? null,
    uinput: () => o.uinput ?? { ok: true },
    socket: (path) => o.sockets?.[path] ?? "missing",
    serviceStatus: async () => o.service ?? { installed: true, running: true, kind: "systemd" },
    addresses: () => o.addresses ?? ["192.168.1.20"],
  };
  return { p, calls };
}
const INST = { port: 7420, home: "/home/me/.nookdeck" };
const doctor = async (o: Parameters<typeof probes>[0] = {}, ctx: Partial<import("../src/doctor").DoctorCtx> = {}) => {
  const k = probes(o);
  const r = await D.runDoctor(k.p, { instance: INST, ...ctx });
  return { r, calls: k.calls, item: (id: string) => r.items.find((i) => i.id === id)! };
};

describe("os-release and install commands", () => {
  test("parsed once; apt on Debian and Ubuntu, dnf on Fedora, words elsewhere", () => {
    const u = D.parseOsRelease(UBUNTU);
    expect(u).toEqual({ id: "ubuntu", versionId: "24.04", like: ["debian"], name: "Ubuntu 24.04.1 LTS" });
    expect(D.parseOsRelease(DEBIAN)).toMatchObject({ id: "debian", versionId: "12", name: "Debian GNU/Linux 12 (bookworm)" });
    expect(D.parseOsRelease(null)).toMatchObject({ id: "", name: "Linux" });
    expect(D.installCommand(u, "ydotool")).toBe("sudo apt install ydotool");
    expect(D.installCommand(D.parseOsRelease('ID=linuxmint\nID_LIKE="ubuntu debian"'), "playerctl")).toBe("sudo apt install playerctl");
    expect(D.installCommand(D.parseOsRelease("ID=fedora"), "libsecret-tools")).toBe("sudo dnf install libsecret");
    expect(D.installCommand(D.parseOsRelease("ID=arch"), "xdotool")).toContain("xdotool");
  });
  test("the /dev/uinput fix: load the module, join the group that may write it, or a udev rule plus the input group", () => {
    expect(D.uinputFix({ why: "missing" }, null)).toBe("sudo modprobe uinput && echo uinput | sudo tee /etc/modules-load.d/uinput.conf");
    expect(D.uinputFix({ why: "permission", gid: 104, groupWritable: true }, "root:x:0:\ninput:x:104:\n")).toBe('sudo usermod -aG input "$USER"');
    const rule = D.uinputFix({ why: "permission", gid: 0, groupWritable: false }, "root:x:0:\n");
    expect(rule).toContain(`KERNEL=="uinput", GROUP="input", MODE="0660"`);
    expect(rule).toContain("/etc/udev/rules.d/");
    expect(rule).toEndWith('sudo usermod -aG input "$USER"');
  });
});

describe("the Linux doctor", () => {
  test("a fine X11 desktop: every Linux item, no macOS item, no macOS probe", async () => {
    const { r } = await doctor({ files: { "/home/me/.claude/.credentials.json": "{}" } }, { claude: { ok: true } });
    expect(r.platform).toBe("linux");
    expect(r.items.map((i) => i.id)).toEqual(["agent", "service", "desktop-session", "input", "media", "volume", "sound", "firewall", "network", "keychain-claude", "hooks-claude", "hooks-codex"]);
    for (const mac of ["signature", "accessibility", "automation-music", "automation-spotify", "now-playing", "local-network", "keychain-hass"]) expect(r.items.some((i) => i.id === mac)).toBe(false);
    expect(r.items.filter((i) => i.status !== "ok" && !i.id.startsWith("hooks-"))).toEqual([]);
    expect(r.items[0]!.detail).toContain("Ubuntu 24.04.1 LTS");
    const text = D.formatReport(r);
    expect(text).toContain("X11 · ubuntu:GNOME");
    expect(text).toContain("xdotool on X11");
    expect(text).toContain("Everything that can be checked looks fine.");
    expect(text).not.toContain("—");
  });
  test("service: systemd running, installed but stopped, autostart, not installed", async () => {
    expect((await doctor()).item("service")).toMatchObject({ status: "ok", detail: expect.stringContaining("systemd user service") });
    expect((await doctor({ service: { installed: true, running: false, kind: "systemd" }, asService: false })).item("service")).toMatchObject({ status: "missing", fix: { text: expect.stringContaining("nookdeck service start") } });
    expect((await doctor({ service: { installed: true, running: true, kind: "autostart" } })).item("service").detail).toContain("autostart");
    expect((await doctor({ service: { installed: false, running: false }, asService: false })).item("service")).toMatchObject({ status: "n/a", fix: { text: expect.stringContaining("nookdeck service install") } });
  });
  test("no graphical session (ssh, a server): the session is unknown and input is not checked", async () => {
    const { item } = await doctor({ env: {} });
    expect(item("desktop-session")).toMatchObject({ status: "unknown", fix: { text: expect.stringContaining("nookdeck service install") } });
    expect(item("input").status).toBe("n/a");
  });
  test("input: a missing tool names the package with apt; X11 needs xdotool, GNOME Wayland ydotool", async () => {
    const x = (await doctor({ tools: ["playerctl", "pactl", "paplay"] })).item("input");
    expect(x).toMatchObject({ status: "missing", fix: { text: "sudo apt install xdotool" } });
    const w = (await doctor({ env: WAYLAND, tools: ["xdotool"], files: { "/etc/os-release": DEBIAN } })).item("input");
    expect(w).toMatchObject({ status: "missing", fix: { text: "sudo apt install ydotool" } });
    expect(w.detail).toContain("Wayland");
  });
  test("ydotool 1.x: the socket the client uses decides (YDOTOOL_SOCKET, else $XDG_RUNTIME_DIR, else /tmp); /dev/uinput is not asked", async () => {
    expect(D.ydotoolSocket({ YDOTOOL_SOCKET: "/s/y", XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/s/y");
    expect(D.ydotoolSocket({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/.ydotool_socket");
    expect(D.ydotoolSocket({})).toBe("/tmp/.ydotool_socket");
    const W = { ...WAYLAND, XDG_RUNTIME_DIR: "/run/user/1000" };
    const help = { "ydotool help": { code: 0, out: YDO_1 } };
    // a daemon this user can reach: fine even though /dev/uinput is root-only (a root ydotoold)
    const ok = await doctor({ env: W, tools: ["ydotool"], outputs: help, sockets: { "/run/user/1000/.ydotool_socket": "ok" }, uinput: { ok: false, why: "permission", gid: 0, groupWritable: false } });
    expect(ok.item("input")).toMatchObject({ status: "ok", detail: "ydotool 1.x on Wayland, ydotoold answers at /run/user/1000/.ydotool_socket" });
    expect(ok.calls.some((c) => c[0] === "pgrep")).toBe(false);
    // the socket exists but is root's (default 0600)
    const denied = (await doctor({ env: W, tools: ["ydotool"], outputs: help, sockets: { "/run/user/1000/.ydotool_socket": "denied" } })).item("input");
    expect(denied).toMatchObject({ status: "missing", fix: { text: expect.stringContaining("--socket-own=$(id -u):$(id -g)") } });
    // a root daemon on /tmp while the client looks in XDG_RUNTIME_DIR
    const elsewhere = (await doctor({ env: W, tools: ["ydotool"], outputs: help, sockets: { "/tmp/.ydotool_socket": "denied" } })).item("input");
    expect(elsewhere.detail).toContain("listens at /tmp/.ydotool_socket, but ydotool looks for /run/user/1000/.ydotool_socket");
    // YDOTOOL_SOCKET pointing at the /tmp daemon is fine
    expect((await doctor({ env: { ...W, YDOTOOL_SOCKET: "/tmp/.ydotool_socket" }, tools: ["ydotool"], outputs: help, sockets: { "/tmp/.ydotool_socket": "ok" } })).item("input").status).toBe("ok");
    // no daemon: a user daemon needs /dev/uinput first, then it has to be started (the unit Debian's 1.x package ships is ydotool.service)
    const noDev = (await doctor({ env: W, tools: ["ydotool"], outputs: help, uinput: { ok: false, why: "permission", gid: 0, groupWritable: false } })).item("input");
    expect(noDev.detail).toContain("/dev/uinput is not writable");
    const noDaemon = await doctor({ env: W, tools: ["ydotool"], outputs: help });
    expect(noDaemon.item("input")).toMatchObject({ status: "missing", detail: "ydotool 1.x on Wayland: the ydotoold daemon is not running", fix: { text: expect.stringContaining("systemctl --user enable --now ydotool") } });
  });
  test("ydotool 0.1.x (Debian 12, Ubuntu 22.04) needs no daemon; /dev/uinput not writable shows the command, never runs it", async () => {
    const { item, calls } = await doctor({
      env: WAYLAND, tools: ["ydotool"], files: { "/etc/os-release": DEBIAN, "/etc/group": "root:x:0:\n" },
      outputs: { "ydotool help": { code: 0, out: YDO_01 } }, uinput: { ok: false, why: "permission", gid: 0, groupWritable: false },
    });
    const i = item("input");
    expect(i.status).toBe("missing");
    expect(i.detail).toContain("ydotool 0.1.x");
    expect(i.fix!.text).toContain("Debian GNU/Linux 12 (bookworm)");
    expect(i.fix!.text).toContain('GROUP="input"');
    expect(calls.some((c) => c[0] === "sudo" || c.includes("usermod") || c[0] === "udevadm")).toBe(false);
    expect(calls.some((c) => c[0] === "pgrep")).toBe(false);
    const missing = (await doctor({ env: WAYLAND, tools: ["ydotool"], outputs: { "ydotool help": { code: 0, out: YDO_01 } }, uinput: { ok: false, why: "missing" } })).item("input");
    expect(missing.fix!.text).toContain("sudo modprobe uinput");
  });
  test("media, volume and sound name their package when missing", async () => {
    const { item } = await doctor({ tools: ["xdotool", "aplay"] });
    expect(item("media")).toMatchObject({ status: "missing", fix: { text: "sudo apt install playerctl" } });
    expect(item("volume")).toMatchObject({ status: "missing", fix: { text: "sudo apt install pulseaudio-utils" } });
    expect(item("sound")).toMatchObject({ status: "ok", detail: expect.stringContaining("aplay") });
  });
  test("firewall: no ufw or ufw off is fine; on and readable checks the port; on and unreadable shows `ufw allow`; never runs allow", async () => {
    expect((await doctor()).item("firewall")).toMatchObject({ status: "ok" });
    expect((await doctor({ tools: ["xdotool", "ufw"], files: { "/etc/ufw/ufw.conf": "ENABLED=no\n" } })).item("firewall").detail).toContain("off");
    const on = { tools: ["xdotool", "playerctl", "pactl", "paplay", "ufw"], files: { "/etc/ufw/ufw.conf": "# comment\nENABLED=yes\n" } };
    const allowed = await doctor({ ...on, outputs: { "ufw status": { code: 0, out: "Status: active\n\nTo   Action  From\n7420/tcp   ALLOW   Anywhere\n" } } });
    expect(allowed.item("firewall").status).toBe("ok");
    const blocked = await doctor({ ...on, outputs: { "ufw status": { code: 0, out: "Status: active\n\nTo   Action  From\n22/tcp   ALLOW   Anywhere\n" } } });
    const st = (rules: string) => ({ ...on, outputs: { "ufw status": { code: 0, out: `Status: active\n\nTo   Action  From\n--   ------  ----\n${rules}\n` } } });
    // udp only does not open the agent's tcp port; 74200 is not 7420
    expect((await doctor(st("7420/udp   ALLOW   Anywhere"))).item("firewall").status).toBe("denied");
    expect((await doctor(st("74200/tcp   ALLOW   Anywhere"))).item("firewall").status).toBe("denied");
    // both protocols, v6, and a rule that opens every port to the LAN
    expect((await doctor(st("7420   ALLOW   Anywhere"))).item("firewall").status).toBe("ok");
    expect((await doctor(st("7420/tcp (v6)   ALLOW   Anywhere (v6)"))).item("firewall").status).toBe("ok");
    expect((await doctor(st("Anywhere   ALLOW   192.168.1.0/24"))).item("firewall").status).toBe("ok");
    expect((await doctor(st("Anywhere   DENY   10.0.0.5"))).item("firewall").status).toBe("denied");
    expect(blocked.item("firewall")).toMatchObject({ status: "denied", fix: { text: expect.stringContaining("sudo ufw allow 7420/tcp") } });
    const unreadable = await doctor({ ...on, outputs: { "ufw status": { code: 1, out: "ERROR: You need to be root to run this script" } } });
    expect(unreadable.item("firewall")).toMatchObject({ status: "unknown", fix: { text: expect.stringContaining("sudo ufw allow 7420/tcp") } });
    for (const c of [...blocked.calls, ...unreadable.calls]) expect(c.includes("allow")).toBe(false);
    expect((await D.runDoctor(probes({ ...on, outputs: { "ufw status": { code: 1, out: "" } } }).p, { instance: { ...INST, port: 7510 } })).items.find((i) => i.id === "firewall")!.fix!.text).toContain("7510/tcp");
  });
  test("network and Claude sign-in", async () => {
    expect((await doctor({ addresses: [] })).item("network").status).toBe("missing");
    expect((await doctor()).item("keychain-claude")).toMatchObject({ status: "missing", fix: { text: "Sign in to Claude Code on this computer." } });
  });
  test("Vietnamese and Chinese: every Linux doctor text has a translation", async () => {
    for (const lang of ["vi", "zh"] as const) {
      I.setLanguage(lang);
      const { r } = await doctor({ tools: [], env: WAYLAND });
      const text = D.formatReport(r);
      expect(text).not.toContain("Key presses and typing");
      expect(text).not.toContain("not found:");
    }
    I.setLanguage("en");
  });
});
