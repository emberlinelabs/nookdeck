import { rawFetch } from "./_fetch";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-addr-"));
const { defaultAddress, phoneAddresses, resetTailscaleCache, tailnetName, localResolves } = await import("../src/net");
const { startServer } = await import("../src/server");
const { findCli } = await import("../src/ai/find-cli");

const nic = (address: string, o: { internal?: boolean; family?: string } = {}) => ({ address, netmask: "255.255.255.0", family: o.family ?? "IPv4", mac: "00:00:00:00:00:00", internal: o.internal ?? false, cidr: `${address}/24` }) as any;
const IFACES = {
  lo0: [nic("127.0.0.1", { internal: true })],
  en0: [nic("192.168.1.20"), nic("fe80::1", { family: "IPv6" })],
  en5: [nic("10.0.0.7")],
  utun4: [nic("100.101.102.103")],
  utun5: [nic("10.8.0.2")],
  bridge100: [nic("192.168.64.1")],
  docker0: [nic("172.17.0.1")],
  vmnet8: [nic("172.16.200.1")],
  en9: [nic("169.254.12.3")],
  utun9: [nic("8.8.4.4")],
};

describe("phoneAddresses", () => {
  beforeEach(async () => (await import("../src/i18n")).setLanguage(undefined)); // another file may have left the agent language set
  test("macOS: order, labels, filtering", () => {
    const list = phoneAddresses({ interfaces: IFACES, hostName: "my-mac", tailnetName: "my-mac.tail1234.ts.net", platformId: "darwin" });
    expect(list.map((a) => [a.id, a.kind, a.host, a.label])).toEqual([
      ["lan:192.168.1.20", "lan", "192.168.1.20", "Wi-Fi · 192.168.1.20 (192.168.1.0/24)"],
      ["lan:10.0.0.7", "lan", "10.0.0.7", "Ethernet · 10.0.0.7 (10.0.0.0/24)"],
      ["local", "local", "my-mac.local", "Computer name"],
      ["tailscale:dns", "tailscale", "my-mac.tail1234.ts.net", "Tailscale (MagicDNS)"],
      ["tailscale:100.101.102.103", "tailscale", "100.101.102.103", "Tailscale · 100.101.102.103"],
      ["vpn:10.8.0.2", "vpn", "10.8.0.2", "utun5 · 10.8.0.2 (10.8.0.0/24)"],
    ]);
    const hosts = list.map((a) => a.host).join(" ");
    for (const gone of ["127.0.0.1", "fe80", "169.254", "192.168.64.1", "172.17.0.1", "172.16.200.1", "8.8.4.4"]) expect(hosts).not.toContain(gone);
    expect(list[0]!.note).toBeUndefined();
  });
  test("Windows: adapter names as labels, the .local note, vEthernet skipped", () => {
    const list = phoneAddresses({
      interfaces: { "Wi-Fi": [nic("192.168.0.5")], Ethernet: [nic("10.1.1.9")], "vEthernet (WSL)": [nic("172.20.0.1")], Tailscale: [nic("100.64.1.2")] },
      hostName: "DESKTOP-ABC", platformId: "win32",
    });
    expect(list.map((a) => [a.kind, a.host, a.label])).toEqual([
      ["lan", "192.168.0.5", "Wi-Fi · 192.168.0.5 (192.168.0.0/24)"],
      ["lan", "10.1.1.9", "Ethernet · 10.1.1.9 (10.1.1.0/24)"],
      ["local", "DESKTOP-ABC.local", "Computer name"],
      ["tailscale", "100.64.1.2", "Tailscale · 100.64.1.2"],
    ]);
    expect(list.find((a) => a.kind === "local")!.note).toContain("Android");
  });
  test("every subnet: two IPs on one NIC, two NICs, other netmasks; ?all=1 adds the virtual and link-local ones", () => {
    const ifs = {
      en0: [nic("192.168.50.111"), { ...nic("192.168.60.4"), netmask: "255.255.254.0" }],
      en7: [nic("10.0.0.5")],
      docker0: [nic("172.17.0.1")],
      en9: [nic("169.254.12.3")],
    };
    const list = phoneAddresses({ interfaces: ifs, hostName: "m", platformId: "darwin" });
    expect(list.filter((a) => a.kind === "lan").map((a) => [a.host, a.label, a.subnet])).toEqual([
      ["192.168.50.111", "Wi-Fi · 192.168.50.111 (192.168.50.0/24)", "192.168.50.0/24"],
      ["192.168.60.4", "Wi-Fi · 192.168.60.4 (192.168.60.0/23)", "192.168.60.0/23"],
      ["10.0.0.5", "Ethernet · 10.0.0.5 (10.0.0.0/24)", "10.0.0.0/24"],
    ]);
    expect(list.some((a) => a.kind === "other")).toBe(false);
    const all = phoneAddresses({ interfaces: ifs, hostName: "m", platformId: "darwin", all: true });
    expect(all.filter((a) => a.kind === "other").map((a) => a.host).sort()).toEqual(["169.254.12.3", "172.17.0.1"]);
    expect(all.filter((a) => a.kind === "lan").length).toBe(3);
  });
  test("default: the LAN address of the default route, .local only when there is no LAN address", () => {
    const list = phoneAddresses({ interfaces: IFACES, hostName: "my-mac", platformId: "darwin" });
    expect(defaultAddress(list, { localResolves: true, platformId: "darwin", lanIp: "192.168.1.20" })).toBe("lan:192.168.1.20");
    const noLan = phoneAddresses({ interfaces: { utun4: [nic("100.100.1.1")] }, hostName: "my-mac", platformId: "darwin" });
    expect(defaultAddress(noLan, { localResolves: true, platformId: "darwin" })).toBe("local");
    expect(defaultAddress(list, { localResolves: false, platformId: "darwin", lanIp: "10.0.0.7" })).toBe("lan:10.0.0.7");
    expect(defaultAddress(list, { localResolves: true, platformId: "win32", lanIp: "192.168.1.20" })).toBe("lan:192.168.1.20");
    const onlyTs = phoneAddresses({ interfaces: { utun4: [nic("100.100.1.1")] }, hostName: "", platformId: "darwin" });
    expect(defaultAddress(onlyTs, { localResolves: false })).toBe("tailscale:100.100.1.1");
  });
  test("localResolves answers false on a failing or slow lookup and caches", async () => {
    expect(await localResolves("zz-x", async () => { throw new Error("nope"); }, 1)).toBe(false);
    expect(await localResolves("zz-x", async () => "1.2.3.4", 2)).toBe(false); // cached for 60 s
    expect(await localResolves("zz-y", async () => "1.2.3.4", 3)).toBe(true);
    expect(await localResolves("zz-z", () => new Promise(() => {}), 4)).toBe(false);
  });
});

