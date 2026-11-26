import { describe, expect, test } from "bun:test";
import { DropLog, buildReport, foldRepeats, mask } from "../src/report";
import { issueUrl } from "../web/manage/src/lib/report";

describe("mask", () => {
  test("home, user, host, IPs, tailnet, PIN, tokens and emails are masked", () => {
    const s = mask(
      "C:\\Users\\khach\\.nookdeck\\logs failed for khach on DESKTOP-AB12.local at http://192.168.1.23:7420/?pin=123456 and huit.bun-hamal.ts.net, Pairing PIN: 336978, token=abc123, a@b.com, 0123456789abcdef0123456789abcdef",
      { home: "C:\\Users\\khach", user: "khach", hosts: ["DESKTOP-AB12"] },
    );
    expect(s).not.toMatch(/khach|DESKTOP-AB12|192\.168\.1\.23|336978|123456|abc123|a@b\.com|0123456789abcdef|hamal/);
    expect(s).toContain("~\\.nookdeck\\logs");
    expect(s).toContain("192.168.x.x");
    expect(s).toContain("<host>");
  });
  test("localhost stays readable", () => {
    expect(mask("http://127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
  });
});

test("foldRepeats folds runs of the same line with different numbers", () => {
  expect(foldRepeats("[watchdog] blocked for 5 s\n[watchdog] blocked for 120 s\n[watchdog] blocked for 7 s\nother")).toBe("[watchdog] blocked for 5 s  (x3, numbers vary)\nother");
});

test("DropLog keeps the newest entries", () => {
  const d = new DropLog(2);
  for (const code of [1002, 1009, 1011]) d.add({ at: code, code, reason: "", device: "x" });
  expect(d.list().map((x) => x.code)).toEqual([1009, 1011]);
});

describe("buildReport", () => {
  const input = {
    now: Date.parse("2026-11-26T06:00:00Z"), version: "0.5.3", os: "Windows 10.0.22631", arch: "x64",
    doctor: [{ id: "agent", title: "Nookdeck", status: "ok", detail: "C:\\Users\\khach\\bin" }, { id: "fw", title: "Firewall", status: "warn", detail: "no rule for 192.168.1.5" }],
    layout: { pages: 2, tiles: 30, bytes: 1_500_000, assets: 40, assetBytes: 1_400_000 },
    devices: [{ name: "iPhone Safari", lastSeen: "2026-11-26T05:00:00Z", createdAt: "2026-11-20T00:00:00Z" }],
    drops: [{ at: Date.parse("2026-11-26T05:59:00Z"), code: 1009, reason: "too big", device: "iPhone Safari" }],
    errLog: "boom at C:\\Users\\khach\\x\n",
    phoneCheck: "deflate off 1.07 MB FAILED (close 1009)",
  };
  test("has every section, masked", () => {
    const r = buildReport(input, { home: "C:\\Users\\khach", user: "khach" });
    for (const part of ["0.5.3", "Windows 10.0.22631 x64", "1.43 MB", "WARN: Firewall - no rule for 192.168.x.x", "iPhone Safari: last connected 1 h ago", "1009 too big", "Last phone check", "close 1009"]) expect(r).toContain(part);
    expect(r).not.toContain("khach");
    expect(r).not.toContain("C:\\Users\\khach\\bin"); // ok items carry no detail
  });
  test("empty parts say so", () => {
    const r = buildReport({ ...input, devices: [], drops: [], errLog: "", phoneCheck: undefined });
    expect(r).toContain("none paired");
    expect(r).toContain("none since the agent started");
    expect(r).toContain("(empty)");
    expect(r).not.toContain("Last phone check");
  });
});

describe("issueUrl", () => {
  test("a short report goes in the URL", () => {
    const u = issueUrl("https://github.com/o/r/", "[0.5.3] Windows: ", "hello");
    expect(u.inline).toBe(true);
    expect(u.url).toBe("https://github.com/o/r/issues/new?title=%5B0.5.3%5D%20Windows%3A%20&body=hello");
  });
  test("a long one asks to paste instead", () => {
    const u = issueUrl("https://github.com/o/r", "t", "x".repeat(10_000));
    expect(u.inline).toBe(false);
    expect(u.url.length).toBeLessThan(600);
    expect(decodeURIComponent(u.url)).toContain("paste the Nookdeck report");
  });
});
