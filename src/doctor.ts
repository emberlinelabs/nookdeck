import { userHome } from "./home";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";

import { join, posix } from "node:path";
import { t } from "./i18n";
import { platform as osPlatform } from "./platform";
import { idleSeconds as winIdle, windowStation as winStation } from "./platform/win32/ffi";
import { SERVICE_LABEL, commandInstance, defaultProgram, hookTargets, repointCommand, sameInstance, type Instance } from "./service";
import { HOOK_EVENT, ASK_EVENT, HOOK_MARKER, ASK_MARKER, type HookTool } from "./hooks-install";
import { readFile } from "node:fs/promises";
import type { HassStatus } from "./hass/client";

/**
 * `nookdeck doctor`: what macOS lets Nookdeck do. TCC attributes a permission to the RESPONSIBLE process: the nookdeck
 * binary under the LaunchAgent, the terminal app when started from a terminal. So these checks must run inside the
 * running agent (GET /api/doctor). Nothing here ever triggers a permission prompt, except `request()` which the user asks for.
 */
export type DoctorStatus = "ok" | "missing" | "denied" | "unknown" | "n/a";
export interface DoctorItem {
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
  fix?: { text: string; settingsUrl?: string };
}
export interface DoctorReport {
  version: string;
  exe: string;
  asService: boolean;
  platform: string;
  items: DoctorItem[];
}

export type AutomationState = "granted" | "denied" | "not-asked" | "not-running" | "unknown";

export interface Probes {
  platform: NodeJS.Platform;
  exe: string;
  /** What our hook commands should run: [exe] for the compiled binary, [bun, index.ts] from source. */
  program: string[];
  version: string;
  /** Started by launchd as dev.nookdeck.agent (so macOS attributes permissions to the nookdeck binary). */
  asService: boolean;
  /** Runs a command and returns its exit code and stdout+stderr. Never throws. */
  run(argv: string[]): Promise<{ code: number; out: string }>;
  /** AXIsProcessTrusted(): null when it cannot be asked. */
  axTrusted(): boolean | null | Promise<boolean | null>;
  /** AEDeterminePermissionToAutomateTarget(askUserIfNeeded=false). Async and bounded: the real one asks a short-lived child, because the call can block for good. */
  automation(bundleId: string): AutomationState | Promise<AutomationState>;
  /** The prompting variants, only for an explicit request: AXIsProcessTrustedWithOptions(prompt) / AEDetermine...(ask=true). */
  requestAccessibility(): boolean | null | Promise<boolean | null>;
  requestAutomation(bundleId: string): AutomationState | Promise<AutomationState>;
  /** Can the Now Playing of every app be read (the bundled mediaremote adapter)? */
  nowPlaying(): Promise<{ ok: boolean; why?: string }>;
  installed(bundleId: string): boolean;
  which(name: string): string | null;
  hookFiles(): Partial<Record<HookTool, string>>;
  /** Windows: the window station of this process ("WinSta0" = the interactive desktop) and seconds since the last input. */
  desktop(): { station: string | null; idle: number | null };
  /** Windows: does the PowerShell helper answer? */
  helperPing(): Promise<boolean>;
  fileExists(path: string): boolean;
  claudeCredentialsFile(): string;
  /** Linux: the environment (session type, display), a file's text (/etc/os-release, /etc/ufw/ufw.conf) or null, whether a device can be written, the service, the LAN addresses. */
  env?: Record<string, string | undefined>;
  readText?(path: string): string | null;
  /** Linux: can this user write /dev/uinput (ydotool)? readUinputAccess() of src/platform/linux-input.ts. */
  uinput?(): { ok: boolean; why?: "missing" | "permission"; gid?: number; groupWritable?: boolean };
  /** Linux: a unix socket this user can write ("ok"), one it cannot ("denied"), or none ("missing"). The ydotoold socket. */
  socket?(path: string): "ok" | "denied" | "missing";
  serviceStatus?(): Promise<{ installed: boolean; running: boolean; kind?: string }>;
  addresses?(): string[];
}

export interface DoctorCtx {
  /** The agent's Home Assistant client status (undefined: not available). */
  hass?: HassStatus | null;
  /** Result of the last Claude usage read: ok, or why not. */
  claude?: { ok: boolean; error?: string; pending?: boolean } | null;
  instance: Instance;
}

const SETTINGS = (pane: string) => `x-apple.systempreferences:com.apple.preference.security?${pane}`;
export const PANES = {
  accessibility: SETTINGS("Privacy_Accessibility"),
  automation: SETTINGS("Privacy_Automation"),
  localNetwork: SETTINGS("Privacy_LocalNetwork"),
  firewall: "x-apple.systempreferences:com.apple.Network-Settings.extension?Firewall",
} as const;

export const AUTOMATION_TARGETS = [
  // Keys, typing and volume are native calls now: System Events is no longer used, so it is not checked. Only Now Playing needs Automation.
  { id: "automation-music", name: "Music", bundle: "com.apple.Music" },
  { id: "automation-spotify", name: "Spotify", bundle: "com.spotify.client" },
] as const;

const who = (p: Probes) => (p.asService ? t("the nookdeck program") : t("the terminal app you started Nookdeck from"));

/** True when this build is signed ad hoc (its designated requirement is a cdhash, not a certificate): Accessibility resets on update. */
async function adhocBuild(p: Probes): Promise<boolean> {
  const r = await p.run(["codesign", "-d", "-r-", p.exe]);
  return /designated/.test(r.out) && !/certificate (leaf|root)|anchor apple/.test(r.out);
}

