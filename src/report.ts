/**
 * "Report a problem": one Markdown text with what a bug report needs (version, OS, doctor, layout size, phones, recent socket
 * drops, the end of the error log, the last phone check), for a GitHub issue. The manage page shows it before anything leaves
 * the computer, and everything personal is masked here first: home folder, user and host names, IP addresses, tailnet names,
 * PINs, tokens and secrets.
 */

export interface SocketDrop { at: number; code: number; reason: string; device: string }

/** The last socket drops with an unusual close code (server.ts records them), newest last. */
export class DropLog {
  private items: SocketDrop[] = [];
  constructor(private readonly max = 20) {}
  add(d: SocketDrop) {
    this.items.push(d);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }
  list(): SocketDrop[] { return [...this.items]; }
}

export interface ReportInput {
  now: number;
  version: string;
  commit?: string;
  os: string;
  arch: string;
  /** Doctor items (status and title; details are masked) */
  doctor: { id: string; title: string; status: string; detail: string }[];
  layout: { pages: number; tiles: number; bytes: number; assets: number; assetBytes: number };
  devices: { name: string; lastSeen?: string; createdAt?: string }[];
  drops: SocketDrop[];
  /** the end of agent.err.log */
  errLog: string;
  /** ~/.nookdeck/logs/phone-check.log when recent */
  phoneCheck?: string;
  /** where the agent listens, its own networks, and who reached it since it started */
  network?: { listen: string; port: number; startedAt: number; nets: Array<{ name: string; address: string; subnet: string }>; visitors: Visit[] };
}

/** How a remote address relates to the computer's networks: "same network as Wi-Fi", "Tailscale", "another network". */
export function relation(address: string, nets: Array<{ name: string; subnet: string }>): string {
  const own = nets.find((n) => inSubnet(address, n.subnet));
  if (own) return `same network as ${own.name}`;
  if (isTailnetIp(address)) return "Tailscale";
  if (address.includes(":")) return "IPv6";
  return "another network (not on any network of this computer)";
}

/** "10.0.26100" -> "11 (build 26100)": Windows 11 still reports kernel 10.0. Other systems unchanged. */
export function windowsVersion(release: string): string {
  const m = /^10\.0\.(\d+)/.exec(release);
  if (!m) return release;
  const build = Number(m[1]);
  return `${build >= 22000 ? "11" : "10"} (build ${build})`;
}

import { inSubnet, isTailnetIp } from "./net";
import type { Visit } from "./visitors";

export interface MaskCtx { home?: string; user?: string; hosts?: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Masks personal data in free text. Pure. */
export function mask(text: string, ctx: MaskCtx = {}): string {
  let s = text;
  if (ctx.home && ctx.home.length > 3) s = s.split(ctx.home).join("~");
  for (const h of ctx.hosts ?? []) {
    const base = h.replace(/\.local$/i, "");
    if (base.length >= 3) s = s.replace(new RegExp(esc(base) + "(\\.local)?", "gi"), "<host>");
  }
  if (ctx.user && ctx.user.length >= 3) s = s.replace(new RegExp(`\\b${esc(ctx.user)}\\b`, "g"), "<user>");
  s = s.replace(/\b[\w-]+(\.[\w-]+)*\.ts\.net\b/gi, "<tailnet>");
  s = s.replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "<email>");
  s = s.replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, (m, a, b) => (m === "127.0.0.1" || m === "0.0.0.0" ? m : `${a}.${b}.x.x`));
  s = s.replace(/\b(PIN|pin)([:= ]+)\d{4,8}\b/g, "$1$2<pin>");
  s = s.replace(/([?&](token|pin|key|secret)=)[^&\s"']+/gi, "$1<redacted>");
  s = s.replace(/\b(Bearer|token|secret|password|apikey|api_key)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2<redacted>");
  s = s.replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "<redacted>");
  return s;
}

/** Folds runs of the same line ("[watchdog] the event loop was blocked for 12 s" x 30) into one line with a count. Pure. */
export function foldRepeats(log: string): string {
  const out: string[] = [];
  let last = "";
  let n = 0;
  const key = (l: string) => l.replace(/\d+/g, "#");
  const flush = () => { if (n > 1) out[out.length - 1] += `  (x${n}, numbers vary)`; };
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (key(line) === last) { n++; continue; }
    flush();
    out.push(line);
    last = key(line);
    n = 1;
  }
  flush();
  return out.join("\n");
}

