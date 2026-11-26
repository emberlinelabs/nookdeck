// On Air core (spec specs/2026-11-26/obs-integration-and-on-air): the aggregator, the webhook, the mic / camera actions and the
// per-OS readers. Everything runs against fakes; the real macOS checks are in the task notes.
import "./_fetch";
import { rawFetch } from "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { OnAir, type AvProbe, type ObsLive, type ObsLiveKind } from "../src/onair";
import { MicControl, cameraToggle, type AvPlatform } from "../src/mic-camera";
import { pickMeetingApp } from "../src/meeting-apps";
import { cameraApps, micApps, pactlSourceMuteCommand, parseShortSources, parseSourceMute, parseSourceOutputs } from "../src/platform/linux-av";
import { winAvUsage } from "../src/platform/win32";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-onair-"));

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function probe(state = { mic: false, camera: false, muted: null as boolean | null }) {
  const calls = { usage: 0, ignore: [] as (number | undefined)[] };
  const p: AvProbe = {
    usage: async (ignore) => { calls.usage++; calls.ignore.push(ignore); return { mic: { inUse: state.mic }, camera: { inUse: state.camera } }; },
    micMuted: async () => state.muted,
  };
  return { p, state, calls };
}

function fakeObs(configured = true) {
  const cbs = new Set<(k: ObsLiveKind, a: boolean, s?: number) => void>();
  const st = { configured, stream: { active: false } as { active: boolean; since?: number }, record: { active: false } as { active: boolean; since?: number } };
  const obs: ObsLive = {
    configured: () => st.configured,
    live: () => ({ stream: st.stream, record: st.record }),
    onLive: (cb) => { cbs.add(cb); return () => void cbs.delete(cb); },
  };
  const fire = (k: ObsLiveKind, active: boolean, since?: number) => { st[k] = { active, since }; for (const cb of cbs) cb(k, active, since); };
  return { obs, st, fire };
}

