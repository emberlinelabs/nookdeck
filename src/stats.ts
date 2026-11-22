import { cpus, freemem, hostname, loadavg, totalmem, uptime } from "node:os";
import { getVolumeCached, type VolumeState } from "./actions";
import { platform } from "./platform";

/** GPU figures; the whole object is omitted from Stats when the OS cannot tell. */
export interface GpuStats {
  util: number; // 0-100
  memUsed?: number; // bytes
  memTotal?: number; // bytes
  temp?: number; // degrees Celsius
  name?: string;
}

/** Pure: cleans whatever a platform returned into a GpuStats (util clamped to 0-100, bad optional fields dropped), or undefined. */
export function cleanGpu(raw: any): GpuStats | undefined {
  const util = Number(raw?.util);
  if (raw?.util === null || raw?.util === undefined || !Number.isFinite(util)) return undefined;
  const out: GpuStats = { util: Math.round(Math.min(100, Math.max(0, util)) * 10) / 10 };
  const bytes = (v: unknown) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : undefined);
  const memUsed = bytes(raw.memUsed);
  const memTotal = bytes(raw.memTotal);
  if (memUsed !== undefined) out.memUsed = memUsed;
  if (memTotal !== undefined && memTotal > 0) out.memTotal = memTotal;
  if (out.memUsed !== undefined && out.memTotal !== undefined) out.memUsed = Math.min(out.memUsed, out.memTotal);
  const temp = Number(raw.temp);
  if (raw.temp !== null && raw.temp !== undefined && raw.temp !== "" && Number.isFinite(temp) && temp > 0 && temp < 150) out.temp = Math.round(temp);
  if (typeof raw.name === "string" && raw.name.trim()) out.name = raw.name.trim().slice(0, 80);
  return out;
}

export interface Stats {
  cpu: number; // 0-100
  memUsed: number; // bytes
  memTotal: number; // bytes
  uptime: number; // seconds
  load: [number, number, number];
  /** "loadavg": the OS load average; "estimate": exponentially averaged busy cores (Windows has no load average). */
  loadKind: "loadavg" | "estimate";
  time: number; // ms since epoch
  host: string; // computer name without ".local"
  net: { rx: number; tx: number }; // bytes/s over non-loopback interfaces
  volume: VolumeState | null; // output volume, null when unknown
  /** Omitted when unknown (Linux, no GPU, a failed read). */
  gpu?: GpuStats;
}

export type NetCounters = Record<string, { rx: number; tx: number }>;

const VIRTUAL_IFACE = /^(lo|gif|stf|utun|awdl|llw|ap|bridge|anpi|docker|veth|br-|virbr|vEthernet|VMware|VirtualBox|Loopback|isatap|Teredo|Bluetooth)/i;

/** Pure: per-interface cumulative byte counters from `netstat -ibn` (macOS), counting only the <Link#> rows. */
export function parseNetstat(output: string): NetCounters {
  const result: NetCounters = {};
  const lines = output.split("\n");
  const header = lines.find((l) => /^Name\s+Mtu/.test(l))?.trim().split(/\s+/);
  if (!header) return result;
  const fromEnd = (name: string) => header.length - header.indexOf(name);
  const ib = fromEnd("Ibytes");
  const ob = fromEnd("Obytes");
  if (ib > header.length || ob > header.length) return result;
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 7 || !/^<Link#\d+>$/.test(cols[2] ?? "")) continue;
    const name = cols[0]!.replace(/\*$/, "");
    const rx = Number(cols[cols.length - ib]);
    const tx = Number(cols[cols.length - ob]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    result[name] = { rx, tx };
  }
  return result;
}

/** Pure: per-interface counters from Linux /proc/net/dev. */
export function parseProcNetDev(output: string): NetCounters {
  const result: NetCounters = {};
  for (const line of output.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    if (f.length < 9 || f.some((n) => !Number.isFinite(n))) continue;
    result[m[1]!] = { rx: f[0]!, tx: f[8]! };
  }
  return result;
}

/** Pure: bytes/s between two samples, summed over physical (non-loopback, non-virtual) interfaces present in both. */
export function netRate(prev: NetCounters, cur: NetCounters, seconds: number): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  if (seconds <= 0) return { rx, tx };
  for (const [name, c] of Object.entries(cur)) {
    const p = prev[name];
    if (!p || VIRTUAL_IFACE.test(name)) continue;
    rx += Math.max(0, c.rx - p.rx); // a counter reset counts as 0
    tx += Math.max(0, c.tx - p.tx);
  }
  return { rx: Math.round(rx / seconds), tx: Math.round(tx / seconds) };
}

