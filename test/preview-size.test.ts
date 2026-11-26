// PhoneBox #580: the manage preview can use a connected phone's own screen size. The deck reports it ({type:"viewport"}), the agent
// lists it with the online device (GET /api/devices), and the manage page picks it (web/manage/src/lib/screen-size.ts).
import "./_fetch";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-vp-home-"));
const { AUTO, DEVICE_PREFIX, onlinePhones, resolveScreen } = await import("../web/manage/src/lib/screen-size");
setDefaultTimeout(30_000);

describe("choosing the preview size", () => {
  const devices = [
    { id: "a", name: "Old iPhone", online: true, lastSeen: "2026-11-27T08:00:00Z", viewport: { w: 375, h: 667 } },
    { id: "b", name: "Pixel", online: true, lastSeen: "2026-11-27T09:00:00Z", viewport: { w: 915, h: 412 } },
    { id: "c", name: "Offline", online: false, viewport: { w: 1, h: 1 } },
    { id: "d", name: "No size yet", online: true },
  ];
  test("online phones with a size, most recently seen first", () => {
    expect(onlinePhones(devices).map((p) => [p.id, p.w, p.h])).toEqual([["b", 915, 412], ["a", 375, 667]]);
  });
  test("auto follows the first online phone, else iPhone 14/15; a picked phone keeps its saved size while offline", () => {
    const phones = onlinePhones(devices);
    expect(resolveScreen({ preset: AUTO, w: 844, h: 390 }, phones)).toMatchObject({ w: 915, h: 412, from: { id: "b" } });
    expect(resolveScreen({ preset: AUTO, w: 844, h: 390 }, [])).toEqual({ w: 844, h: 390 });
    expect(resolveScreen({ preset: DEVICE_PREFIX + "a", w: 667, h: 375 }, phones)).toMatchObject({ w: 375, h: 667 });
    expect(resolveScreen({ preset: DEVICE_PREFIX + "gone", w: 700, h: 400 }, phones)).toEqual({ w: 700, h: 400 });
    expect(resolveScreen({ preset: "ipad", w: 1180, h: 820 }, phones)).toEqual({ w: 1180, h: 820 });
  });
});

describe("the agent", () => {
  test("a phone's reported viewport is listed with it while it is online; nonsense is ignored", async () => {
    const { startServer } = await import("../src/server");
    const app = await startServer({ port: 0, pin: "111111", hostName: async () => "x", deps: { startStats: () => () => {} } as any, hookSecret: "s", hookPaths: { claude: join(mkdtempSync(join(tmpdir(), "pd-vp-")), "c.json"), codex: join(mkdtempSync(join(tmpdir(), "pd-vp-")), "x.json") } } as any);
    try {
      const base = `http://localhost:${app.port}`;
      const { token, deviceId } = await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "111111", name: "Test phone" }) })).json() as any;
      const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${token}`);
      await new Promise((r) => (ws.onopen = r));
      const mine = async () => ((await (await fetch(`${base}/api/devices`)).json()) as any[]).find((d) => d.id === deviceId);
      ws.send(JSON.stringify({ type: "viewport", w: 99999, h: 3 }));
      await Bun.sleep(150);
      expect((await mine()).viewport).toBeUndefined();
      ws.send(JSON.stringify({ type: "viewport", w: 844.4, h: 390 }));
      const end = Date.now() + 3000;
      while (!(await mine()).viewport && Date.now() < end) await Bun.sleep(30);
      expect(await mine()).toMatchObject({ online: true, viewport: { w: 844, h: 390 } });
      ws.close();
      while ((await mine()).online && Date.now() < end + 3000) await Bun.sleep(30);
      expect((await mine()).viewport).toBeUndefined();
    } finally { app.stop(); }
  });
});