describe("On Air aggregator", () => {
  test("off with nothing on; manual and api are separate sources; since is kept while sources change", () => {
    let t = 1000;
    const msgs: any[] = [];
    const a = new OnAir({ probe: probe().p, settingsFile: null, onChange: (m) => msgs.push(m), now: () => t });
    expect(a.snapshot()).toEqual({ type: "onair", on: false, sources: [], mic: { inUse: false, muted: null }, camera: { inUse: false } });
    a.setManual("on");
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 1000, sources: ["manual"] });
    t = 2000;
    a.setApi({ on: true, label: "  Podcast  " });
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 1000, sources: ["manual", "api"], label: "Podcast" });
    a.setManual("off"); // the API still holds it on
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 1000, sources: ["api"] });
    a.setApi({ on: false });
    expect(msgs.at(-1)).toEqual({ type: "onair", on: false, sources: [], mic: { inUse: false, muted: null }, camera: { inUse: false } });
    t = 5000;
    expect(a.setManual()).toBe(true); // toggle
    expect(msgs.at(-1).since).toBe(5000);
    const n = msgs.length;
    a.setManual("on"); // no change: no message
    expect(msgs.length).toBe(n);
  });

  test("ttl turns the API source off by itself; a new call replaces the timer", async () => {
    const msgs: any[] = [];
    const a = new OnAir({ probe: probe().p, settingsFile: null, onChange: (m) => msgs.push(m) });
    a.setApi({ on: true, label: "Live", ttl: 0.05 });
    expect(a.snapshot().on).toBe(true);
    await sleep(90);
    expect(a.snapshot().on).toBe(false);
    a.setApi({ on: true, ttl: 0.05 });
    a.setApi({ on: true }); // no ttl now: stays on
    await sleep(90);
    expect(a.snapshot()).toMatchObject({ on: true, sources: ["api"] });
    a.dispose();
  });

  test("bad API bodies are refused with a readable message", () => {
    const a = new OnAir({ probe: probe().p, settingsFile: null, onChange: () => {} });
    expect(() => a.setApi(null)).toThrow(/"on"/);
    expect(() => a.setApi({ on: "yes" })).toThrow(/"on"/);
    expect(() => a.setApi({ on: true, ttl: -1 })).toThrow(/ttl/);
    expect(() => a.setApi({ on: true, ttl: 1e9 })).toThrow(/ttl/);
    expect(() => a.setApi({ on: true, label: 5 })).toThrow(/label/);
    a.setApi({ on: true, label: "x".repeat(200) });
    expect(a.snapshot().label!.length).toBe(60);
  });

  test("mic and camera are read only while needed (NFR-4), and drive On Air", async () => {
    const pr = probe({ mic: true, camera: false, muted: false });
    const msgs: any[] = [];
    const a = new OnAir({ probe: pr.p, settingsFile: null, onChange: (m) => msgs.push(m), pollMs: 20, pid: 4242 });
    await sleep(50);
    expect(pr.calls.usage).toBe(0);
    a.setNeeded(true);
    await flush();
    expect(msgs.at(-1)).toMatchObject({ on: true, sources: ["mic"], mic: { inUse: true, muted: false } });
    expect(pr.calls.ignore[0]).toBe(4242); // ignoreSelf defaults to on
    pr.state.mic = false; pr.state.camera = true;
    await sleep(40);
    expect(msgs.at(-1)).toMatchObject({ on: true, sources: ["camera"], camera: { inUse: true } });
    const before = pr.calls.usage;
    a.setNeeded(false);
    expect(msgs.at(-1)).toMatchObject({ on: false, sources: [] });
    await sleep(60);
    expect(pr.calls.usage).toBe(before);
    a.dispose();
  });

  test("settings: spec defaults, obs follows the OBS set-up, a source switched off does not count", async () => {
    const pr = probe({ mic: true, camera: true, muted: null });
    const a = new OnAir({ probe: pr.p, settingsFile: null, onChange: () => {} });
    expect(a.settings()).toEqual({ sources: { obs: false, mic: true, camera: true, manual: true, api: true }, ignoreSelf: true });
    const o = fakeObs(true);
    a.attachObs(o.obs);
    expect(a.settings().sources.obs).toBe(true);
    await a.refresh();
    expect(a.snapshot().sources).toEqual(["mic", "camera"]);
    await a.setSettings({ sources: { mic: false, camera: true, obs: true, manual: true, api: true }, ignoreSelf: false });
    expect(a.snapshot().sources).toEqual(["camera"]);
    expect(a.snapshot().mic.inUse).toBe(true); // the tile still shows it, it just does not turn On Air on
    await a.refresh();
    expect(pr.calls.ignore.at(-1)).toBeUndefined();
    await expect(a.setSettings({ sources: { mic: "no" } })).rejects.toThrow(/sources.mic/);
    await expect(a.setSettings({})).rejects.toThrow(/sources/);
  });

  test("settings persist to their own file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pd-onair-set-")), "onair.json");
    const a = new OnAir({ probe: probe().p, settingsFile: file, onChange: () => {} });
    await a.setSettings({ sources: { obs: false, mic: false, camera: true, manual: true, api: false } });
    expect(JSON.parse(readFileSync(file, "utf8")).sources.mic).toBe(false);
    const b = new OnAir({ probe: probe().p, settingsFile: file, onChange: () => {} });
    await b.load();
    expect(b.settings()).toEqual({ sources: { obs: false, mic: false, camera: true, manual: true, api: false }, ignoreSelf: true });
  });

  test("OBS stream / record; since is when OBS went live; switching OBS off drops its sources", () => {
    const msgs: any[] = [];
    const a = new OnAir({ probe: probe().p, settingsFile: null, onChange: (m) => msgs.push(m), now: () => 9000 });
    const o = fakeObs(true);
    o.st.stream = { active: true, since: 4000 }; // already live when attached
    a.attachObs(o.obs);
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 4000, sources: ["obs-stream"] });
    o.fire("record", true, 8000);
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 4000, sources: ["obs-stream", "obs-record"] });
    o.st.configured = false; // integration switched off: the client fires both kinds inactive
    o.fire("stream", false); o.fire("record", false);
    expect(msgs.at(-1)).toMatchObject({ on: false, sources: [] });
    expect(msgs.at(-1).since).toBeUndefined();
  });
});