describe("tailnetName", () => {
  beforeEach(() => resetTailscaleCache());
  test("reads Self.DNSName without the dot, caches 60 s, and gives up on a bad answer", async () => {
    let calls = 0;
    const run = async () => { calls++; return JSON.stringify({ BackendState: "Running", Self: { DNSName: "My-Mac.tail1234.ts.net." } }); };
    expect(await tailnetName(run, "/x/tailscale", 1000)).toBe("my-mac.tail1234.ts.net");
    expect(await tailnetName(run, "/x/tailscale", 30_000)).toBe("my-mac.tail1234.ts.net");
    expect(calls).toBe(1);
    expect(await tailnetName(run, "/x/tailscale", 70_000)).toBe("my-mac.tail1234.ts.net");
    expect(calls).toBe(2);
    resetTailscaleCache();
    expect(await tailnetName(async () => JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "a.ts.net." } }), "/x/t", 1)).toBeNull();
    resetTailscaleCache();
    expect(await tailnetName(async () => "not json", "/x/t", 1)).toBeNull();
    resetTailscaleCache();
    expect(await tailnetName(async () => { throw new Error("x"); }, "/x/t", 1)).toBeNull();
    resetTailscaleCache();
    expect(await tailnetName(run, null, 1)).toBeNull();
  });
  test.skipIf(process.platform === "win32")("a fake tailscale CLI found in an extra dir and run for real", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-ts-"));
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "tailscale");
    writeFileSync(bin, `#!/bin/sh\necho '{"BackendState":"Running","Self":{"DNSName":"box.tail9.ts.net."}}'\n`);
    chmodSync(bin, 0o755);
    expect(findCli("tailscale", [dir], { env: { PATH: "/nonexistent" } })).toBe(bin);
    expect(await tailnetName(undefined, bin)).toBe("box.tail9.ts.net");
    // the macOS app CLI needs TERM, which a launchd agent lacks: the runner always sets one
    const probe = join(dir, "tailscale-term");
    writeFileSync(probe, `#!/bin/sh\n[ -n "$TERM" ] || exit 3\necho '{"BackendState":"Running","Self":{"DNSName":"t.ts.net."}}'\n`);
    chmodSync(probe, 0o755);
    const keep = process.env.TERM; delete process.env.TERM;
    try { resetTailscaleCache(); expect(await tailnetName(undefined, probe)).toBe("t.ts.net"); } finally { if (keep !== undefined) process.env.TERM = keep; }
  });
});