async function accessibility(p: Probes): Promise<DoctorItem> {
  const title = t("Accessibility");
  if (p.platform !== "darwin") return { id: "accessibility", title, status: "n/a", detail: t("macOS only") };
  const ok = await p.axTrusted();
  if (ok === null) return { id: "accessibility", title, status: "unknown", detail: t("macOS did not answer") };
  if (ok) return { id: "accessibility", title, status: "ok", detail: t("granted to {who}", { who: who(p) }) };
  const adhoc = p.asService && (await adhocBuild(p));
  return {
    id: "accessibility", title, status: "missing", detail: t("not granted to {who}: key press and typing tiles will not work", { who: who(p) }),
    fix: { text: t("Open System Settings > Privacy & Security > Accessibility and turn {who} on. Run `nookdeck doctor --request accessibility` to make it appear in the list.", { who: p.asService ? "nookdeck" : t("your terminal app") }) + (adhoc ? " " + t("This is an ad-hoc build: Accessibility resets on every update.") : ""), settingsUrl: PANES.accessibility },
  };
}

async function automation(p: Probes, tg: (typeof AUTOMATION_TARGETS)[number]): Promise<DoctorItem> {
  const title = t("Automation: {app}", { app: tg.name });
  if (p.platform !== "darwin") return { id: tg.id, title, status: "n/a", detail: t("macOS only") };
  if (!p.installed(tg.bundle)) return { id: tg.id, title, status: "n/a", detail: t("{app} is not installed", { app: tg.name }) };
  const s = await p.automation(tg.bundle);
  const fix = { text: t("Open System Settings > Privacy & Security > Automation and allow {who} to control {app}.", { who: p.asService ? "nookdeck" : t("your terminal app"), app: tg.name }), settingsUrl: PANES.automation };
  switch (s) {
    case "granted": return { id: tg.id, title, status: "ok", detail: t("allowed: nookdeck itself reads {app} for Now Playing", { app: tg.name }) };
    case "denied": return { id: tg.id, title, status: "denied", detail: t("denied: Now Playing for {app} will not work", { app: tg.name }), fix };
    case "not-asked": return { id: tg.id, title, status: "missing", detail: t("not asked yet: macOS asks the first time a tile needs it"), fix: { ...fix, text: t("Press a tile that uses {app}, or run `nookdeck doctor --request {id}`, then click Allow.", { app: tg.name, id: tg.id }) } };
    case "not-running": return { id: tg.id, title, status: "unknown", detail: t("{app} is not running, so macOS cannot say; open it and run the check again", { app: tg.name }) };
    default: return { id: tg.id, title, status: "unknown", detail: t("macOS did not answer") };
  }
}

async function nowPlayingAll(p: Probes): Promise<DoctorItem> {
  const title = t("Now Playing (all apps)");
  if (p.platform !== "darwin") return { id: "now-playing", title, status: "n/a", detail: t("macOS only") };
  const r = await p.nowPlaying().catch(() => ({ ok: false, why: t("the check failed") }));
  if (r.ok) return { id: "now-playing", title, status: "ok", detail: t("reads what Safari, Chrome, YouTube, Spotify, Music and other apps play") };
  return {
    id: "now-playing", title, status: "missing", detail: t("only Spotify and Music can be read: {why}", { why: r.why ?? "?" }),
    fix: { text: t("Update nookdeck (`nookdeck update`); if it persists, check that /usr/bin/perl exists and report it.") },
  };
}

async function keychainClaude(p: Probes, ctx: DoctorCtx): Promise<DoctorItem> {
  const title = t("Keychain: Claude Code sign-in");
  if (p.platform !== "darwin") return { id: "keychain-claude", title, status: "n/a", detail: t("macOS only") };
  // no -w: only asks whether the item exists, so this never reads the secret and never prompts
  const r = await p.run(["security", "find-generic-password", "-s", "Claude Code-credentials"]);
  if (r.code !== 0) return { id: "keychain-claude", title, status: "missing", detail: t("no Claude Code sign-in found (the quota tile stays empty)"), fix: { text: t("Sign in to Claude Code on this Mac.") } };
  if (!ctx.claude) return { id: "keychain-claude", title, status: "unknown", detail: t("the item exists; not read yet") };
  if (ctx.claude.pending) return { id: "keychain-claude", title, status: "unknown", detail: t("checking…") };
  if (ctx.claude.ok) return { id: "keychain-claude", title, status: "ok", detail: t("the item exists and the last read worked") };
  // a rate limit (or another answer from Claude's server) means the Keychain read itself worked: not a permission problem
  if (/rate.?limit|\b429\b/i.test(ctx.claude.error ?? "")) return { id: "keychain-claude", title, status: "ok", detail: t("the sign-in is readable; Claude is rate limiting the quota check, it retries later") };
  return { id: "keychain-claude", title, status: "denied", detail: t("the item exists but the last read failed: {why}", { why: ctx.claude.error ?? "?" }), fix: { text: t("If macOS asked to access the Keychain, choose Always Allow. Otherwise sign in to Claude Code again.") } };
}

function keychainHass(p: Probes, ctx: DoctorCtx): DoctorItem {
  const title = t("Keychain: Home Assistant token");
  const h = ctx.hass;
  if (!h || !h.url) return { id: "keychain-hass", title, status: "n/a", detail: t("Home Assistant is not set up") };
  if (h.hasToken) return { id: "keychain-hass", title, status: "ok", detail: t("the token is readable") };
  return { id: "keychain-hass", title, status: "missing", detail: t("a URL is set but the token cannot be read"), fix: { text: t("Enter the token again on the management page (Integrations > Home Assistant).") } };
}