describe("Mic button (FR-10, NFR-6)", () => {
  function fakeMic(init: { canMute: boolean; muted: boolean | null; volume: number | null }) {
    const m = { ...init };
    const log: string[] = [];
    const p = {
      readMic: async () => ({ ...m }),
      setMicMuted: async (x: boolean) => { log.push(`mute ${x}`); m.muted = x; },
      setMicVolume: async (v: number) => { log.push(`vol ${v}`); m.volume = v; m.muted = v === 0; },
    } as unknown as AvPlatform;
    return { m, log, p };
  }
  test("a device with a mute control is muted, toggled and unmuted", async () => {
    const f = fakeMic({ canMute: true, muted: false, volume: 0.6 });
    const c = new MicControl(f.p, null);
    expect(await c.set()).toBe(true);
    expect(await c.set("toggle")).toBe(false);
    expect(await c.set("unmute")).toBe(false);
    expect(f.log).toEqual(["mute true", "mute false", "mute false"]);
    expect(f.m.volume).toBe(0.6);
  });
  test("no mute control: volume 0, then the saved volume back; the agent stopping restores it too", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "pd-mic-")), "mic-restore.json");
    const f = fakeMic({ canMute: false, muted: false, volume: 0.75 });
    const c = new MicControl(f.p, file);
    expect(await c.set("mute")).toBe(true);
    expect(f.m.volume).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(await c.set("unmute")).toBe(false);
    expect(f.m.volume).toBe(0.75);
    expect(existsSync(file)).toBe(false);
    // muted, then the agent stops (or crashed and starts again): restore
    await c.set("mute");
    expect(await new MicControl(f.p, file).restore()).toBe(true);
    expect(f.m.volume).toBe(0.75);
    expect(await c.restore()).toBe(false); // nothing left to restore
  });
  test("restore leaves a volume the user changed since alone", async () => {
    const f = fakeMic({ canMute: false, muted: false, volume: 0.5 });
    const c = new MicControl(f.p, null);
    await c.set("mute");
    f.m.volume = 0.3;
    await c.restore();
    expect(f.m.volume).toBe(0.3);
  });
  test("no input device / no control: a readable error", async () => {
    await expect(new MicControl({ readMic: async () => null } as any, null).set()).rejects.toThrow(/microphone/i);
    await expect(new MicControl(fakeMic({ canMute: false, muted: null, volume: null }).p, null).set()).rejects.toThrow(/cannot be muted/);
  });
});

describe("Camera button (FR-11)", () => {
  const os = (id: NodeJS.Platform, o: { camera?: string[]; inUse?: boolean; front?: { id: string; title?: string } | null; running?: string[] }) => {
    const sent: any[] = [], activated: string[] = [];
    const p = {
      id,
      avUsage: async () => ({ mic: { inUse: false, apps: [] }, camera: { inUse: o.inUse ?? !!o.camera?.length, apps: o.camera ?? [] } }),
      frontApp: async (withTitle?: boolean) => (o.front ? { id: o.front.id, ...(withTitle ? { title: o.front.title } : {}) } : null),
      runningApps: async (ids: string[]) => ids.filter((x) => o.running?.includes(x)),
      activateApp: async (x: string) => { activated.push(x); return true; },
      runAction: async (a: any) => void sent.push(a),
    } as unknown as AvPlatform;
    return { p, sent, activated };
  };
  const noWait = async () => {};
  test("macOS: frontmost Zoom, Teams; Meet in a browser by its title", async () => {
    let f = os("darwin", { front: { id: "us.zoom.xos" } });
    expect(await cameraToggle(f.p, noWait)).toBe("Zoom");
    expect(f.sent).toEqual([{ type: "hotkey", keys: "cmd+shift+v" }]);
    f = os("darwin", { front: { id: "com.microsoft.teams2" } });
    await cameraToggle(f.p, noWait);
    expect(f.sent[0].keys).toBe("cmd+shift+o");
    f = os("darwin", { front: { id: "com.google.Chrome", title: "Meet - abc-defg-hij" } });
    expect(await cameraToggle(f.p, noWait)).toBe("Google Meet");
    expect(f.sent[0].keys).toBe("cmd+e");
  });
  test("macOS: camera in use and Zoom runs behind another app: Zoom is brought forward first", async () => {
    const f = os("darwin", { inUse: true, front: { id: "com.apple.finder" }, running: ["us.zoom.xos"] });
    await cameraToggle(f.p, noWait);
    expect(f.activated).toEqual(["us.zoom.xos"]);
    expect(f.sent[0].keys).toBe("cmd+shift+v");
  });
  test("Windows names the app using the camera; Linux by WM class", async () => {
    let f = os("win32", { camera: ["zoom.exe"], front: { id: "explorer.exe" } });
    await cameraToggle(f.p, noWait);
    expect(f.sent[0].keys).toBe("alt+v");
    f = os("win32", { camera: ["msteams_8wekyb3d8bbwe"], front: null });
    await cameraToggle(f.p, noWait);
    expect(f.sent[0].keys).toBe("ctrl+shift+o");
    f = os("linux", { front: { id: "firefox", title: "Weekly - Google Meet - Mozilla Firefox" } });
    await cameraToggle(f.p, noWait);
    expect(f.sent[0].keys).toBe("ctrl+e");
  });
  test("no known meeting app: says so and sends nothing", async () => {
    for (const f of [os("darwin", { front: { id: "com.apple.finder" } }), os("darwin", { front: { id: "com.google.Chrome", title: "News" } }), os("win32", { front: null }), os("darwin", { inUse: false, front: null, running: ["us.zoom.xos"] })]) {
      await expect(cameraToggle(f.p, noWait)).rejects.toThrow(/Zoom, Google Meet or Teams/);
      expect(f.sent).toEqual([]);
    }
  });
  test("a Meet title in a non-browser app does not count", () => {
    expect(pickMeetingApp({ os: "mac", cameraApps: [], front: { id: "com.apple.Notes", title: "Meet - notes" } })).toBeNull();
  });
});

