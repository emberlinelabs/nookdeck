import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pd-pair-"));
process.env.NOOKDECK_HOME = home;

const { Pairing, hashToken, MAX_FAILURES } = await import("../src/pairing");
// bun runs all test files in one process: config.ts fixes HOME at its first import, whoever that is
const { HOME: configHome } = await import("../src/config");

describe("pairing", () => {
  test("good pin returns token and stores only sha256", async () => {
    const p = new Pairing(undefined, "123456");
    const r = await p.pair("123456", "My phone");
    expect(r).not.toBeNull();
    expect(r!.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = readFileSync(join(configHome, "devices.json"), "utf8");
    expect(stored).not.toContain(r!.token);
    expect(stored).toContain(hashToken(r!.token));
    const dev = await p.findDevice(r!.token);
    expect(dev?.id).toBe(r!.deviceId);
    expect(dev?.name).toBe("My phone");
  });

  test("bad pin and bad token are rejected", async () => {
    const p = new Pairing(undefined, "123456");
    expect(await p.pair("000000", "x")).toBeNull();
    expect(await p.pair(123456 as any, "x")).toBeNull();
    expect(await p.findDevice("nope")).toBeUndefined();
    expect(await p.findDevice(null)).toBeUndefined();
  });

  test("pin regenerates after max failures", async () => {
    const seen: string[] = [];
    const p = new Pairing((pin) => seen.push(pin), "123456");
    for (let i = 0; i < MAX_FAILURES; i++) await p.pair("bad", "x");
    expect(seen.length).toBe(1);
    expect(p.pin).toMatch(/^\d{6}$/);
    expect(p.failures).toBe(0);
  });

  test("hashToken is sha256 hex", () => {
    expect(hashToken("a")).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  });
});

describe("token cookie and expiry helpers", () => {
  test("cookieToken picks pd_token out of a cookie header", async () => {
    const { cookieToken, tokenCookie, isExpired, TOKEN_TTL_MS } = await import("../src/pairing");
    expect(cookieToken("a=1; pd_token=abc; b=2")).toBe("abc");
    expect(cookieToken("pd_token=abc")).toBe("abc");
    expect(cookieToken("xpd_token=abc")).toBeUndefined();
    expect(cookieToken("pd_token=")).toBeUndefined();
    expect(cookieToken(null)).toBeUndefined();
    expect(tokenCookie("t")).toBe("pd_token=t; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax");
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    expect(isExpired({ createdAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + 1000).toISOString() }, t0 + 999)).toBe(false);
    expect(isExpired({ createdAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + 1000).toISOString() }, t0 + 1001)).toBe(true);
    expect(isExpired({ createdAt: new Date(t0).toISOString() }, t0 + TOKEN_TTL_MS - 1)).toBe(false);
    expect(isExpired({ createdAt: new Date(t0).toISOString(), lastSeen: new Date(t0 + 10_000).toISOString() }, t0 + TOKEN_TTL_MS + 5_000)).toBe(false);
    expect(isExpired({ createdAt: new Date(t0).toISOString() }, t0 + TOKEN_TTL_MS + 1)).toBe(true);
  });
});

describe("localHostName", () => {
  test("macOS LocalHostName when valid, else the first label of the hostname", async () => {
    const { localHostName } = await import("../src/net");
    const { hostname } = await import("node:os");
    const fallback = hostname().split(".")[0]!.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "localhost";
    if (process.platform === "darwin") {
      expect(await localHostName(async (argv) => { expect(argv).toEqual(["scutil", "--get", "LocalHostName"]); return "Howz-MacBook\n"; })).toBe("Howz-MacBook");
      expect(await localHostName(async () => "bad name!")).toBe(fallback);
      expect(await localHostName(async () => { throw new Error("no scutil"); })).toBe(fallback);
    } else {
      expect(await localHostName(async () => "ignored")).toBe(fallback);
    }
  });
});