const ago = (now: number, iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "never";
  const m = Math.round((now - t) / 60000);
  return m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const kb = (n: number) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + " MB" : Math.round(n / 1024) + " KB");
const fence = (s: string) => "```\n" + s.replace(/```/g, "'''") + "\n```";

/** The report as Markdown. Pure: the caller gathers the input; every free text goes through mask(). */
export function buildReport(r: ReportInput, ctx: MaskCtx = {}): string {
  const m = (s: string) => mask(s, ctx);
  const lines: string[] = [];
  lines.push("<!-- Describe the problem above this line: what you did, what you expected, what happened, and the phone (model, iOS/Android version, browser). -->", "");
  lines.push("### Nookdeck report", "");
  lines.push(`- Version: ${r.version}${r.commit ? ` (${r.commit})` : ""}`);
  lines.push(`- System: ${r.os} ${r.arch}`);
  lines.push(`- Layout: ${r.layout.pages} pages, ${r.layout.tiles} tiles, ${r.layout.assets} icons; the layout message is ${kb(r.layout.bytes)} (icons ${kb(r.layout.assetBytes)})`);
  lines.push(`- Created: ${new Date(r.now).toISOString()}`, "");
  if (r.doctor.length) {
    lines.push("#### Doctor", "");
    // the network items keep their detail when ok: which network, and what the firewall allows on it
    const always = new Set(["network", "firewall"]);
    for (const d of r.doctor) lines.push(`- ${d.status === "ok" ? "ok" : d.status.toUpperCase()}: ${m(d.title)}${(d.status === "ok" && !always.has(d.id)) || d.status === "n/a" ? "" : ` - ${m(d.detail)}`}`);
    lines.push("");
  }
  if (r.network) {
    const n = r.network;
    lines.push("#### Network", "");
    lines.push(`- Listening on ${n.listen}:${n.port}${n.listen === "0.0.0.0" ? " (every network)" : ""}; the agent started ${ago(r.now, new Date(n.startedAt).toISOString())}`);
    if (!n.nets.length) lines.push("- no network connection (only localhost)");
    for (const x of n.nets) lines.push(`- ${m(x.name)}: ${m(x.address)} in ${m(x.subnet)}${isTailnetIp(x.address) ? " (Tailscale)" : ""}`);
    lines.push("", "#### Who reached this computer (since the agent started)", "");
    if (!n.visitors.length) {
      lines.push("- nobody: no phone or other device has opened Nookdeck on this computer. A phone that cannot load the page is stopped before it gets here: it is on another network or mobile data, the router keeps its devices apart (guest Wi-Fi, AP isolation), or the firewall blocks it.");
    }
    for (const v of n.visitors) {
      const did = [v.page && "opened the page", v.paired && "paired", v.pinFails && `${v.pinFails} wrong PIN${v.pinFails > 1 ? "s" : ""}`, v.device && `connected as ${m(v.device)}`].filter(Boolean).join(", ") || "made requests";
      lines.push(`- ${m(v.address)} (${relation(v.address, n.nets)}): ${did}; ${v.hits} request${v.hits > 1 ? "s" : ""}, last ${ago(r.now, new Date(v.last).toISOString())}`);
    }
    lines.push("");
  }
  lines.push("#### Phones", "");
  if (!r.devices.length) lines.push("- none paired");
  for (const d of r.devices) lines.push(`- ${m(d.name)}: last connected ${ago(r.now, d.lastSeen)}, paired ${ago(r.now, d.createdAt)}`);
  lines.push("");
  lines.push("#### Unusual WebSocket closes", "");
  if (!r.drops.length) lines.push("- none since the agent started");
  for (const d of r.drops) lines.push(`- ${new Date(d.at).toISOString()} ${m(d.device)}: ${d.code}${d.reason ? " " + m(d.reason) : ""}`);
  lines.push("");
  const err = foldRepeats(r.errLog).split("\n").slice(-40).join("\n").trim();
  lines.push("<details><summary>Error log (last lines)</summary>", "", fence(err ? m(err) : "(empty)"), "", "</details>", "");
  if (r.phoneCheck?.trim()) lines.push("<details><summary>Last phone check</summary>", "", fence(m(r.phoneCheck.trim())), "", "</details>", "");
  return lines.join("\n");
}