async function readNet(): Promise<NetCounters | undefined> {
  try {
    return await platform.netCounters();
  } catch {
    return undefined; // unsupported or failed: report zero traffic
  }
}

async function readGpu(): Promise<GpuStats | undefined> {
  try {
    return cleanGpu(await platform.gpu());
  } catch {
    return undefined; // unsupported or failed: the deck just has no gpu figure
  }
}

export function computerName(): string {
  return hostname().replace(/\.local$/i, "");
}

export interface CpuTimes {
  idle: number;
  total: number;
}

export function readCpuTimes(list: ReturnType<typeof cpus> = cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const { times } of list) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** CPU usage in percent (0-100, one decimal) between two samples. */
export function cpuDelta(prev: CpuTimes, cur: CpuTimes): number {
  const total = cur.total - prev.total;
  const idle = cur.idle - prev.idle;
  if (total <= 0) return 0;
  const pct = (1 - idle / total) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

/**
 * Parses `vm_stat` output into used bytes (active + wired + compressor pages).
 * Returns undefined when the output does not have the expected fields.
 */
export function parseVmStat(output: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/i.exec(output)?.[1]);
  if (!pageSize) return undefined;
  const pages = (label: RegExp): number | undefined => {
    const m = label.exec(output);
    return m ? Number(m[1]) : undefined;
  };
  const active = pages(/^Pages active:\s+(\d+)/m);
  const wired = pages(/^Pages wired down:\s+(\d+)/m);
  const compressed = pages(/^Pages occupied by compressor:\s+(\d+)/m) ?? 0;
  if (active === undefined || wired === undefined) return undefined;
  return (active + wired + compressed) * pageSize;
}

async function memUsed(): Promise<number> {
  const total = totalmem();
  const used = await platform.memUsed().catch(() => undefined);
  if (used !== undefined) return Math.min(used, total);
  return total - freemem();
}

/**
 * Load average for systems that have none: the number of busy cores, averaged over 1, 5 and 15 minutes the way Unix
 * does (exponential decay). The first sample seeds all three, so the figure is meaningful at once instead of climbing
 * from zero for a quarter of an hour.
 */
export class LoadEstimator {
  private v: [number, number, number] | undefined;
  update(busyCores: number, dtSec: number): [number, number, number] {
    if (!this.v) return (this.v = [busyCores, busyCores, busyCores]);
    const dt = Math.max(0, dtSec);
    const k = (w: number) => Math.exp(-dt / w);
    const [a, b, c] = this.v;
    return (this.v = [busyCores + (a - busyCores) * k(60), busyCores + (b - busyCores) * k(300), busyCores + (c - busyCores) * k(900)]);
  }
}

/** Emits stats shortly after start, then every `intervalMs`. Returns a stop function. */
export function startStats(onTick: (s: Stats) => void, intervalMs = 2000): () => void {
  let stopped = false;
  let busy = false;
  let prev = readCpuTimes();
  let prevNet: NetCounters | undefined;
  let prevNetAt = 0;
  const estimator = new LoadEstimator();
  let prevLoadAt = 0;
  const host = computerName();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const cur = readCpuTimes();
      const cpu = cpuDelta(prev, cur);
      prev = cur;
      const [used, netNow, gpu] = await Promise.all([memUsed(), readNet(), readGpu()]);
      if (stopped) return;
      const at = Date.now();
      const net = prevNet && netNow ? netRate(prevNet, netNow, (at - prevNetAt) / 1000) : { rx: 0, tx: 0 };
      if (netNow) {
        prevNet = netNow;
        prevNetAt = at;
      }
      const kind = platform.loadKind;
      let load: [number, number, number];
      if (kind === "estimate") { load = estimator.update((cpu / 100) * cpus().length, prevLoadAt ? (at - prevLoadAt) / 1000 : 0); prevLoadAt = at; }
      else { const [l1 = 0, l5 = 0, l15 = 0] = loadavg(); load = [l1, l5, l15]; }
      onTick({ cpu, memUsed: used, memTotal: totalmem(), uptime: uptime(), load, loadKind: kind, time: at, host, net, volume: getVolumeCached(), ...(gpu ? { gpu } : {}) });
    } catch {
      // a failed sample must not kill the loop
    } finally {
      busy = false;
    }
  };

  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      await tick();
      if (!stopped) schedule(intervalMs);
    }, delay);
  };
  schedule(Math.min(500, intervalMs));

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