const UNREACHABLE = /EHOSTUNREACH|EHOSTDOWN|No route to host|Host is down/i;
function localNetwork(p: Probes, ctx: DoctorCtx): DoctorItem {
  const title = t("Local Network");
  const h = ctx.hass;
  if (p.platform !== "darwin") return { id: "local-network", title, status: "n/a", detail: t("macOS only") };
  if (!h || !h.url) return { id: "local-network", title, status: "n/a", detail: t("no device on your network is used (Home Assistant is not set up)") };
  if (h.connected) return { id: "local-network", title, status: "ok", detail: t("the last Home Assistant connection worked") };
  const why = `${h.detail ?? ""} ${h.error ?? ""}`;
  if (UNREACHABLE.test(why)) return {
    id: "local-network", title, status: "denied", detail: t("Home Assistant is unreachable ({why}): macOS may be blocking Local Network access", { why: (h.detail || h.error || "").slice(0, 80) }),
    fix: { text: t("Open System Settings > Privacy & Security > Local Network and turn {who} on.", { who: p.asService ? "nookdeck" : t("your terminal app") }), settingsUrl: PANES.localNetwork },
  };
  return { id: "local-network", title, status: "unknown", detail: t("the last Home Assistant connection failed: {why}", { why: (h.error ?? "?").slice(0, 100) }) };
}

async function firewall(p: Probes): Promise<DoctorItem> {
  const title = t("Firewall");
  if (p.platform !== "darwin") return { id: "firewall", title, status: "n/a", detail: t("macOS only") };
  const fw = "/usr/libexec/ApplicationFirewall/socketfilterfw";
  const g = await p.run([fw, "--getglobalstate"]);
  if (g.code !== 0) return { id: "firewall", title, status: "unknown", detail: t("could not read the firewall state") };
  if (!/enabled|State = [12]/i.test(g.out) || /disabled|State = 0/i.test(g.out)) return { id: "firewall", title, status: "ok", detail: t("the macOS firewall is off: phones can connect") };
  const a = await p.run([fw, "--getappblocked", p.exe]);
  if (/permitted|allowed/i.test(a.out) && !/not part|blocked/i.test(a.out)) return { id: "firewall", title, status: "ok", detail: t("the firewall is on and allows incoming connections to nookdeck") };
  if (/block/i.test(a.out) && !/not part/i.test(a.out)) return {
    id: "firewall", title, status: "denied", detail: t("the firewall is on and blocks incoming connections to nookdeck: phones cannot connect"),
    fix: { text: t("Open System Settings > Network > Firewall > Options and allow incoming connections for nookdeck."), settingsUrl: PANES.firewall },
  };
  return { id: "firewall", title, status: "unknown", detail: t("the firewall is on and nookdeck is not in its list: macOS asks to allow incoming connections the first time a phone connects"), fix: { text: t("Click Allow when macOS asks, or add nookdeck under Firewall > Options."), settingsUrl: PANES.firewall } };
}

