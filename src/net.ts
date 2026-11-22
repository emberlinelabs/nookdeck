import { platform } from "./platform";
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { findCli } from "./ai/find-cli";
import { runCapture } from "./platform/exec";
import { t } from "./i18n";

/** First non-internal IPv4 address, preferring private LAN ranges. Falls back to localhost. */
export function lanIp(): string {
  const candidates: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
    }
  }
  const priv = candidates.find((ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return priv ?? candidates[0] ?? "localhost";
}

export function isLocal(ip: string | undefined | null): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

let cachedHost: string | undefined;

/**
 * The name other devices on the LAN can reach this machine by (`<name>.local`, mDNS/Bonjour): the macOS LocalHostName
 * (`scutil --get LocalHostName`), else the first label of os.hostname(). Stays the same when the IP changes.
 */
export async function localHostName(run?: (argv: string[]) => Promise<string>): Promise<string> {
  if (cachedHost && !run) return cachedHost;
  let name = "";
  try {
    // an injected runner stands in for the macOS `scutil` call (tests); otherwise the platform knows its LAN name
    name = (run ? (platform.id === "darwin" ? await run(["scutil", "--get", "LocalHostName"]) : "") : (await platform.lanName()) ?? "").trim();
  } catch {
    /* fall through */
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) name = hostname().split(".")[0]!.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "localhost";
  if (!run) cachedHost = name;
  return name;
}


// ---------- every address a phone could use ----------

export type AddressKind = "local" | "lan" | "tailscale" | "vpn" | "other";
export interface PhoneAddress { id: string; kind: AddressKind; host: string; label: string; note?: string; iface?: string; subnet?: string }

const num = (ip: string): number => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
const inRange = (ip: string, base: string, bits: number): boolean => Math.floor(num(ip) / 2 ** (32 - bits)) === Math.floor(num(base) / 2 ** (32 - bits));
export const isTailnetIp = (ip: string): boolean => inRange(ip, "100.64.0.0", 10);
export const isPrivateIp = (ip: string): boolean => inRange(ip, "10.0.0.0", 8) || inRange(ip, "172.16.0.0", 12) || inRange(ip, "192.168.0.0", 16);
/** "192.168.50.0/24" from an address and its netmask (/24 when the mask is missing). */
export function subnetOf(ip: string, netmask?: string): string {
  const m = netmask && /^\d+\.\d+\.\d+\.\d+$/.test(netmask) ? netmask : "255.255.255.0";
  const bits = m.split(".").reduce((n, p) => n + Number(p).toString(2).split("1").length - 1, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (num(ip) & mask) >>> 0;
  return `${[24, 16, 8, 0].map((sh) => (net >>> sh) & 255).join(".")}/${bits}`;
}
const isLinkLocal = (ip: string): boolean => inRange(ip, "169.254.0.0", 16);

/** Virtual switches of VMs and containers: a phone cannot use them. */
const VIRTUAL = /^(docker|br-|veth|vmnet|vboxnet|virbr|lo\d*$|bridge\d|anpi|awdl|llw|gif|stf|ap\d)|vethernet|vmware|virtualbox|hyper-v|wsl|loopback/i;
const VPN = /^(utun|wg|tun|tap|zt|ppp|ipsec)|zerotier|wireguard|vpn|openvpn|tailscale/i;

function ifaceLabel(name: string, id: string): string {
  if (id === "win32") return name;
  if (id === "darwin") return name === "en0" ? "Wi-Fi" : /^en\d+$/.test(name) ? "Ethernet" : name;
  return /^(wl|wlan)/i.test(name) ? "Wi-Fi" : /^(en|eth)/i.test(name) ? "Ethernet" : name;
}
const rank = (a: PhoneAddress): number => ({ lan: 0, local: 1, tailscale: 2, vpn: 3, other: 4 })[a.kind];

export interface AddressInput {
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** `<LocalHostName>` without ".local" */
  hostName: string;
  /** the MagicDNS name (no trailing dot) when the Tailscale CLI says it is running */
  tailnetName?: string | null;
  platformId?: string;
  /** also virtual adapters (docker, vmnet, vEthernet...) and link-local addresses */
  all?: boolean;
}

/** Every address a phone could use, best first. Loopback, link-local, IPv6 and virtual adapters are left out. */
export function phoneAddresses(o: AddressInput): PhoneAddress[] {
  const id = o.platformId ?? platform.id;
  const out: PhoneAddress[] = [];
  if (o.hostName) {
    out.push({
      id: "local", kind: "local", host: `${o.hostName}.local`, label: t("Computer name"),
      ...(id === "win32" ? { note: t("Some Android phones cannot open .local names; use an IP address if it fails") } : {}),
    });
  }
  const seen = new Set<string>();
  const where = (name: string, a: { address: string; netmask?: string }) => `${a.address} (${subnetOf(a.address, a.netmask)})`;
  for (const [name, addrs] of Object.entries(o.interfaces ?? networkInterfaces())) {
    const virtual = VIRTUAL.test(name);
    if (virtual && !o.all) continue;
    for (const a of addrs ?? []) {
      if ((a.family as unknown) !== "IPv4" && (a.family as unknown) !== 4) continue;
      if (a.internal || seen.has(a.address)) continue;
      const subnet = subnetOf(a.address, a.netmask);
      const linkLocal = isLinkLocal(a.address);
      if (linkLocal && !o.all) continue;
      if (isTailnetIp(a.address)) {
        seen.add(a.address);
        out.push({ id: `tailscale:${a.address}`, kind: "tailscale", host: a.address, label: `Tailscale · ${a.address}`, iface: name });
      } else if (virtual || linkLocal) {
        seen.add(a.address);
        out.push({ id: `other:${a.address}`, kind: "other", host: a.address, label: `${ifaceLabel(name, id)} · ${where(name, a)}`, iface: name, subnet });
      } else if (isPrivateIp(a.address)) {
        seen.add(a.address);
        const kind: AddressKind = VPN.test(name) ? "vpn" : "lan";
        out.push({ id: `${kind}:${a.address}`, kind, host: a.address, label: `${ifaceLabel(name, id)} · ${where(name, a)}`, iface: name, subnet });
      }
    }
  }
  if (o.tailnetName) {
    // the stable name first among the Tailscale entries
    out.push({ id: "tailscale:dns", kind: "tailscale", host: o.tailnetName, label: "Tailscale (MagicDNS)" });
  }
  // stable sort: kind order, the MagicDNS name before the 100.x addresses
  return out
    .map((a, i) => ({ a, i }))
    .sort((x, y) => rank(x.a) - rank(y.a) || (x.a.id === "tailscale:dns" ? -1 : y.a.id === "tailscale:dns" ? 1 : 0) || x.i - y.i)
    .map((x) => x.a);
}

/**
 * The address to show first: the Wi-Fi/Ethernet address the default route uses (`ip` from lanIp()), else the first LAN
 * address, else `<name>.local` (when it resolves), else the first address of any kind. Wi-Fi is what most people pair over;
 * the .local name and Tailscale stay one pick away in the address list.
 */
export function defaultAddress(list: PhoneAddress[], o: { localResolves: boolean; platformId?: string; lanIp?: string }): string | undefined {
  const lan = list.filter((a) => a.kind === "lan");
  const local = o.localResolves ? list.find((a) => a.id === "local") : undefined;
  return (lan.find((a) => a.host === o.lanIp) ?? lan[0] ?? local ?? list.find((a) => a.kind !== "local") ?? list[0])?.id;
}

/** Does `<name>.local` answer on this machine (mDNS)? Short timeout, cached 60 s. */
let resolveCache: { name: string; at: number; ok: boolean } | undefined;
export async function localResolves(name: string, look: (h: string) => Promise<unknown> = (h) => lookup(h), now = Date.now()): Promise<boolean> {
  if (resolveCache && resolveCache.name === name && now - resolveCache.at < 60_000) return resolveCache.ok;
  let ok = false;
  try { ok = !!(await Promise.race([look(`${name}.local`), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800))])); } catch { ok = false; }
  resolveCache = { name, at: now, ok };
  return ok;
}

