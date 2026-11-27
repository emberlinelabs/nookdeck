import { describe, expect, test } from "bun:test";
import { DropLog, buildReport, foldRepeats, mask, relation, windowsVersion } from "../src/report";
import { VisitorLog } from "../src/visitors";
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

describe("the network part: who reached this computer", () => {
  const nets = [{ name: "Ethernet", address: "192.168.100.54", subnet: "192.168.100.0/24" }, { name: "Tailscale", address: "100.101.5.7", subnet: "100.101.5.7/32" }];
  const base = {
    now: Date.parse("2026-11-27T04:20:00Z"), version: "0.7.3", os: "Windows 11 (build 26100)", arch: "x64", doctor: [
      { id: "network", title: "Network profile", status: "ok", detail: "Network is a Public network, and the firewall lets phones reach Nookdeck on it" },
      { id: "firewall", title: "Firewall", status: "ok", detail: "the firewall is on and allows incoming connections to nookdeck" },
      { id: "agent", title: "Nookdeck", status: "ok", detail: "C:\\x" },
    ],
    layout: { pages: 1, tiles: 1, bytes: 1, assets: 0, assetBytes: 0 }, devices: [], drops: [], errLog: "",
  };
  test("relation of an address to the computer's networks", () => {
    expect(relation("192.168.100.23", nets)).toBe("same network as Ethernet");
    expect(relation("192.168.1.23", nets)).toContain("another network");
    expect(relation("100.88.1.2", nets)).toBe("Tailscale");
  });
  test("Windows 11 reports kernel 10.0", () => {
    expect([windowsVersion("10.0.26100"), windowsVersion("10.0.19045"), windowsVersion("6.1.7601")]).toEqual(["11 (build 26100)", "10 (build 19045)", "6.1.7601"]);
  });
  test("nobody reached it: the report says so, and why that matters", () => {
    const r = buildReport({ ...base, network: { listen: "0.0.0.0", port: 7420, startedAt: base.now - 34 * 60_000, nets, visitors: [] } });
    expect(r).toContain("Listening on 0.0.0.0:7420 (every network); the agent started 34 min ago");
    expect(r).toContain("- Ethernet: 192.168.x.x in 192.168.x.x/24");
    expect(r).toContain("- nobody: no phone or other device has opened Nookdeck");
    // the network items keep their detail when ok, other ok items do not
    expect(r).toContain("ok: Network profile - Network is a Public network, and the firewall lets phones reach Nookdeck on it");
    expect(r).toContain("ok: Firewall - the firewall is on and allows");
    expect(r).not.toContain("C:\\x");
    expect(r).not.toContain("192.168.100");
  });
  test("visitors: same network or not, page, wrong PINs, pairing, the device that connected", () => {
    let t = base.now - 10 * 60_000;
    const log = new VisitorLog(20, () => t);
    log.seen("127.0.0.1", "page"); // localhost is never listed
    log.seen("::ffff:192.168.100.23", "page");
    log.seen("192.168.100.23", "pair-fail");
    log.seen("192.168.100.23", "pair-fail");
    t += 60_000;
    log.seen("192.168.100.23", "pair-ok");
    log.seen("192.168.100.23", "ws", "iPhone Safari");
    log.seen("10.8.0.5", "page");
    const r = buildReport({ ...base, network: { listen: "0.0.0.0", port: 7420, startedAt: base.now - 3600_000, nets, visitors: log.list() } });
    expect(r).toContain("- 192.168.x.x (same network as Ethernet): opened the page, paired, 2 wrong PINs, connected as iPhone Safari; 5 requests, last 9 min ago");
    expect(r).toContain("- 10.8.x.x (another network (not on any network of this computer)): opened the page; 1 request");
    expect(log.list().length).toBe(2);
  });
  test("the log keeps the 20 most recent addresses", () => {
    let t = 0;
    const log = new VisitorLog(3, () => ++t);
    for (const a of ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]) log.seen(a, "request");
    expect(log.list().map((v) => v.address)).toEqual(["10.0.0.4", "10.0.0.3", "10.0.0.2"]);
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
