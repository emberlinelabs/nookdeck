#!/usr/bin/env bun
/**
 * Dev-only (not shipped): regenerates the README images with DEMO DATA ONLY.
 *
 *   bun scripts/capture-promo.ts [--only promo-hero,manage-theme,demo,social]
 *
 * It serves the built deck (web/deck/dist) and manage (a fresh build in a temp dir) from a mock agent on its own port
 * (default 7599, never the real :7420), with a temp NOOKDECK_HOME and fixed demo state, then screenshots them with headless
 * Chrome (CDP) and composes the posters.
 *  - deck shots use the deck's own preview mode (/?preview=1 + postMessage), which feeds built-in sample data:
 *    host "My computer", "Midnight Circuit / Neon Harbor", "Claude Max 5x 34%", sessions api-server / web-app, a
 *    Claude Code question and a `bun run build` permission prompt, sample Home Assistant entities.
 *  - manage shots load the real manage UI against mock /api fixtures below.
 * Outputs overwrite docs/images/*.png|gif and docs/brand/social-preview.png (same names and sizes as before).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const PORT = Number(process.env.CAPTURE_PORT || 7599);
const CDP_PORT = Number(process.env.CAPTURE_CDP_PORT || 9444);
const TMP = mkdtempSync(join(tmpdir(), "nookdeck-capture-"));
const HOME_DIR = join(TMP, "home");
mkdirSync(HOME_DIR, { recursive: true });
// the temp home must be in place before anything imports src/config.ts or src/icons.ts
process.env.NOOKDECK_HOME = HOME_DIR;
process.env.PHONEDESK_HOME = HOME_DIR;

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const onlyIdx = args.indexOf("--only");
if (onlyIdx >= 0 && args[onlyIdx + 1]) only.push(...args[onlyIdx + 1].split(","));
const want = (n: string) => only.length === 0 || only.indexOf(n) >= 0;
const sh = (cmd: string, a: string[], cwd?: string) => {
  const r = spawnSync(cmd, a, { cwd, stdio: "inherit", env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` } });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(" ")} failed`);
};

// ---------------------------------------------------------------- builds
const DECK_DIST = join(ROOT, "web/deck/dist");
const MANAGE_DIST = join(TMP, "manage-dist");
sh("bunx", ["--bun", "vite", "build"], join(ROOT, "web/deck"));
sh("bunx", ["--bun", "vite", "build", "--outDir", MANAGE_DIST, "--emptyOutDir"], join(ROOT, "web/manage"));

// ---------------------------------------------------------------- demo layout
type L = any;
const { defaultLayout } = await import("../src/config");
const { Icons } = await import("../src/icons");

function demoLayout(): L {
  const l: L = defaultLayout();
  l.theme = { ...l.theme, mode: "dark", orientation: "landscape", tileStyle: "ios", iconStroke: 2.25 };
  const app = (id: string, label: string, bundle: string, x: number, y: number) => ({ id, kind: "button", label, icon: `app:${bundle}`, x, y, action: { type: "open", target: label } });
  const key = (id: string, label: string, icon: string, x: number, y: number, action: any, color?: string) => ({ id, kind: "button", label, icon, x, y, action, ...(color ? { color } : {}) });
  const hk = (k: string) => ({ type: "hotkey", keys: k });
  const keys = {
    id: "home", name: "Keys", columns: 8, rows: 3,
    items: [
      app("a-chrome", "Chrome", "com.google.Chrome", 0, 0), app("a-ghostty", "Ghostty", "com.mitchellh.ghostty", 1, 0), app("a-zed", "Zed", "dev.zed.Zed", 2, 0),
      app("a-finder", "Finder", "com.apple.finder", 3, 0), app("a-spotify", "Spotify", "com.spotify.client", 4, 0), app("a-slack", "Slack", "com.tinyspeck.slackmacgap", 5, 0),
      app("a-telegram", "Telegram", "ru.keepcoder.Telegram", 6, 0), app("a-zalo", "Zalo", "com.vng.zalo", 7, 0),
      key("k-copy", "Copy", "copy", 0, 1, hk("cmd+c"), "#22d3ee"), key("k-paste", "Paste", "clipboard", 1, 1, hk("cmd+v"), "#22d3ee"),
      key("k-undo", "Undo", "arrow-back-up", 2, 1, hk("cmd+z"), "#22d3ee"), key("k-redo", "Redo", "arrow-forward-up", 3, 1, hk("cmd+shift+z"), "#22d3ee"),
      key("k-shot", "Screenshot", "camera", 4, 1, hk("cmd+shift+4"), "#22d3ee"), key("k-find", "Spotlight", "search", 5, 1, hk("cmd+space"), "#22d3ee"),
      key("k-win", "Windows", "layout-grid", 6, 1, hk("ctrl+up"), "#22d3ee"), key("k-lock", "Lock", "lock", 7, 1, hk("ctrl+cmd+q"), "#22d3ee"),
      key("m-prev", "Previous", "player-skip-back", 0, 2, { type: "media", command: "previous" }, "#f59e0b"), key("m-play", "Play / Pause", "player-play", 1, 2, { type: "media", command: "playpause" }, "#f59e0b"),
      key("m-next", "Next", "player-skip-forward", 2, 2, { type: "media", command: "next" }, "#f59e0b"), key("m-vd", "Volume down", "volume-2", 3, 2, { type: "volume", command: "down" }, "#f59e0b"),
      key("m-vu", "Volume up", "volume", 4, 2, { type: "volume", command: "up" }, "#f59e0b"), key("m-mute", "Mute", "volume-3", 5, 2, { type: "volume", command: "mute" }, "#f59e0b"),
      key("k-sys", "System", "cpu", 6, 2, { type: "page", page: "dev" }), key("k-over", "Overview", "home", 7, 2, { type: "page", page: "overview" }),
    ],
  };
  const ent = (id: string, entity: string, x: number, y: number, w = 1, h = 1) => ({ id, kind: "widget", widget: "entity", entity: { id: entity }, x, y, w, h });
  const homePage = {
    id: "ha", name: "Home", columns: 8, rows: 3,
    items: [
      { id: "h-wx", kind: "widget", widget: "weather", x: 0, y: 0, w: 2, h: 2 },
      ent("h-ac", "climate.bedroom_ac", 2, 0, 2, 2), ent("h-l1", "light.living_room", 4, 0), ent("h-l2", "light.kitchen", 5, 0), ent("h-l3", "light.desk_lamp", 6, 0), ent("h-fan", "fan.ceiling_fan", 7, 0),
      ent("h-cov", "cover.blinds", 4, 1, 2, 1), ent("h-vac", "vacuum.robot", 6, 1, 2, 1),
      ent("h-temp", "sensor.living_temperature", 0, 2, 2), ent("h-hum", "sensor.humidity", 2, 2, 2), ent("h-door", "binary_sensor.front_door", 4, 2, 2), ent("h-lock", "lock.door_lock", 6, 2, 2),
    ],
  };
  const pages: L[] = l.pages;
  const byId = (id: string) => pages.find((p: L) => p.id === id);
  const q = (id: string, provider: string, x: number, y: number, w: number, h: number, color: string) => ({ id, kind: "widget", widget: "quota", provider, color, x, y, w, h });
  const overview = {
    id: "overview", name: "Overview", columns: 8, rows: 3,
    items: [
      { id: "w-clock", kind: "widget", widget: "clock", x: 0, y: 0, w: 3, h: 1 },
      { id: "w-wx", kind: "widget", widget: "weather", x: 3, y: 0, w: 2, h: 2 },
      { id: "w-media", kind: "widget", widget: "nowplaying", x: 5, y: 0, w: 3, h: 2 },
      q("w-q-claude", "claude", 0, 1, 3, 1, "#d97757"),
      { id: "w-cpu", kind: "widget", widget: "cpu", color: "#2dd4bf", x: 0, y: 2, w: 2 },
      { id: "w-mem", kind: "widget", widget: "memory", color: "#a78bfa", x: 2, y: 2, w: 2 },
      { id: "w-net", kind: "widget", widget: "network", color: "#f59e0b", x: 4, y: 2, w: 2 },
      { id: "w-load", kind: "widget", widget: "load", color: "#34d399", metric: { chart: "bars" }, x: 6, y: 2, w: 2 },
    ],
  };
  const aiPage = {
    id: "ai", name: "AI", columns: 8, rows: 3,
    items: [
      q("w-q-claude", "claude", 0, 0, 3, 2, "#d97757"), q("w-q-codex", "codex", 3, 0, 3, 1, "#e5e7eb"), q("w-q-agy", "antigravity", 3, 1, 3, 1, "#60a5fa"),
      { id: "w-sessions", kind: "widget", widget: "sessions", x: 6, y: 0, w: 2, h: 3 },
      app("a-claude", "Claude", "com.anthropic.claudefordesktop", 0, 2), app("a-ghostty2", "Ghostty", "com.mitchellh.ghostty", 1, 2), app("a-zed2", "Zed", "dev.zed.Zed", 2, 2),
      { id: "w-cpu-ai", kind: "widget", widget: "cpu", color: "#2dd4bf", x: 3, y: 2, w: 2 },
      { id: "w-mem-ai", kind: "widget", widget: "memory", color: "#f472b6", metric: { chart: "ring" }, x: 5, y: 2, w: 1 },
    ],
  };
  l.pages = [overview, homePage, aiPage, keys, byId("dev")];
  return l;
}
const LAYOUT = demoLayout();
const icons = new Icons({ catalog: async () => null } as any);
const ASSETS = await icons.layoutAssets(LAYOUT).catch(() => ({}));

// ---------------------------------------------------------------- mock agent
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
const jsonRes = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const file = (p: string) => (existsSync(p) ? new Response(Bun.file(p), { headers: { "content-type": MIME[extname(p)] || "application/octet-stream" } }) : null);
const DEVICES = [
  { id: "d1", name: "iPhone 8", model: "iPhone", createdAt: new Date(Date.now() - 20 * 86400000).toISOString(), lastSeen: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 86400000).toISOString(), current: false, online: true },
  { id: "d2", name: "iPad mini", model: "iPad", createdAt: new Date(Date.now() - 40 * 86400000).toISOString(), lastSeen: new Date(Date.now() - 3600000).toISOString(), expiresAt: new Date(Date.now() + 40 * 86400000).toISOString(), current: false, online: false },
];
const POSTERS = new Map<string, string>();

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, server) {
    const u = new URL(req.url);
    const p = u.pathname;
    if (p === "/ws") return new Response("no ws in capture mode", { status: 400 });
    if (p.startsWith("/__poster/")) {
      const html = POSTERS.get(p.slice(10));
      return html ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 });
    }
    if (p.startsWith("/__file/")) return file(join(ROOT, p.slice(8))) || new Response("no", { status: 404 });
    if (p.startsWith("/api/")) {
      if (p === "/api/layout") return jsonRes(LAYOUT);
      if (p === "/api/layout/assets") return jsonRes(ASSETS);
      if (p === "/api/info") return jsonRes({ host: "My computer", platform: "darwin", version: "0.2.0", build: "demo", ips: ["192.168.1.20"], port: 7420, url: "http://192.168.1.20:7420", pin: "000000" });
      if (p === "/api/about") return jsonRes({ name: "Nookdeck", version: "0.2.0", build: "demo", repo: "https://github.com/howznguyen/nookdeck", license: "MIT" });
      if (p === "/api/devices") return jsonRes(DEVICES);
      if (p === "/api/pairing") return jsonRes({ pin: "000000", url: "http://192.168.1.20:7420", expiresAt: Date.now() + 600000, qr: "" });
      if (p === "/api/icons/catalog") return jsonRes({ icons: {}, brands: {} });
      if (p === "/api/apps") return jsonRes([]);
      if (p === "/api/icons") return jsonRes([]);
      if (p === "/api/sounds") return jsonRes([]);
      if (p === "/api/plugins") return jsonRes([]);
      if (p === "/api/update") return jsonRes({ current: "0.2.0", latest: "0.2.0", available: false });
      if (p === "/api/integrations") return jsonRes({});
      if (p === "/api/hass/status") return jsonRes({ connected: false });
      if (p === "/api/webhooks") return jsonRes({ enabled: false });
      if (req.method !== "GET") return jsonRes({ ok: true });
      return jsonRes({});
    }
    if (p === "/manage") return new Response(null, { status: 302, headers: { location: "/manage/" } });
    if (p.startsWith("/manage/")) {
      const rel = p.slice(8) || "index.html";
      return file(join(MANAGE_DIST, rel)) || file(join(MANAGE_DIST, "index.html"))!;
    }
    const rel = p === "/" ? "index.html" : p.slice(1);
    return file(join(DECK_DIST, rel)) || new Response("not found", { status: 404 });
  },
});
const BASE = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------- Chrome (CDP)
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${join(TMP, "chrome")}`, "--headless=new", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--font-render-hinting=none", "about:blank"], { stdio: "ignore" });
const cleanup = () => {
  try { chrome.kill(); } catch { /* gone */ }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function connect(): Promise<WebSocket> {
  for (let i = 0; i < 80; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      const ws = new WebSocket(j.webSocketDebuggerUrl);
      await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error("ws")); });
      return ws;
    } catch { await Bun.sleep(150); }
  }
  throw new Error("Chrome did not start");
}
const ws = await connect();
let seq = 0;
const waiting = new Map<number, (r: any) => void>();
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)!(m); waiting.delete(m.id); }
};
const cdp = (method: string, params: any = {}, sessionId?: string) =>
  new Promise<any>((ok, bad) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? bad(new Error(method + ": " + m.error.message)) : ok(m.result)));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