describe("per-OS readers and commands", () => {
  test("Linux: source outputs on a real source, not corked, not the agent; monitors do not count", () => {
    const outs = `Source Output #41
\tDriver: protocol-native.c
\tSource: 2
\tCorked: no
\tProperties:
\t\tapplication.name = "Firefox"
\t\tapplication.process.id = "3100"
\t\tapplication.process.binary = "firefox"

Source Output #42
\tSource: 1
\tCorked: no
\tProperties:
\t\tapplication.name = "OBS"
\t\tapplication.process.binary = "obs"

Source Output #43
\tSource: 2
\tCorked: yes
\tProperties:
\t\tapplication.process.binary = "zoom"

Source Output #44
\tSource: 2
\tCorked: no
\tProperties:
\t\tapplication.process.id = "777"
\t\tapplication.process.binary = "bun"
`;
    const srcs = parseShortSources("1\talsa_output.pci.analog-stereo.monitor\tmodule-alsa-card.c\ts16le 2ch 44100Hz\tSUSPENDED\n2\talsa_input.usb-mic\tmodule-alsa-card.c\ts16le 1ch 48000Hz\tRUNNING\n");
    const parsed = parseSourceOutputs(outs);
    expect(parsed.map((o) => o.app)).toEqual(["firefox", "obs", "zoom", "bun"]);
    expect(parsed[0]!.pid).toBe(3100);
    expect(micApps(parsed, srcs, 777)).toEqual(["firefox"]);
    expect(micApps(parsed, srcs)).toEqual(["firefox", "bun"]);
    expect(micApps(parseSourceOutputs(""), srcs)).toEqual([]);
  });
  test("Linux: source mute read and command", () => {
    expect(parseSourceMute("Mute: yes\n")).toBe(true);
    expect(parseSourceMute("Mute: no")).toBe(false);
    expect(parseSourceMute("Connection failure")).toBeNull();
    expect(pactlSourceMuteCommand(true)).toEqual(["pactl", "set-source-mute", "@DEFAULT_SOURCE@", "1"]);
    expect(pactlSourceMuteCommand(false)).toEqual(["pactl", "set-source-mute", "@DEFAULT_SOURCE@", "0"]);
  });
  test("Linux: a process holding /dev/video* uses the camera; unreadable processes and the agent are skipped", async () => {
    const tree: Record<string, string[]> = { "/proc": ["1", "200", "300", "self", "400"], "/proc/200/fd": ["0", "5"], "/proc/300/fd": ["3"], "/proc/400/fd": ["7"] };
    const links: Record<string, string> = { "/proc/200/fd/0": "/dev/null", "/proc/200/fd/5": "/dev/video0", "/proc/300/fd/3": "/dev/video10", "/proc/400/fd/7": "/dev/video0" };
    const fs = {
      readdir: async (p: string) => { if (!tree[p]) throw new Error("EACCES"); return tree[p]!; },
      readlink: async (p: string) => { if (!links[p]) throw new Error("EINVAL"); return links[p]!; },
      readFile: async (p: string) => ({ "/proc/200/comm": "zoom\n", "/proc/300/comm": "cheese\n" } as Record<string, string>)[p] ?? "",
    };
    expect(await cameraApps(fs, 400)).toEqual(["zoom", "cheese"]);
    expect(await cameraApps({ ...fs, readdir: async () => { throw new Error("no /proc"); } })).toEqual([]);
  });
  test("Windows: consent store rows to exe names; the agent's own exe left out", () => {
    const r = winAvUsage({ mic: ["C:\\Program Files\\Zoom\\bin\\Zoom.exe", "C:\\nookdeck\\bun.exe"], camera: null }, "C:\\nookdeck\\bun.exe");
    expect(r).toEqual({ mic: { inUse: true, apps: ["zoom.exe"] }, camera: { inUse: false, apps: [] } });
    expect(winAvUsage({ mic: [], camera: ["MSTeams_8wekyb3d8bbwe"] }).camera).toEqual({ inUse: true, apps: ["msteams_8wekyb3d8bbwe"] });
  });
});

