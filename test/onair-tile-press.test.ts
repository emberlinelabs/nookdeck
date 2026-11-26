// An On Air tile set to "Tap turns On Air on or off" ({kind:"widget", widget:"onair", action:{type:"onair"}}) toggles On Air when
// pressed; any other widget still answers "no action for this item".
import "./_fetch";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-oatile-home-"));
setDefaultTimeout(30_000);

describe("pressing an On Air tile", () => {
  test("a tile with the tap action toggles On Air; a plain widget, or an On Air tile without the action, has nothing to run", async () => {
    const { startServer } = await import("../src/server");
    const tmp = () => mkdtempSync(join(tmpdir(), "pd-oatile-"));
    const app = await startServer({
      port: 0, pin: "222222", hostName: async () => "x", hookSecret: "s",
      layoutHistoryDir: tmp(), onairFile: join(tmp(), "onair.json"), micSavedFile: join(tmp(), "mic.json"),
      hookPaths: { claude: join(tmp(), "c.json"), codex: join(tmp(), "x.json") },
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] },
    } as any);
    try {
      const base = `http://localhost:${app.port}`;
      const layout = (await (await fetch(`${base}/api/layout`)).json()) as any;
      const page = { id: "oa", name: "OA", columns: 4, rows: 2, items: [
        { id: "tile", kind: "widget", widget: "onair", x: 0, y: 0, w: 2, h: 1, action: { type: "onair", mode: "toggle" } },
        { id: "bare", kind: "widget", widget: "onair", x: 2, y: 0, w: 1, h: 1 },
        { id: "clock", kind: "widget", widget: "clock", x: 0, y: 1, w: 1, h: 1 },
      ] };
      const put = await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify({ ...layout, pages: [page, ...layout.pages] }) });
      expect(put.status).toBe(200);
      const { token } = (await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "222222", name: "t" }) })).json()) as any;
      const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${token}`);
      const msgs: any[] = [];
      ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
      await new Promise((r) => (ws.onopen = r));
      let n = 0;
      const press = async (itemId: string) => {
        const reqId = `r${++n}`;
        ws.send(JSON.stringify({ type: "press", pageId: "oa", itemId, reqId }));
        const end = Date.now() + 3000;
        while (Date.now() < end) { const m = msgs.find((x) => x.type === "result" && x.reqId === reqId); if (m) return m; await Bun.sleep(10); }
        throw new Error("no result");
      };
      const on = async () => ((await (await fetch(`${base}/api/onair`)).json()) as any).on;
      expect(await on()).toBe(false);
      expect(await press("tile")).toMatchObject({ ok: true });
      expect(await on()).toBe(true);
      expect(await press("tile")).toMatchObject({ ok: true });
      expect(await on()).toBe(false);
      expect(await press("clock")).toMatchObject({ ok: false, error: "no action for this item" });
      expect(await press("bare")).toMatchObject({ ok: false, error: "no action for this item" });
      ws.close();
    } finally { app.stop(); }
  });
});