describe("GET /api/pairing and the phone Host check", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let tail: string | null = "my-mac.tail1234.ts.net";
  const start = async () => {
    app = await startServer({
      port: 0, pin: "111111", hostName: async () => "my-mac",
      tailnetName: async () => tail, interfaces: () => IFACES, localResolves: async () => true,
      deps: { startStats: () => () => {} } as any,
      hookSecret: "s", hookPaths: { claude: join(process.env.NOOKDECK_HOME!, "c.json"), codex: join(process.env.NOOKDECK_HOME!, "x.json") },
    } as any);
  };
  afterAll(() => { app?.stop?.(); });
  test("addresses, default and the old fields", async () => {
    await start();
    const a = await (await rawFetch(`http://localhost:${app.port}/api/pairing`)).json() as any;
    // ".local" is the default only on macOS (the server uses the real platform)
    expect(a.defaultAddress).toBe("lan:192.168.1.20");
    expect(a.addresses.map((x: any) => x.id)).toEqual(["lan:192.168.1.20", "lan:10.0.0.7", "local", "tailscale:dns", "tailscale:100.101.102.103", "vpn:10.8.0.2"]);
    expect(a.addresses[3].url).toBe(`http://my-mac.tail1234.ts.net:${app.port}/?pin=111111`);
    expect(a.url).toContain("/?pin=111111");
    expect(a.urlLocal).toBe(`http://my-mac.local:${app.port}/?pin=111111`);
    const b = await (await rawFetch(`http://localhost:${app.port}/api/pairing/regenerate`, { method: "POST", headers: { "x-nookdeck": "1", "content-type": "application/json" }, body: "{}" })).json() as any;
    expect(b.addresses.length).toBe(6);
    const all = await (await rawFetch(`http://localhost:${app.port}/api/pairing?all=1`)).json() as any;
    expect(all.addresses.map((x: any) => x.host)).toEqual(expect.arrayContaining(["172.17.0.1", "169.254.12.3", "192.168.64.1"]));
    expect(b.addresses[0].url).toContain(`pin=${b.pin}`);
  });
  test("a phone may use the .ts.net name and the 100.x address, but not a stranger", async () => {
    const pair = (host: string) => rawFetch(`http://127.0.0.1:${app.port}/api/pair`, { method: "POST", headers: { host: `${host}:${app.port}`, "content-type": "application/json" }, body: JSON.stringify({ pin: "000000" }) });
    for (const h of ["my-mac.tail1234.ts.net", "100.101.102.103", "192.168.1.20", "my-mac.local"]) expect((await pair(h)).status, h).not.toBe(403);
    expect((await pair("evil.example")).status).toBe(403);
    expect((await pair("other.tail1234.ts.net")).status).toBe(403);
    tail = null;
    resetTailscaleCache();
    expect((await pair("my-mac.tail1234.ts.net")).status).toBe(403);
  });
});