describe("layout validation: actions, macro steps, rule action, the On Air tile", async () => {
  const { validateLayout } = await import("../src/config");
  const page = (items: any[], extra: any = {}) => ({ version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items }], ...extra });
  const btn = (action: any) => ({ id: "b", kind: "button", label: "b", action });
  test("onair / mic / camera actions; only known fields kept; bad modes refused", () => {
    expect((validateLayout(page([btn({ type: "onair", mode: "on", junk: 1 })])).pages[0]!.items[0] as any).action).toEqual({ type: "onair", mode: "on" });
    expect((validateLayout(page([btn({ type: "mic" })])).pages[0]!.items[0] as any).action).toEqual({ type: "mic" });
    expect((validateLayout(page([btn({ type: "camera", mode: "x" })])).pages[0]!.items[0] as any).action).toEqual({ type: "camera" });
    expect(() => validateLayout(page([btn({ type: "onair", mode: "flash" })]))).toThrow(/toggle, on or off/);
    expect(() => validateLayout(page([btn({ type: "mic", mode: "on" })]))).toThrow(/toggle, mute or unmute/);
  });
  test("macro steps onair / mic", () => {
    const l = validateLayout(page([btn({ type: "macro", steps: [{ kind: "onair", mode: "on" }, { kind: "mic", mode: "unmute" }, { kind: "mic" }] })]));
    expect((l.pages[0]!.items[0] as any).action.steps).toEqual([{ kind: "onair", mode: "on" }, { kind: "mic", mode: "unmute" }, { kind: "mic" }]);
    expect(() => validateLayout(page([btn({ type: "macro", steps: [{ kind: "mic", mode: "loud" }] })]))).toThrow(/mute/);
  });
  test("rule action onair", () => {
    const l = validateLayout(page([], { rules: [{ id: "r", name: "r", when: { kind: "idle", minutes: 5 }, then: [{ kind: "onair", mode: "off" }] }] }));
    expect(l.rules![0]!.then).toEqual([{ kind: "onair", mode: "off" }]);
    expect(() => validateLayout(page([], { rules: [{ id: "r", name: "r", when: { kind: "idle", minutes: 5 }, then: [{ kind: "onair", mode: "blink" }] }] }))).toThrow();
  });
  test("the On Air tile: 1x1, 2x1, 2x2 only", () => {
    for (const [w, h] of [[1, 1], [2, 1], [2, 2], [undefined, undefined]]) expect(() => validateLayout(page([{ id: "o", kind: "widget", widget: "onair", w, h }]))).not.toThrow();
    for (const [w, h] of [[1, 2], [3, 1], [4, 2]]) expect(() => validateLayout(page([{ id: "o", kind: "widget", widget: "onair", w, h }]))).toThrow(/1x1, 2x1 or 2x2/);
  });
});