class Tab {
  constructor(public sid: string) {}
  static async open(w: number, h: number, dpr: number): Promise<Tab> {
    const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    const t = new Tab(sessionId);
    await t.send("Page.enable");
    await t.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
    await t.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 10, g: 11, b: 14, a: 1 } });
    return t;
  }
  send(method: string, params: any = {}) { return cdp(method, params, this.sid); }
  async goto(url: string) { await this.send("Page.navigate", { url }); await Bun.sleep(400); }
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async until(expr: string, ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (await this.eval(expr)) return; } catch { /* page not ready */ } await Bun.sleep(150); }
    throw new Error("timeout waiting for: " + expr);
  }
  async shot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    const r = await this.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    return Buffer.from(r.data, "base64");
  }
  async jpeg(): Promise<Buffer> {
    const r = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
    return Buffer.from(r.data, "base64");
  }
  close() { return this.send("Page.close").catch(() => undefined); }
}

// ---------------------------------------------------------------- deck preview helper (page script run inside a poster/page)
const DECK_URL = `${BASE}/?preview=1`;
const pvMsg = (pageId: string, np = "") => ({ type: "pd-preview", layout: LAYOUT, pageId, np });
/** runs in a page that holds an <iframe id=...> of the deck */
const postJs = (sel: string, pageId: string, np = "") => `(function(){var f=document.querySelector(${JSON.stringify(sel)});f.contentWindow.postMessage(${JSON.stringify({ ...pvMsg(pageId, np), assets: ASSETS })},'*');})()`;

