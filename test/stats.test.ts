import { expect, test } from "bun:test";
import { gpuFromHelper, gpuUtilFromEngines } from "../src/platform/win32/gpu";
import { cleanGpu, cpuDelta, parseVmStat, readCpuTimes, startStats, type Stats } from "../src/stats.ts";

const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     6501.
Pages active:                                 231696.
Pages inactive:                               228660.
Pages wired down:                             221612.
Pages occupied by compressor:                 318255.
`;

test("parseVmStat sums active + wired + compressor", () => {
  expect(parseVmStat(VM)).toBe((231696 + 221612 + 318255) * 16384);
});

test("parseVmStat handles 4k pages and missing compressor", () => {
  const out = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active:   10.\nPages wired down:   5.\n";
  expect(parseVmStat(out)).toBe(15 * 4096);
});

test("parseVmStat returns undefined on garbage", () => {
  expect(parseVmStat("")).toBeUndefined();
  expect(parseVmStat("Pages active: 1.")).toBeUndefined();
});

test("cpuDelta computes percent", () => {
  expect(cpuDelta({ idle: 100, total: 200 }, { idle: 150, total: 300 })).toBe(50);
  expect(cpuDelta({ idle: 0, total: 0 }, { idle: 0, total: 100 })).toBe(100);
  expect(cpuDelta({ idle: 0, total: 0 }, { idle: 100, total: 100 })).toBe(0);
});

test("cpuDelta is safe with no elapsed time", () => {
  expect(cpuDelta({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBe(0);
});

test("readCpuTimes sums cores", () => {
  const t = (user: number, idle: number) => ({ model: "", speed: 0, times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  expect(readCpuTimes([t(1, 3), t(2, 4)])).toEqual({ idle: 7, total: 10 });
});

test("startStats ticks and stops", async () => {
  const seen: Stats[] = [];
  const stop = startStats((s) => seen.push(s), 50);
  await Bun.sleep(process.platform === "win32" ? 4000 : 400); // the first Windows sample waits for the PowerShell helper to start
  stop();
  const n = seen.length;
  expect(n).toBeGreaterThanOrEqual(2);
  const s = seen[n - 1]!;
  expect(s.cpu).toBeGreaterThanOrEqual(0);
  expect(s.cpu).toBeLessThanOrEqual(100);
  expect(s.memTotal).toBeGreaterThan(0);
  expect(s.memUsed).toBeGreaterThan(0);
  expect(s.memUsed).toBeLessThanOrEqual(s.memTotal);
  expect(s.load).toHaveLength(3);
  expect(s.uptime).toBeGreaterThan(0);
  await Bun.sleep(200);
  expect(seen.length).toBe(n);
}, 15000);

test("LoadEstimator: seeded by the first sample, then exponential decay over 1/5/15 minutes", () => {
  const { LoadEstimator } = require("../src/stats") as typeof import("../src/stats");
  const e = new LoadEstimator();
  expect(e.update(2, 0)).toEqual([2, 2, 2]);
  const [a, b, c] = e.update(0, 60);
  expect(a).toBeCloseTo(2 * Math.exp(-1), 5);
  expect(b).toBeCloseTo(2 * Math.exp(-60 / 300), 5);
  expect(c).toBeCloseTo(2 * Math.exp(-60 / 900), 5);
  expect(a).toBeLessThan(b);
  expect(b).toBeLessThan(c);
  const same = e.update(4, 0); // no time passed: no change
  expect(same[0]).toBeCloseTo(a, 9); expect(same[1]).toBeCloseTo(b, 9); expect(same[2]).toBeCloseTo(c, 9);
});

test("every platform says where its load figure comes from", () => {
  const { createPlatform } = require("../src/platform") as typeof import("../src/platform");
  expect(createPlatform("darwin").loadKind).toBe("loadavg");
  expect(createPlatform("win32").loadKind).toBe("estimate");
});

test("cleanGpu clamps utilisation and drops bad optional fields", () => {
  expect(cleanGpu(undefined)).toBeUndefined();
  expect(cleanGpu({})).toBeUndefined();
  expect(cleanGpu({ util: null })).toBeUndefined();
  expect(cleanGpu({ util: "x" })).toBeUndefined();
  expect(cleanGpu({ util: 140 })).toEqual({ util: 100 });
  expect(cleanGpu({ util: -3 })).toEqual({ util: 0 });
  expect(cleanGpu({ util: 12.34, memUsed: 441860096.4, memTotal: 8e9, temp: 61.2, name: " Apple M1 Pro " })).toEqual({ util: 12.3, memUsed: 441860096, memTotal: 8e9, temp: 61, name: "Apple M1 Pro" });
  expect(cleanGpu({ util: 5, memUsed: 9e9, memTotal: 8e9 })).toEqual({ util: 5, memUsed: 8e9, memTotal: 8e9 });
  expect(cleanGpu({ util: 5, memUsed: "n/a", memTotal: 0, temp: 0, name: "  " })).toEqual({ util: 5 });
});

const L1 = "luid_0x00000000_0x0000A5B2";
const L2 = "luid_0x00000000_0x0000B6C3";
test("Windows GPU: instances add up per engine type, then the max over engine types (Task Manager), per adapter", () => {
  expect(gpuUtilFromEngines([])).toBe(0);
  // video decode alone drives the figure (the 3D engine is idle)
  expect(gpuUtilFromEngines([[`pid_1_${L1}_phys_0_eng_0_engtype_VideoDecode`, 22], [`pid_2_${L1}_phys_0_eng_0_engtype_VideoDecode`, 8], [`pid_1_${L1}_phys_0_eng_1_engtype_3D`, 5]])).toBe(30);
  // 3D 40 (two processes) beats copy 15: not summed across engine types
  expect(gpuUtilFromEngines([[`pid_1_${L1}_phys_0_eng_0_engtype_3D`, 25], [`pid_2_${L1}_phys_0_eng_0_engtype_3D`, 15], [`pid_1_${L1}_phys_0_eng_2_engtype_Copy`, 15]])).toBe(40);
  // a sum above 100 is capped; the busiest adapter wins
  expect(gpuUtilFromEngines([[`pid_1_${L1}_phys_0_eng_0_engtype_3D`, 80], [`pid_2_${L1}_phys_0_eng_0_engtype_3D`, 70], [`pid_3_${L2}_phys_0_eng_0_engtype_Compute_0`, 55]])).toBe(100);
  expect(gpuUtilFromEngines([[`pid_1_${L1}_phys_0_eng_0_engtype_3D`, 10], [`pid_3_${L2}_phys_0_eng_0_engtype_Compute_0`, 55]])).toBe(55);
  // junk: no adapter, no engine type, NaN, zero
  expect(gpuUtilFromEngines([["total", 50], [`pid_1_${L1}_phys_0_eng_0`, 50], [`pid_1_${L1}_eng_0_engtype_3D`, Number.NaN], [`pid_1_${L1}_eng_0_engtype_3D`, 0]])).toBe(0);
});
test("gpuFromHelper turns the helper reply into GPU input, undefined without counters", () => {
  expect(gpuFromHelper(null)).toBeUndefined();
  expect(gpuFromHelper({})).toBeUndefined();
  expect(gpuFromHelper({ engines: [[`pid_1_${L1}_phys_0_eng_0_engtype_3D`, 12.5]], memUsed: 1e9, memTotal: 8e9, name: "GPU", temp: 60 })).toEqual({ util: 12.5, memUsed: 1e9, memTotal: 8e9, name: "GPU", temp: 60 });
  expect(gpuFromHelper({ engines: [] })).toEqual({ util: 0 });
  expect(gpuFromHelper({ engines: [`pid_1_${L1}_phys_0_eng_0_engtype_3D`, 7] })).toEqual({ util: 7 }); // a one-sample list flattened by PowerShell 5.1
});