async function signature(p: Probes): Promise<DoctorItem> {
  const title = t("Code signature");
  if (p.platform !== "darwin") return { id: "signature", title, status: "n/a", detail: t("macOS only") };
  const r = await p.run(["codesign", "-dv", "--verbose=2", p.exe]);
  if (/Signature=adhoc|flags=0x[0-9a-f]*\(adhoc/i.test(r.out)) return {
    id: "signature", title, status: "ok", detail: t("ad-hoc signed: macOS asks for permissions again after every update"),
    fix: { text: t("After an update, remove the old nookdeck entries in the Privacy lists and add it again (this goes away with Developer ID signing).") },
  };
  const auth = /Authority=(Developer ID Application:[^\n]+)/.exec(r.out)?.[1];
  if (auth) return { id: "signature", title, status: "ok", detail: t("signed by {who}", { who: auth }) };
  if (r.code !== 0) return { id: "signature", title, status: "unknown", detail: t("not signed or unreadable ({exe})", { exe: p.exe }) };
  return { id: "signature", title, status: "ok", detail: t("signed") };
}

async function hooks(p: Probes, ctx: DoctorCtx): Promise<DoctorItem[]> {
  const out: DoctorItem[] = [];
  const files = p.hookFiles();
  for (const tool of ["claude", "codex"] as const) {
    const id = `hooks-${tool}`;
    const title = t("{tool} hooks", { tool: tool === "claude" ? "Claude Code" : "Codex" });
    const file = files[tool];
    if (!file) { out.push({ id, title, status: "n/a", detail: t("not checked (sandboxed NOOKDECK_HOME)") }); continue; }
    let data: any;
    try { data = JSON.parse(await readFile(file, "utf8")); } catch { out.push({ id, title, status: "n/a", detail: t("not installed") }); continue; }
    const mine: string[] = [];
    for (const [event, marker] of [[HOOK_EVENT, HOOK_MARKER], [ASK_EVENT, ASK_MARKER]] as const)
      for (const g of Array.isArray(data?.hooks?.[event]) ? data.hooks[event] : [])
        for (const h of Array.isArray(g?.hooks) ? g.hooks : [])
          if (typeof h?.command === "string" && h.command.includes(marker) && sameInstance(commandInstance(h.command), ctx.instance)) mine.push(h.command);
    if (!mine.length) { out.push({ id, title, status: "n/a", detail: t("not installed") }); continue; }
    const stale = mine.filter((c) => repointCommand(c, p.program) !== null);
    out.push(stale.length
      ? { id, title, status: "missing", detail: t("installed, but {n} hook(s) point at another program", { n: stale.length }), fix: { text: t("Run `nookdeck hooks repoint` (an update does this for you).") } }
      : { id, title, status: "ok", detail: t("installed and pointing at this program") });
  }
  return out;
}

async function runWindows(p: Probes, ctx: DoctorCtx): Promise<DoctorReport> {
  const W = await import("./platform/win32/doctor");
  const items: DoctorItem[] = [{ id: "agent", title: t("Nookdeck"), status: "ok", detail: `${p.version} · ${p.exe}` }];
  // every probe is bounded (see realProbes.run / helperPing) and they run side by side: the whole check takes as long as the slowest one
  const [startup, signature, smartscreen, helper, claude, [network, firewall], hookItems] = await Promise.all([
    W.startup(p), W.signature(p), W.smartscreen(p), W.helper(p), W.claudeSignIn(p, ctx), W.networkAndFirewall(p), hooks(p, ctx),
  ]);
  items.push(startup, signature, smartscreen, W.desktopSession(p), helper, claude, W.haToken(ctx), network, firewall, ...hookItems);
  return { version: p.version, exe: p.exe, asService: p.asService, platform: p.platform, items };
}

// ---------- Linux (L4 and L9 of specs/linux-support) ----------

export interface OsRelease { id: string; versionId: string; like: string[]; name: string }

/** /etc/os-release: ID, VERSION_ID, ID_LIKE and PRETTY_NAME (quotes removed). */
export function parseOsRelease(text: string | null): OsRelease {
  const kv: Record<string, string> = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) kv[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return { id: (kv.ID ?? "").toLowerCase(), versionId: kv.VERSION_ID ?? "", like: (kv.ID_LIKE ?? "").toLowerCase().split(/\s+/).filter(Boolean), name: kv.PRETTY_NAME ?? kv.NAME ?? "Linux" };
}

const isDebianLike = (o: OsRelease) => o.id === "debian" || o.id === "ubuntu" || o.like.includes("debian") || o.like.includes("ubuntu");
const isFedoraLike = (o: OsRelease) => o.id === "fedora" || o.like.includes("fedora") || o.like.includes("rhel");

/** The install command for a package, by distribution; the package names are Debian's, Fedora's where they differ. */
export function installCommand(o: OsRelease, pkg: string): string {
  if (isDebianLike(o)) return `sudo apt install ${pkg}`;
  const fedora: Record<string, string> = { "pulseaudio-utils": "pulseaudio-utils", "libsecret-tools": "libsecret", "alsa-utils": "alsa-utils" };
  if (isFedoraLike(o)) return `sudo dnf install ${fedora[pkg] ?? pkg}`;
  return t("install the {pkg} package with your package manager", { pkg });
}

/**
 * The commands that let this user write /dev/uinput (ydotool). Shown, never run by Nookdeck.
 * - no device: load the module now and at every boot;
 * - a group may write it (Ubuntu and Debian with an `input` rule): the user joins that group;
 * - only root may (the default on Debian 12 and Ubuntu 22.04): a udev rule gives it to `input`, then the user joins it.
 */
export function uinputFix(a: { why?: "missing" | "permission"; gid?: number; groupWritable?: boolean }, groupFile: string | null): string {
  if (a.why === "missing") return "sudo modprobe uinput && echo uinput | sudo tee /etc/modules-load.d/uinput.conf";
  const group = a.groupWritable && a.gid !== undefined && a.gid !== 0 ? (groupFile ?? "").split("\n").map((l) => l.split(":")).find((x) => Number(x[2]) === a.gid)?.[0] : undefined;
  if (group) return `sudo usermod -aG ${group} "$USER"`;
  return `echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/60-nookdeck-uinput.rules && sudo udevadm control --reload-rules && sudo udevadm trigger --name-match=uinput && sudo usermod -aG input "$USER"`;
}

/** no /dev/uinput, or no way to look */
const UINPUT_MISSING = "missing" as const;
const NO_UINPUT = { ok: false, why: UINPUT_MISSING };

async function linuxService(p: Probes): Promise<DoctorItem> {
  const title = t("Background service");
  const s = await p.serviceStatus?.().catch(() => null);
  if (s?.installed && s.kind === "autostart") return { id: "service", title, status: s.running || p.asService ? "ok" : "unknown", detail: s.running || p.asService ? t("started at login by the XDG autostart entry (no systemd user session)") : t("the XDG autostart entry is installed but the agent it starts is not running"), ...(s.running || p.asService ? {} : { fix: { text: t("Run `nookdeck service start`.") } }) };
  if (s?.installed) return s.running || p.asService
    ? { id: "service", title, status: "ok", detail: t("running as the systemd user service (starts with your desktop session)") }
    : { id: "service", title, status: "missing", detail: t("the systemd user service is installed but not running"), fix: { text: t("Run `nookdeck service start`, or `journalctl --user -u nookdeck` and ~/.nookdeck/logs/agent.err.log to see why it stopped.") } };
  return { id: "service", title, status: "n/a", detail: t("not set to start at login (started from a terminal)"), fix: { text: t("Run `nookdeck service install` to start Nookdeck with your desktop session.") } };
}

function linuxSessionItem(p: Probes, env: Record<string, string | undefined>, session: string): DoctorItem {
  const title = t("Desktop session");
  const desktop = env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || "";
  if (session === "x11" || session === "wayland") return { id: "desktop-session", title, status: "ok", detail: `${session === "x11" ? "X11" : "Wayland"}${desktop ? ` · ${desktop}` : ""}` };
  return {
    id: "desktop-session", title, status: "unknown", detail: t("no graphical session found (no DISPLAY or WAYLAND_DISPLAY): key presses and typing cannot reach a desktop"),
    fix: { text: t("Start Nookdeck from your desktop session: `nookdeck service install` starts it with the desktop.") },
  };
}

const YDOTOOL_TMP_SOCKET = "/tmp/.ydotool_socket";
/** Where the ydotool 1.x client looks for ydotoold (its own order): $YDOTOOL_SOCKET, else $XDG_RUNTIME_DIR/.ydotool_socket, else /tmp. */
export const ydotoolSocket = (env: Record<string, string | undefined>): string =>
  env.YDOTOOL_SOCKET || (env.XDG_RUNTIME_DIR ? posix.join(env.XDG_RUNTIME_DIR, ".ydotool_socket") : YDOTOOL_TMP_SOCKET);

async function linuxInput(p: Probes, os: OsRelease, env: Record<string, string | undefined>): Promise<DoctorItem> {
  const { linuxInputBackend, ydotoolGeneration } = await import("./platform/linux-input");
  const title = t("Key presses and typing");
  const b = linuxInputBackend(env, (n) => p.which(n));
  if (b.session === "unknown") return { id: "input", title, status: "n/a", detail: t("no graphical session") };
  if (!b.kind) {
    const why = b.session === "wayland" ? t("on Wayland this needs {pkg}", { pkg: b.missing ?? "ydotool" }) : t("on X11 this needs {pkg}", { pkg: b.missing ?? "xdotool" });
    return { id: "input", title, status: "missing", detail: t("no input tool: hotkey and typing tiles will not work ({why})", { why }), fix: { text: installCommand(os, b.missing ?? "xdotool") } };
  }
  if (b.kind !== "ydotool") return { id: "input", title, status: "ok", detail: t("{tool} on {session}", { tool: b.kind, session: b.session === "x11" ? "X11" : "Wayland" }) };
  // 0.1.x writes /dev/uinput itself. In 1.x only the ydotoold daemon opens /dev/uinput and the client talks to its socket,
  // so a daemon this user can reach is enough (even one started as root); /dev/uinput only matters when the daemon is missing.
  const gen = ydotoolGeneration((await p.run(["ydotool", "help"])).out);
  const label = `ydotool ${gen === "1" ? "1.x" : "0.1.x"} on Wayland`;
  if (gen === "1") {
    const sock = ydotoolSocket(env);
    const s = p.socket?.(sock) ?? "missing";
    if (s === "ok") return { id: "input", title, status: "ok", detail: t("{tool}, ydotoold answers at {path}", { tool: label, path: sock }) };
    if (s === "denied") return {
      id: "input", title, status: "missing", detail: t("{tool}: ydotoold runs, but this user cannot write its socket {path} (a daemon started as root keeps it to root)", { tool: label, path: sock }),
      fix: { text: t("Run ydotoold as your user instead (`systemctl --user enable --now ydotool`), or start it with `--socket-own=$(id -u):$(id -g)`. Nookdeck never changes this itself.") },
    };
    if (sock !== YDOTOOL_TMP_SOCKET && (p.socket?.(YDOTOOL_TMP_SOCKET) ?? "missing") !== "missing") return {
      id: "input", title, status: "missing", detail: t("{tool}: ydotoold listens at {other}, but ydotool looks for {path}", { tool: label, other: YDOTOOL_TMP_SOCKET, path: sock }),
      fix: { text: t("Run ydotoold as your user (`systemctl --user enable --now ydotool`) so its socket is where ydotool looks. Nookdeck never changes this itself.") },
    };
  }
  const u = p.uinput?.() ?? NO_UINPUT;
  if (!u.ok && u.why === "missing") return {
    id: "input", title, status: "missing", detail: t("{tool}: there is no /dev/uinput (the uinput module is not loaded), so keys cannot be sent", { tool: label }),
    fix: { text: t("Load it now and at every start (Nookdeck never changes this itself): {cmd}", { cmd: uinputFix(u, null) }) },
  };
  if (!u.ok) return {
    id: "input", title, status: "missing", detail: t("{tool}: /dev/uinput is not writable for this user, so keys cannot be sent", { tool: label }),
    fix: { text: t("Let your user write /dev/uinput on {os} (Nookdeck never changes this itself), then log out and in: {cmd}", { os: os.name, cmd: uinputFix(u, p.readText?.("/etc/group") ?? null) }) },
  };
  if (gen === "1") return {
    id: "input", title, status: "missing", detail: t("{tool}: the ydotoold daemon is not running", { tool: label }),
    fix: { text: t("Start it for your user: `systemctl --user enable --now ydotool` when your package has that unit, otherwise run `ydotoold &` in your session.") },
  };
  return { id: "input", title, status: "ok", detail: t("{tool}, /dev/uinput is writable", { tool: label }) };
}

function linuxTool(p: Probes, os: OsRelease, id: string, title: string, tools: string[], pkg: string, works: string, lost: string): DoctorItem {
  const found = tools.find((x) => p.which(x));
  return found
    ? { id, title, status: "ok", detail: t("{tool}: {what}", { tool: found, what: works }) }
    : { id, title, status: "missing", detail: t("{tool} not found: {what}", { tool: tools.join(" / "), what: lost }), fix: { text: installCommand(os, pkg) } };
}

async function linuxFirewall(p: Probes, ctx: DoctorCtx): Promise<DoctorItem> {
  const title = t("Firewall");
  const port = ctx.instance.port;
  const allow = `sudo ufw allow ${port}/tcp`;
  if (!p.which("ufw") && !p.fileExists("/usr/sbin/ufw")) return { id: "firewall", title, status: "ok", detail: t("ufw is not installed: nothing blocks phones (another firewall is not checked)") };
  const conf = p.readText?.("/etc/ufw/ufw.conf") ?? "";
  if (!/^\s*ENABLED\s*=\s*yes/mi.test(conf)) return { id: "firewall", title, status: "ok", detail: t("ufw is off: phones can connect") };
  // `ufw status` needs root; read it when it answers (a root shell), otherwise say what to run
  const r = await p.run(["ufw", "status"]);
  if (r.code === 0 && /Status:\s*active/i.test(r.out)) {
    // this port (tcp or both protocols, not /udp), or a rule that opens every port to some source (`Anywhere  ALLOW  192.168.1.0/24`)
    const portRule = new RegExp(`^\\s*${port}(/tcp)?\\s.*\\bALLOW\\b`, "i");
    const everyPort = /^\s*Anywhere(\s+\(v6\))?\s+ALLOW\b/i;
    const open = r.out.split("\n").some((l) => portRule.test(l) || everyPort.test(l));
    return open
      ? { id: "firewall", title, status: "ok", detail: t("ufw is on and allows port {port}", { port }) }
      : { id: "firewall", title, status: "denied", detail: t("ufw is on and does not allow port {port}: phones cannot connect", { port }), fix: { text: t("Run (Nookdeck never changes the firewall itself): {cmd}", { cmd: allow }) } };
  }
  return { id: "firewall", title, status: "unknown", detail: t("ufw is on; its rules need root to read, so port {port} may be blocked", { port }), fix: { text: t("If your phone cannot connect, run (Nookdeck never changes the firewall itself): {cmd}", { cmd: allow }) } };
}

function linuxNetwork(p: Probes): DoctorItem {
  const title = t("Network");
  const a = p.addresses?.() ?? [];
  if (a.length) return { id: "network", title, status: "ok", detail: t("phones on your network can reach {addr}", { addr: a.slice(0, 3).join(", ") }) };
  return { id: "network", title, status: "missing", detail: t("no network address found: phones cannot reach this computer"), fix: { text: t("Connect to Wi-Fi or Ethernet on the same network as your phone.") } };
}

function linuxClaude(p: Probes, ctx: DoctorCtx): DoctorItem {
  const title = t("Claude Code sign-in");
  if (!p.fileExists(p.claudeCredentialsFile())) return { id: "keychain-claude", title, status: "missing", detail: t("no Claude Code sign-in found (the quota tile stays empty)"), fix: { text: t("Sign in to Claude Code on this computer.") } };
  if (!ctx.claude) return { id: "keychain-claude", title, status: "unknown", detail: t("the item exists; not read yet") };
  if (ctx.claude.pending) return { id: "keychain-claude", title, status: "unknown", detail: t("checking…") };
  if (ctx.claude.ok || /rate.?limit|\b429\b/i.test(ctx.claude.error ?? "")) return { id: "keychain-claude", title, status: "ok", detail: t("the item exists and the last read worked") };
  return { id: "keychain-claude", title, status: "denied", detail: t("the item exists but the last read failed: {why}", { why: ctx.claude.error ?? "?" }), fix: { text: t("Sign in to Claude Code again.") } };
}

async function runLinux(p: Probes, ctx: DoctorCtx): Promise<DoctorReport> {
  const { linuxSession } = await import("./platform/linux-input");
  const env = p.env ?? {};
  const os = parseOsRelease(p.readText?.("/etc/os-release") ?? null);
  const session = linuxSession(env);
  const items: DoctorItem[] = [{ id: "agent", title: t("Nookdeck"), status: "ok", detail: `${p.version} · ${p.exe} · ${os.name}` }];
  const [service, input, firewall, hookItems] = await Promise.all([linuxService(p), linuxInput(p, os, env), linuxFirewall(p, ctx), hooks(p, ctx)]);
  items.push(
    service, linuxSessionItem(p, env, session), input,
    linuxTool(p, os, "media", t("Media and Now Playing"), ["playerctl"], "playerctl", t("play, pause and Now Playing work"), t("media tiles and Now Playing will not work")),
    linuxTool(p, os, "volume", t("Volume"), ["pactl"], "pulseaudio-utils", t("the volume tile works"), t("the volume tile will not work")),
    linuxTool(p, os, "sound", t("Sounds"), ["paplay", "aplay"], "pulseaudio-utils", t("notification sounds play"), t("notification sounds will not play")),
    firewall, linuxNetwork(p), linuxClaude(p, ctx), ...hookItems,
  );
  return { version: p.version, exe: p.exe, asService: p.asService, platform: p.platform, items };
}

export async function runDoctor(p: Probes, ctx: DoctorCtx): Promise<DoctorReport> {
  if (p.platform === "win32") return runWindows(p, ctx);
  if (p.platform === "linux") return runLinux(p, ctx);
  const items: DoctorItem[] = [];
  items.push({ id: "agent", title: t("Nookdeck"), status: "ok", detail: `${p.version} · ${p.exe}` });
  items.push({
    id: "service", title: t("Background service"),
    status: p.asService ? "ok" : "n/a",
    detail: p.asService ? t("running as the launchd service (permissions belong to nookdeck)") : t("started from a terminal (permissions belong to {who})", { who: t("the terminal app you started Nookdeck from") }),
    ...(p.asService ? {} : { fix: { text: t("Run `nookdeck service install` to run in the background; macOS then asks for permissions for nookdeck itself.") } }),
  });
  items.push(await signature(p));
  items.push(await accessibility(p));
  // Music and Spotify are only reported when running (macOS cannot say otherwise)
  items.push(...(await Promise.all(AUTOMATION_TARGETS.map((tg) => automation(p, tg)))));
  items.push(await nowPlayingAll(p));
  items.push(await keychainClaude(p, ctx));
  items.push(keychainHass(p, ctx));
  items.push(localNetwork(p, ctx));
  items.push(await firewall(p));
  items.push(...(await hooks(p, ctx)));
  return { version: p.version, exe: p.exe, asService: p.asService, platform: p.platform, items };
}

/** Which ids `request()` can ask macOS for. */
export const REQUESTABLE = ["accessibility", "local-network", ...AUTOMATION_TARGETS.map((x) => x.id)] as const;

/**
 * Code-signing identifier of the running binary (ad hoc: "<file name>-<hash>", the same for every build with that file
 * name, so Local Network grants survive updates). tccutil resets by it; null when it cannot be read.
 */
export function macIdentifier(exe: string = process.execPath): string | null {
  if (osPlatform.id !== "darwin") return null;
  const p = Bun.spawnSync(["codesign", "-dv", exe], { stdout: "pipe", stderr: "pipe" });
  const m = /^Identifier=(.+)$/m.exec(p.stderr.toString() + p.stdout.toString());
  return m ? m[1]!.trim() : null;
}

/**
 * tccutil service to clear before asking again (a grant left over from an older build stops the prompt from showing).
 * Local Network has no tccutil service: macOS only re-asks when the process reaches the local network.
 */
export function tccServiceFor(id: string): string | null {
  if (id === "accessibility") return "Accessibility";
  if (AUTOMATION_TARGETS.some((x) => x.id === id)) return "AppleEvents";
  return null;
}

/**
 * Asks macOS to show its permission prompt for `id`, so it lists the binary. Only runs when the user asked
 * (`nookdeck doctor --request <id>` / POST /api/doctor/request). Returns the state right after the call.
 */
export function describeRequest(id: string): { id: string; kind: "accessibility" | "automation" | "local-network"; bundle?: string } | null {
  if (id === "accessibility") return { id, kind: "accessibility" };
  if (id === "local-network") return { id, kind: "local-network" };
  const tg = AUTOMATION_TARGETS.find((x) => x.id === id);
  return tg ? { id, kind: "automation", bundle: tg.bundle } : null;
}

export const STATUS_MARK: Record<DoctorStatus, string> = { ok: "✓", missing: "✗", denied: "✗", unknown: "?", "n/a": "-" };

/** Plain text for the terminal: ✓ / ✗ / ? / -, with the fix under each problem. */
export function formatReport(r: DoctorReport, opts: { color?: boolean } = {}): string {
  const c = (code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const mark = (s: DoctorStatus) => (s === "ok" ? c("32", "✓") : s === "missing" || s === "denied" ? c("31", "✗") : s === "unknown" ? c("33", "?") : c("90", "-"));
  const lines = [`Nookdeck doctor · ${r.version}`, ""];
  for (const it of r.items) {
    lines.push(`${mark(it.status)} ${it.title} - ${it.detail}`);
    if (it.status !== "ok" && it.status !== "n/a" && it.fix) {
      lines.push(`    ${t("Fix")}: ${it.fix.text}`);
      if (it.fix.settingsUrl) lines.push(`    ${t("Open the pane")}: nookdeck doctor --open ${it.id}`);
    } else if (it.fix && (it.status === "n/a" || it.id === "signature")) lines.push(`    ${t("Note")}: ${it.fix.text}`);
  }
  const bad = r.items.filter((i) => i.status === "missing" || i.status === "denied").length;
  lines.push("", bad ? t("{n} thing(s) need attention.", { n: bad }) : t("Everything that can be checked looks fine."));
  return lines.join("\n");
}

// ---------- the real probes (macOS) ----------

const APP_PATHS: Record<string, string[]> = {
  "com.apple.Music": ["/System/Applications/Music.app", "/Applications/Music.app"],
  "com.spotify.client": ["/Applications/Spotify.app", join(userHome(), "Applications", "Spotify.app")],
};

let ax: any;
function frameworks(): any {
  if (ax !== undefined) return ax;
  try {
    // bun:ffi only on macOS, only when asked
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const T = FFIType;
    const lib = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", {
      AXIsProcessTrusted: { args: [], returns: T.bool },
      AXIsProcessTrustedWithOptions: { args: [T.ptr], returns: T.bool },
      AEDeterminePermissionToAutomateTarget: { args: [T.ptr, T.u32, T.u32, T.bool], returns: T.i32 },
      AECreateDesc: { args: [T.u32, T.ptr, T.i64, T.ptr], returns: T.i16 },
      AEDisposeDesc: { args: [T.ptr], returns: T.i16 },
    });
    const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
      CFDataCreate: { args: [T.ptr, T.ptr, T.i64], returns: T.ptr },
      CFPropertyListCreateWithData: { args: [T.ptr, T.ptr, T.u64, T.ptr, T.ptr], returns: T.ptr },
      CFRelease: { args: [T.ptr], returns: T.void },
    });
    ax = { lib: lib.symbols, cf: cf.symbols, ptr: (require("bun:ffi") as typeof import("bun:ffi")).ptr };
  } catch {
    ax = null;
  }
  return ax;
}