describe("the agent: onair message, routes, webhook, buttons", () => {
  const lan = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((a) => a.family === "IPv4" && !a.internal)?.address;
  const avState = { mic: false, camera: false, muted: false as boolean | null, cameraApps: [] as string[] };
  const ran: any[] = [];
  const av: AvPlatform = {
    id: "darwin",
    avUsage: async () => ({ mic: { inUse: avState.mic, apps: ["us.zoom.xos"] }, camera: { inUse: avState.camera, apps: avState.cameraApps } }),
    readMic: async () => ({ muted: avState.muted, canMute: true, volume: 0.5 }),
    setMicMuted: async (m) => { avState.muted = m; },
    setMicVolume: async () => {},
    frontApp: async () => ({ id: "us.zoom.xos" }),
    activateApp: async () => true,
    runningApps: async () => [],
    runAction: async (a) => void ran.push(a),
  };
  let app: any, base: string, key: string, token: string;
  const home = process.env.NOOKDECK_HOME!;

  beforeAll(async () => {
    const { startServer } = await import("../src/server");
    app = await startServer({
      port: 0, pin: "555555", hostName: async () => "my-mac",
      webhookKeyFile: join(home, "onair-webhook-key"),
      layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-onair-hist-")),
      onairFile: join(mkdtempSync(join(tmpdir(), "pd-onair-s-")), "onair.json"),
      micSavedFile: join(mkdtempSync(join(tmpdir(), "pd-onair-m-")), "mic.json"),
      onairPollMs: 30,
      av,
      deps: { runAction: async (a: any) => void ran.push(a), startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => ({ id: "claude", name: "c", windows: [], updatedAt: 1 }), codex: async () => ({ id: "codex", name: "c", windows: [], updatedAt: 1 }), antigravity: async () => ({ id: "antigravity", name: "a", windows: [], updatedAt: 1 }), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    key = ((await (await fetch(`${base}/api/webhooks?reveal=1`)).json()) as any).key;
    token = ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "555555", name: "t" }) })).json()) as any).token;
  });
  afterAll(async () => {
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    app.stop();
  });

  function connect() {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${token}`);
    const msgs: any[] = [];
    ws.onmessage = (e) => { msgs.push(JSON.parse(String(e.data))); };
    const next = async (pred: (m: any) => boolean, ms = 2000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const i = msgs.findIndex(pred); if (i >= 0) return msgs.splice(i, 1)[0]; await sleep(10); }
      throw new Error("timeout");
    };
    return { ws, msgs, next, open: new Promise((r) => (ws.onopen = r)) };
  }

  test("GET /api/onair: the body plus settings; PUT settings returns the same shape; phone keys cannot", async () => {
    const g = await (await fetch(`${base}/api/onair`)).json() as any;
    expect(g).toMatchObject({ type: "onair", on: false, sources: [], mic: { inUse: false, muted: false }, camera: { inUse: false } });
    expect(g.settings).toEqual({ sources: { obs: false, mic: true, camera: true, manual: true, api: true }, ignoreSelf: true });
    expect(JSON.stringify(g)).not.toContain("zoom"); // NFR-3: the apps stay on the agent
    const p = await (await fetch(`${base}/api/onair/settings`, { method: "PUT", body: JSON.stringify({ sources: { obs: false, mic: false, camera: true, manual: true, api: true }, ignoreSelf: true }) })).json() as any;
    expect(p.type).toBe("onair");
    expect(p.settings.sources.mic).toBe(false);
    expect((await fetch(`${base}/api/onair/settings`, { method: "PUT", body: JSON.stringify({ sources: { mic: 1 } }) })).status).toBe(400);
    expect((await rawFetch(`${base}/api/onair/settings`, { method: "PUT", body: "{}", headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    await fetch(`${base}/api/onair/settings`, { method: "PUT", body: JSON.stringify({ sources: { obs: false, mic: true, camera: true, manual: true, api: true } }) });
  });

  test("POST /api/onair with the key: on with a label, off after the ttl (AC-12); phones get the onair message", async () => {
    const c = connect();
    await c.open;
    expect(await c.next((m) => m.type === "onair")).toMatchObject({ on: false });
    const r = await rawFetch(`${base}/api/onair`, { method: "POST", body: JSON.stringify({ on: true, label: "Podcast", ttl: 0.3 }), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } });
    expect(r.status).toBe(200);
    const on = await c.next((m) => m.type === "onair" && m.on);
    expect(on).toMatchObject({ on: true, sources: ["api"], label: "Podcast" });
    expect(typeof on.since).toBe("number");
    expect(await c.next((m) => m.type === "onair" && !m.on, 2000)).toMatchObject({ on: false, sources: [] });
    expect((await rawFetch(`${base}/api/onair`, { method: "POST", body: JSON.stringify({ on: "x" }), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } })).status).toBe(400);
    expect((await rawFetch(`${base}/api/onair`, { method: "POST", body: JSON.stringify({ on: true }), headers: { authorization: "Bearer wrong" } })).status).toBe(403); // localhost: CSRF rules
    c.ws.close();
  });

  test.skipIf(!lan)("from the LAN without the key: 401", async () => {
    const r = await rawFetch(`http://${lan}:${app.port}/api/onair`, { method: "POST", body: JSON.stringify({ on: true }) });
    expect(r.status).toBe(401);
    const ok = await rawFetch(`http://${lan}:${app.port}/api/onair`, { method: "POST", body: JSON.stringify({ on: false }), headers: { authorization: `Bearer ${key}` } });
    expect(ok.status).toBe(200);
  });

  test("buttons: On Air, Mic and Camera run through the agent; mic and camera are polled only while a phone shows them", async () => {
    const layout = { version: 1, pages: [{ id: "p", name: "P", columns: 4, rows: 3, items: [
      { id: "oa", kind: "button", label: "On Air", action: { type: "onair" } },
      { id: "mic", kind: "button", label: "Mic", action: { type: "mic", mode: "toggle" } },
      { id: "cam", kind: "button", label: "Cam", action: { type: "camera" } },
    ] }] };
    expect((await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(layout) })).status).toBe(200);
    expect(app.onair.isNeeded()).toBe(false); // no phone
    const c = connect();
    await c.open;
    await c.next((m) => m.type === "onair");
    expect(app.onair.isNeeded()).toBe(true);
    const press = (itemId: string) => c.ws.send(JSON.stringify({ type: "press", pageId: "p", itemId, reqId: itemId }));
    press("oa");
    expect(await c.next((m) => m.type === "onair" && m.on)).toMatchObject({ sources: ["manual"] });
    press("mic");
    expect(await c.next((m) => m.type === "onair" && m.mic?.muted === true)).toBeTruthy();
    expect(avState.muted).toBe(true);
    avState.muted = false; // changed outside Nookdeck: the poll picks it up
    expect(await c.next((m) => m.type === "onair" && m.mic?.muted === false)).toBeTruthy();
    press("cam");
    await c.next((m) => m.type === "result" && m.reqId === "cam" && m.ok);
    expect(ran.at(-1)).toEqual({ type: "hotkey", keys: "cmd+shift+v" });
    avState.camera = true;
    expect(await c.next((m) => m.type === "onair" && m.sources?.includes("camera"))).toMatchObject({ on: true, sources: ["camera", "manual"] });
    c.ws.close();
    await sleep(50);
    expect(app.onair.isNeeded()).toBe(false);
    avState.camera = false;
    app.onair.setManual("off");
  });

  test("onair-watch keeps checks on with no tile on the layout", async () => {
    const { defaultLayout } = await import("../src/config");
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(defaultLayout()) });
    const c = connect();
    await c.open;
    await c.next((m) => m.type === "onair");
    expect(app.onair.isNeeded()).toBe(false);
    c.ws.send(JSON.stringify({ type: "onair-watch", on: true }));
    await sleep(30);
    expect(app.onair.isNeeded()).toBe(true);
    c.ws.send(JSON.stringify({ type: "onair-watch", on: false }));
    await sleep(30);
    expect(app.onair.isNeeded()).toBe(false);
    c.ws.close();
  });
});

describe("OBS as a Store plugin (ctx.onair.set)", () => {
  test("plugin stream / record drive obs-stream / obs-record; obs defaults on once a plugin reports; clearPlugin drops them", () => {
    const msgs: any[] = [];
    const a = new OnAir({ probe: probe().p, settingsFile: null, onChange: (m) => msgs.push(m), now: () => 9000 });
    expect(a.settings().sources.obs).toBe(false);
    a.setPluginSource("obs-studio", "stream", true, 5000);
    expect(a.settings().sources.obs).toBe(true);
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 5000, sources: ["obs-stream"] });
    a.setPluginSource("other", "record", true);
    a.setPluginSource("obs-studio", "stream", false);
    expect(msgs.at(-1)).toMatchObject({ on: true, since: 5000, sources: ["obs-record"] });
    a.clearPlugin("other");
    expect(msgs.at(-1)).toMatchObject({ on: false, sources: [] });
    expect(() => a.setPluginSource("x", "scene" as any, true)).toThrow(/stream or record/);
  });
});