const TAILSCALE_DIRS = (): string[] => (platform.id === "win32"
  ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale")]
  : ["/Applications/Tailscale.app/Contents/MacOS"]);
/**
 * Runs the Tailscale CLI. The macOS app's CLI refuses to start ("The Tailscale GUI failed to start") without a TERM variable,
 * which a launchd agent does not have, so one is always set.
 */
async function runTailscale(argv: string[], ms: number): Promise<string> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, env: { ...process.env, TERM: process.env.TERM || "dumb" } } as any);
  const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
  try {
    const text = await new Response(proc.stdout as ReadableStream).text();
    if ((await proc.exited) !== 0) throw new Error("tailscale failed");
    return text;
  } finally { clearTimeout(timer); }
}
let tsCache: { at: number; name: string | null } | undefined;
export const resetTailscaleCache = (): void => { tsCache = undefined; };

/**
 * The MagicDNS name of this machine from `tailscale status --json` (Self.DNSName, trailing dot removed), or null when
 * Tailscale is missing, stopped or slow. 2 s at most, cached 60 s (failures too).
 */
export async function tailnetName(
  run: (argv: string[], ms: number) => Promise<string> = runTailscale,
  bin: string | null = findCli("tailscale", TAILSCALE_DIRS()),
  now = Date.now(),
): Promise<string | null> {
  if (tsCache && now - tsCache.at < 60_000) return tsCache.name;
  let name: string | null = null;
  if (bin) {
    try {
      const j = JSON.parse(await run([bin, "status", "--json"], 2000));
      const dns = typeof j?.Self?.DNSName === "string" ? j.Self.DNSName.replace(/\.$/, "").toLowerCase() : "";
      if ((!j?.BackendState || j.BackendState === "Running") && /^[a-z0-9.-]+$/.test(dns)) name = dns;
    } catch { name = null; }
  }
  tsCache = { at: now, name };
  return name;
}