const AUTOMATION_RESULT: Record<number, AutomationState> = { 0: "granted", [-1743]: "denied", [-1744]: "not-asked", [-600]: "not-running" };

/** AEDeterminePermissionToAutomateTarget for a bundle id; askUserIfNeeded=true shows macOS's prompt (only for `--request`). */
export function realAutomation(bundleId: string, ask = false): AutomationState {
  const f = frameworks();
  if (!f) return "unknown";
  try {
    const desc = new Uint8Array(16);
    const id = Buffer.from(bundleId);
    if (f.lib.AECreateDesc(0x62756e64 /* 'bund' */, f.ptr(id), id.length, f.ptr(desc)) !== 0) return "unknown";
    const r = f.lib.AEDeterminePermissionToAutomateTarget(f.ptr(desc), 0x2a2a2a2a, 0x2a2a2a2a, ask) as number;
    f.lib.AEDisposeDesc(f.ptr(desc));
    return AUTOMATION_RESULT[r] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * macOS permission calls (Apple Events, Accessibility) are synchronous and can block for good: tccd stuck, a target app that is
 * launching or hung. On the agent's main thread that freezes Bun.serve, so they never run there: each is asked of a short-lived
 * child (`nookdeck __ae <bundle> [ask]`, `nookdeck __ax [prompt]`) with a hard timeout, killed when it does not answer.
 * A granted answer is cached for 60 s; any other answer for 3 s, so a permission the user just turned on shows up at once.
 * At most one child per question is in flight.
 */
const PROBE_TTL_MS = 60_000;
const PROBE_TTL_NOT_OK_MS = 3_000;
const GRANTED = new Set(["true", "granted"]);
const probeCache = new Map<string, { at: number; value: string }>();
const probeFlight = new Map<string, Promise<string>>();
export const resetProbeCache = () => { probeCache.clear(); probeFlight.clear(); };

async function childProbe(args: string[], ms: number, o: { cache?: boolean } = {}): Promise<string> {
  const key = args.join(" ");
  const useCache = o.cache !== false;
  const hit = probeCache.get(key);
  if (useCache && hit && Date.now() - hit.at < (GRANTED.has(hit.value) ? PROBE_TTL_MS : PROBE_TTL_NOT_OK_MS)) return hit.value;
  const running = probeFlight.get(key);
  if (running) return running;
  const job = (async () => {
    let value = "";
    try {
      const { defaultProgram } = await import("./service");
      const p = Bun.spawn([...defaultProgram(), ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: process.env as Record<string, string> });
      const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, ms);
      try { value = (await new Response(p.stdout).text()).trim(); await p.exited; } finally { clearTimeout(timer); }
    } catch { /* value stays "" = no answer */ }
    if (useCache && value) probeCache.set(key, { at: Date.now(), value });
    if (!useCache) probeCache.clear(); // after a request the old answers are stale
    return value;
  })().finally(() => probeFlight.delete(key));
  probeFlight.set(key, job);
  return job;
}

/** The process name to look for before asking: only a target that is running is probed. */
const TARGET_PROCESS: Record<string, string> = { "com.apple.Music": "Music", "com.spotify.client": "Spotify" };

export async function boundedAutomation(bundleId: string, ms = 3000): Promise<AutomationState> {
  const proc = TARGET_PROCESS[bundleId];
  if (proc) {
    try {
      const pg = Bun.spawn(["pgrep", "-x", proc], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
      if ((await pg.exited) !== 0) return "not-running";
    } catch { /* cannot tell: ask anyway */ }
  }
  const out = await childProbe(["__ae", bundleId], ms);
  return (["granted", "denied", "not-asked", "not-running"] as const).find((s) => s === out) ?? "unknown";
}

export async function boundedAx(ms = 3000): Promise<boolean | null> {
  const out = await childProbe(["__ax"], ms);
  return out === "true" ? true : out === "false" ? false : null;
}

/** The prompting variants: the child lives long enough for the user to answer; they bypass and clear the cache. */
export async function boundedRequestAutomation(bundleId: string): Promise<AutomationState> {
  const out = await childProbe(["__ae", bundleId, "ask"], 90_000, { cache: false });
  return (["granted", "denied", "not-asked", "not-running"] as const).find((s) => s === out) ?? "unknown";
}
export async function boundedRequestAx(): Promise<boolean | null> {
  const out = await childProbe(["__ax", "prompt"], 90_000, { cache: false });
  return out === "true" ? true : out === "false" ? false : null;
}

export function realAxTrusted(): boolean | null {
  const f = frameworks();
  try { return f ? (f.lib.AXIsProcessTrusted() as boolean) : null; } catch { return null; }
}

/** AXIsProcessTrustedWithOptions(prompt=true): shows macOS's Accessibility prompt and lists this program. Returns whether it is trusted now. */
export function realAxPrompt(): boolean | null {
  const f = frameworks();
  if (!f) return null;
  try {
    const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>AXTrustedCheckOptionPrompt</key><true/></dict></plist>');
    const data = f.cf.CFDataCreate(null, f.ptr(xml), xml.length);
    const dict = f.cf.CFPropertyListCreateWithData(null, data, 0, null, null);
    const r = f.lib.AXIsProcessTrustedWithOptions(dict) as boolean;
    if (dict) f.cf.CFRelease(dict);
    if (data) f.cf.CFRelease(data);
    return r;
  } catch {
    return null;
  }
}

async function winHelperPing(): Promise<string> {
  const { WinHelper } = await import("./platform/win32/helper");
  const h = new WinHelper();
  try { return await h.call<string>("ping", {}, 8_000); } finally { h.dispose(); }
}

export function realProbes(version: string): Probes {
  const platform = osPlatform.id;
  return {
    platform,
    exe: process.execPath,
    program: defaultProgram(),
    version,
    // Linux: the unit and the autostart script set NOOKDECK_SERVICE=1
    asService: process.env.XPC_SERVICE_NAME === SERVICE_LABEL || process.env.NOOKDECK_SERVICE === "1",
    run: async (argv) => {
      try {
        const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        // bounded no matter what the child does: after 6 s we answer, kill it and stop waiting for its pipes
        const timeout = new Promise<{ code: number; out: string }>((res) => { timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } res({ code: 124, out: "timed out" }); }, 6000); });
        const done = (async () => {
          const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
          return { code: await p.exited, out: `${o}\n${e}`.trim() };
        })();
        try { return await Promise.race([done, timeout]); } finally { clearTimeout(timer); }
      } catch (err: any) {
        return { code: 127, out: String(err?.message ?? err) };
      }
    },
    axTrusted: () => (platform === "darwin" ? boundedAx() : null),
    nowPlaying: () => osPlatform.nowPlayingStatus(),
    automation: (b) => (platform === "darwin" ? boundedAutomation(b) : "unknown"),
    installed: (b) => (APP_PATHS[b] ?? []).some((x) => existsSync(x)),
    which: (n) => Bun.which(n),
    requestAccessibility: () => (platform === "darwin" ? boundedRequestAx() : null),
    requestAutomation: (b) => (platform === "darwin" ? boundedRequestAutomation(b) : "unknown"),
    // read-only here, but keep the same sandbox rule as the hook commands
    hookFiles: () => hookTargets().files,
    desktop: () => (platform === "win32" ? { station: winStation(), idle: winIdle() } : { station: null, idle: null }),
    helperPing: async () => { try { return (await winHelperPing()) === "pong"; } catch { return false; } },
    fileExists: (f) => existsSync(f),
    claudeCredentialsFile: () => join(process.env.NOOKDECK_CLAUDE_DIR ?? join(userHome(), ".claude"), ".credentials.json"),
    env: process.env,
    readText: (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } },
    uinput: () => (platform === "linux" ? require("./platform/linux-input").readUinputAccess() : NO_UINPUT),
    socket: (path) => {
      try {
        if (!statSync(path).isSocket()) return "missing";
        accessSync(path, fsConstants.W_OK);
        return "ok";
      } catch (e: any) { return e?.code === "EACCES" || e?.code === "EPERM" ? "denied" : "missing"; }
    },
    serviceStatus: async () => { const svc = await import("./service"); return svc.serviceStatus(svc.realServiceDeps(() => {})); },
    // container and VM bridges (docker0, br-..., veth..., virbr0, podman, cni) are not reachable from a phone
    addresses: () => Object.entries(networkInterfaces()).filter(([name]) => !/^(docker|br-|veth|virbr|podman|cni|lxc|lxd)/.test(name)).flatMap(([, list]) => list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => a.address),
  };
}
