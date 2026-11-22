import type { GpuStats } from "../../stats";

/**
 * GPU utilisation the way Task Manager shows it. `\GPU Engine(*)\Utilization Percentage` has one instance per process and engine,
 * named like `pid_123_luid_0x00000000_0x0000A5B2_phys_0_eng_0_engtype_VideoDecode`. Per adapter (luid) and engine type the instances
 * add up (capped at 100); the adapter's figure is the max over its engine types (3D, VideoDecode, Copy, Compute_0 ...); the busiest
 * adapter wins. Samples that do not name an adapter or engine type are ignored.
 */
export function gpuUtilFromEngines(samples: ReadonlyArray<readonly [string, number]>): number {
  const sums = new Map<string, number>(); // "luid|engtype" -> sum
  for (const [name, value] of samples) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const luid = /luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i.exec(name)?.[1]?.toLowerCase();
    const eng = /engtype_(\w+)/i.exec(name)?.[1]?.toLowerCase();
    if (!luid || !eng) continue;
    const k = `${luid}|${eng}`;
    sums.set(k, (sums.get(k) ?? 0) + value);
  }
  let best = 0;
  for (const v of sums.values()) best = Math.max(best, Math.min(100, v));
  return Math.round(best * 10) / 10;
}

/** The helper's `gpu.read` reply (engines + memory/name/temp) as GpuStats input; undefined when the counters were unavailable. */
export function gpuFromHelper(raw: any): (Partial<GpuStats> & { util: number }) | undefined {
  if (!raw || !Array.isArray(raw.engines)) return undefined;
  const { engines: list, ...rest } = raw;
  // Windows PowerShell 5.1 can flatten a one-sample list to ["name", 1] instead of [["name", 1]]
  const engines: unknown[] = typeof list[0] === "string" ? [list] : list;
  return { ...rest, util: gpuUtilFromEngines((engines.filter((e): e is any[] => Array.isArray(e) && typeof e[0] === "string")).map((e) => [e[0] as string, Number(e[1])] as const)) };
}