// ---------------------------------------------------------------- poster composer
const MARK = readFileSync(join(ROOT, "docs/brand/nookdeck-mark.svg"), "utf8");
const GH = `<svg viewBox="0 0 16 16" width="19" height="19" fill="#e6e8ec"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;
const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden}
body{background:#0a0b0e;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.dots{position:absolute;inset:0;background-image:radial-gradient(circle,rgba(34,211,238,.85) 1.3px,transparent 1.6px);background-size:11px 11px;-webkit-mask-image:radial-gradient(ellipse 75% 85% at 100% 0%,#000 0%,rgba(0,0,0,.5) 35%,transparent 75%);mask-image:radial-gradient(ellipse 75% 85% at 100% 0%,#000 0%,rgba(0,0,0,.5) 35%,transparent 75%);opacity:.75}
.logo{position:absolute;left:54px;top:42px;display:flex;align-items:center;gap:10px;font-weight:700;font-size:22px;letter-spacing:-.02em}
.logo svg{width:24px;height:24px}
.txt{position:absolute;left:54px;width:350px}
.eye{color:#22d3ee;letter-spacing:.2em;font-weight:700;font-size:12.5px;text-transform:uppercase;margin-bottom:16px}
h1{font-size:44px;line-height:.93;letter-spacing:-.045em;font-weight:800;margin-bottom:18px}
.p{color:#9a9ca4;font-size:16.5px;line-height:1.4;margin-bottom:22px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{border:1px solid #2a2c33;background:#14161a;border-radius:99px;padding:5px 14px;font-size:12.5px;font-weight:500;color:#eceef2}
.foot{position:absolute;left:54px;bottom:34px;display:flex;align-items:center;gap:10px;font-size:16px;color:#cfd2d8}
.foot b{color:#22d3ee;font-weight:600}
.phone{position:absolute;background:#1b1c21;border:1px solid #3a3b42;box-shadow:0 30px 80px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.04)}
.phone .scr{position:absolute;overflow:hidden;background:#0b0d10}
.phone iframe{position:absolute;left:0;top:0;border:0;width:844px;height:390px;transform-origin:0 0;background:#0b0d10}
.win{position:absolute;background:#0f1013;border:1px solid #2a2c33;border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.5)}
.win .bar{height:28px;background:#17181c;display:flex;align-items:center;padding:0 12px;gap:7px}
.win .bar i{width:11px;height:11px;border-radius:50%;display:block}
.win .url{margin-left:18px;background:#23242a;border-radius:7px;padding:3px 22px;font-size:11.5px;color:#9a9ca4}
.win img{display:block;width:100%}
`;
interface PhoneSpec { left: number; top: number; w: number; h?: number; pageId: string; np?: string; id: string; pad?: number }
function phoneHtml(s: PhoneSpec) {
  const pad = s.pad ?? 10;
  const scale = (s.w - pad * 2) / 844;
  const ih = Math.round(390 * scale);
  const h = ih + pad * 2;
  const rad = Math.round(s.w * 0.075);
  return `<div class="phone" style="left:${s.left}px;top:${s.top}px;width:${s.w}px;height:${h}px;border-radius:${rad}px"><div class="scr" style="left:${pad}px;top:${pad}px;width:${s.w - pad * 2}px;height:${ih}px;border-radius:${Math.max(8, rad - pad)}px"><iframe id="${s.id}" src="${DECK_URL}" style="transform:scale(${scale})"></iframe></div></div>`;
}
interface PosterSpec {
  name: string;
  eyebrow: string;
  title: string;
  body: string;
  chips: string[];
  txtTop: number;
  phones: PhoneSpec[];
  extra?: string;
  w?: number;
  h?: number;
  outFile: string;
  outSize?: [number, number];
}
async function poster(s: PosterSpec) {
  const w = s.w ?? 1200;
  const h = s.h ?? 675;
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="dots"></div>
<div class="logo">${MARK.replace(/<svg /, "<svg ")}<span>Nookdeck</span></div>
<div class="txt" style="top:${s.txtTop}px"><div class="eye">${s.eyebrow}</div><h1>${s.title}</h1><div class="p">${s.body}</div><div class="chips">${s.chips.map((c) => `<span class="chip">${c}</span>`).join("")}</div></div>
<div class="foot">${GH}<span>github.com/</span><b>howznguyen/nookdeck</b></div>
${s.extra ?? ""}
${s.phones.map(phoneHtml).join("")}`;
  POSTERS.set(s.name, html);
  const tab = await Tab.open(w, h, (s.outSize ? s.outSize[0] : w * 2) / w);
  await tab.goto(`${BASE}/__poster/${s.name}`);
  await settle(tab, s.phones);
  const buf = await tab.shot();
  await tab.close();
  writeFileSync(s.outFile, buf);
  console.log("wrote", s.outFile);
}
async function settle(tab: Tab, phones: PhoneSpec[]) {
  for (const p of phones) {
    await tab.until(`!!document.getElementById(${JSON.stringify(p.id)}) && !!document.getElementById(${JSON.stringify(p.id)}).contentDocument && !!document.getElementById(${JSON.stringify(p.id)}).contentDocument.querySelector('.pd-root')`);
    await tab.eval(postJs("#" + p.id, p.pageId, p.np || ""));
  }
  await Bun.sleep(1400);
  for (const p of phones) await tab.until(`document.getElementById(${JSON.stringify(p.id)}).contentDocument.querySelectorAll('.pd-tile').length > 0`);
  // the page scroll of the first message can run before the layout is laid out: send it again
  for (const p of phones) await tab.eval(postJs("#" + p.id, p.pageId, p.np || ""));
  await Bun.sleep(1800);
}

// ---------------------------------------------------------------- manage shots
async function manageShot(hash: string, out: string, setup?: (t: Tab) => Promise<void>, size: [number, number] = [1500, 950], dpr = 1) {
  const tab = await Tab.open(size[0], size[1], dpr);
  await tab.goto(`${BASE}/manage/`);
  await tab.eval(`try{localStorage.clear();sessionStorage.clear()}catch(e){}`); // each shot starts from the defaults
  await tab.goto(`${BASE}/manage/${hash}`);
  await tab.until(`!!document.querySelector('iframe')`, 20000);
  await Bun.sleep(1200);
  if (setup) await setup(tab);
  await Bun.sleep(1600);
  const buf = await tab.shot();
  await tab.close();
  writeFileSync(out, buf);
  console.log("wrote", out);
}
const clickText = (t: Tab, text: string, sel = "button,[role=tab],a,div") =>
  t.eval(`(function(){var els=[].slice.call(document.querySelectorAll(${JSON.stringify(sel)}));var m=els.filter(function(e){return e.children.length<4&&e.textContent.trim()===${JSON.stringify(text)}});if(!m.length)return false;m[0].click();return true})()`);

const mouse = async (t: Tab, x: number, y: number) => {
  await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const collapseSidebar = async (t: Tab) => { await mouse(t, 284, 24); await Bun.sleep(700); };
/** click a tile inside the preview iframe (manage selects it through pd-select) */
const clickTile = async (t: Tab, id: string) => {
  const r = await t.eval<{ x: number; y: number }>(`(function(){var f=document.querySelector('iframe');var fr=f.getBoundingClientRect();var sc=fr.width/f.clientWidth;var e=f.contentDocument.querySelector('[data-id=${JSON.stringify(id)}]');var b=e.getBoundingClientRect();return {x:fr.left+(b.left+b.width/2)*sc,y:fr.top+(b.top+b.height/2)*sc}})()`);
  await mouse(t, r.x, r.y);
};
const pickDevice = (t: Tab, match: string) =>
  t.eval(`(function(){var s=document.querySelector('select');if(!s)return 'no select';var o=[].slice.call(s.options).filter(function(o){return o.text.indexOf(${JSON.stringify(match)})>=0})[0];if(!o)return 'no option '+[].slice.call(s.options).map(function(o){return o.text}).join('|');s.value=o.value;s.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`);

const IMG = join(ROOT, "docs/images");
const BRAND = join(ROOT, "docs/brand");

// ---------------------------------------------------------------- run
try {
  if (want("manage-tile") || want("manage-theme") || want("manage-screen-size") || want("promo-hero") || want("social")) {
    // manage-*.png: 1500x950, real manage UI over mock /api
    if (want("manage-screen-size")) await manageShot("", join(IMG, "manage-screen-size.png"), async (t) => { await collapseSidebar(t); console.log("device:", await pickDevice(t, "568")); });
    if (want("manage-theme")) await manageShot("#theme", join(IMG, "manage-theme.png"), async (t) => { await collapseSidebar(t); });
    if (want("manage-tile")) await manageShot("", join(IMG, "manage-tile.png"), async (t) => { await collapseSidebar(t); await clickText(t, "Tiles · 8"); await Bun.sleep(500); await clickTile(t, "w-clock"); });
    // tall capture used inside the hero / social card
    await manageShot("", join(TMP, "manage-wide.png"), undefined, [1280, 760], 2);
  }
  const manageWide = existsSync(join(TMP, "manage-wide.png")) ? "data:image/png;base64," + readFileSync(join(TMP, "manage-wide.png")).toString("base64") : "";
  const browser = (left: number, top: number, w: number, img: string) =>
    `<div class="win" style="left:${left}px;top:${top}px;width:${w}px"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span class="url">localhost:7420/manage</span></div><img src="${img}"></div>`;

  if (want("promo-hero")) {
    await poster({
      name: "hero", eyebrow: "Open source · MIT", title: "Your old phone,<br>a control panel<br>for your computer.", body: "Stream Deck-style keys, live stats, AI quotas and Claude Code prompts on any phone on your Wi-Fi.", chips: ["No app", "No account", "No cloud"], txtTop: 175,
      extra: browser(517, 67, 638, manageWide), phones: [{ id: "p1", left: 615, top: 375, w: 545, pageId: "overview" }], outFile: join(IMG, "promo-hero.png"),
    });
  }
  const side = (name: string, eyebrow: string, title: string, body: string, chips: string[], pageId: string, outName: string, np = "", txtTop = 195, extra = "") =>
    poster({ name, eyebrow, title, body, chips, txtTop, phones: [{ id: "p1", left: 450, top: 150, w: 695, pageId, np }], extra, outFile: join(IMG, outName) });
  if (want("promo-ai")) await side("ai", "AI coding", "Every quota,<br>one glance.", "Claude, Codex and Antigravity limits with reset times, plus the AI sessions running on your machine. Read-only, from the sign-ins you already have.", ["Claude", "Codex", "Antigravity"], "ai", "promo-ai.png", "", 190);
  if (want("promo-claude")) await side("claude", "Claude Code", "Answer Claude<br>from the couch.", "Permission prompts and multiple-choice questions pop up on your phone. Tap an answer and Claude keeps working. No reply in time? It asks in the terminal as usual.", ["Allow / Deny", "AskUserQuestion", "Opt-in hooks"], "overview", "promo-claude.png", "question", 190);
  if (want("promo-keys")) await side("keys", "Shortcuts", "A Stream Deck<br>you already own.", "Open apps, fire key combos, type text, run macros and control media. Drag features onto a fixed grid in the management page.", ["Apps", "Hotkeys", "Macros", "Media"], "home", "promo-keys.png", "", 205);
  if (want("promo-home")) {
    await poster({
      name: "home", eyebrow: "Home Assistant", title: "Your home,<br>next to your work.", body: "RGB lights with colour, scenes and effects, climate, fans, blinds and sensors, one tap away. Optional, and your token never leaves the computer.", chips: ["RGB lights", "Scenes", "Climate", "Sensors"], txtTop: 190,
      phones: [{ id: "p1", left: 465, top: 52, w: 680, pageId: "ha" }, { id: "p2", left: 697, top: 409, w: 470, pageId: "ha", np: "ha-sheet:light" }], outFile: join(IMG, "promo-home.png"),
    });
  }
  if (want("social")) {
    await poster({
      name: "social", eyebrow: "Open source · MIT", title: "Your old phone,<br>a control panel<br>for your computer.", body: "Stream Deck-style keys, live stats, AI quotas and Claude Code prompts on any phone on your Wi-Fi.", chips: ["No app", "No account", "No cloud"], txtTop: 110,
      w: 1280, h: 720, extra: browser(552, 70, 680, manageWide), phones: [{ id: "p1", left: 656, top: 400, w: 580, pageId: "overview" }], outFile: join(BRAND, "social-preview.png"), outSize: [1280, 720],
    });
  }

  // ---- demo.gif: 960x444, a tour of the deck (overview, AI, keys, home, climate sheet, question, permission)
  if (want("demo")) {
    const tab = await Tab.open(960, 444, 1);
    await tab.goto(DECK_URL);
    await tab.until(`!!document.querySelector('.pd-root')`);
    const steps: [string, string, number][] = [["overview", "", 2.0], ["ai", "", 2.2], ["home", "", 2.2], ["ha", "", 2.0], ["ha", "ha-sheet:climate", 2.2], ["overview", "question", 2.6], ["overview", "permission", 2.6]];
    const frames = join(TMP, "frames");
    mkdirSync(frames, { recursive: true });
    const FPS = 6;
    let n = 0;
    for (const [pg, np, secs] of steps) {
      await tab.eval(`window.postMessage(${JSON.stringify({ ...pvMsg(pg, np), assets: ASSETS })},'*')`);
      await Bun.sleep(500);
      await tab.eval(`window.postMessage(${JSON.stringify({ ...pvMsg(pg, np), assets: ASSETS })},'*')`);
      await Bun.sleep(900);
      const frameCount = Math.round(secs * FPS);
      for (let i = 0; i < frameCount; i++) {
        const t0 = Date.now();
        writeFileSync(join(frames, `f${String(n++).padStart(4, "0")}.jpg`), await tab.jpeg());
        await Bun.sleep(Math.max(0, 1000 / FPS - (Date.now() - t0)));
      }
    }
    await tab.close();
    const out = join(IMG, "demo.gif");
    sh("ffmpeg", ["-loglevel", "error", "-y", "-framerate", String(FPS), "-i", join(frames, "f%04d.jpg"), "-vf", "fps=12,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", out]);
    console.log("wrote", out);
  }
} finally {
  cleanup();
}
process.exit(0);
