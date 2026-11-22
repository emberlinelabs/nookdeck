import "./_fetch";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-prev-home-"));
const { parseManifest } = await import("../src/plugins/manifest");
const { PluginStore } = await import("../src/plugins/store");

const widget = (render: string, preview?: unknown) => ({
  id: "w", name: "W", render, sizes: ["2x1"], ...(preview !== undefined ? { preview } : {}),
  source: { http: { url: "https://api.example.com/x" }, map: {} },
});
const mk = (render: string, preview?: unknown) => ({ id: "dev.t.x", name: "X", version: "1.0.0", permissions: { network: ["api.example.com"] }, widgets: [widget(render, preview)] });

const VALID: Record<string, unknown> = {
  stat: { value: 60721, unit: "USD", label: "bitcoin" },
  gauge: { value: 42, label: "CPU" },
  text: { title: "Hello", body: "A short sentence." },
  list: { items: [{ title: "BTC", value: "60k" }, { title: "ETH", subtitle: "2.4k" }] },
  chart: { points: [1, 3, 2, 5, 4], label: "Price", unit: "USD" },
  image: { url: "https://example.com/pic.png", fit: "cover" },
  status: { state: "ok", label: "All good" },
};
const INVALID: Record<string, unknown> = {
  stat: { unit: "USD" }, // no value
  gauge: { value: "lots" },
  text: { title: "no body" },
  list: { items: "nope" },
  chart: { points: "nope" },
  image: { url: "http://example.com/pic.png" }, // not https
  status: { state: "purple", label: "x" },
};

describe("widget preview", () => {
  for (const r of Object.keys(VALID)) {
    test(`${r}: valid sample data is accepted and kept`, () => {
      const m = parseManifest(mk(r, VALID[r]));
      expect(m.widgets[0]!.preview).toBeDefined();
      expect(m.widgets[0]!.preview).toMatchObject(r === "chart" ? { points: [1, 3, 2, 5, 4] } : r === "list" ? { items: expect.any(Array) } : (VALID[r] as object));
    });
    test(`${r}: invalid sample data is rejected at parse time with a clear message`, () => {
      expect(() => parseManifest(mk(r, INVALID[r]))).toThrow(new RegExp(`widgets\\[0\\]\\.preview is not valid ${r} data|widgets\\[0\\]\\.preview`));
    });
  }
  test("a preview must be an object; no preview is fine", () => {
    expect(() => parseManifest(mk("stat", 5))).toThrow("preview must be an object");
    expect(() => parseManifest(mk("stat", [1]))).toThrow("preview must be an object");
    expect(parseManifest(mk("stat")).widgets[0]).not.toHaveProperty("preview");
  });
  test("the summary carries it, and it never causes a request", async () => {
    const d = mkdtempSync(join(tmpdir(), "pd-prev-"));
    let calls = 0;
    const store = new PluginStore({ dir: join(d, "p"), stateFile: join(d, "p.json"), agentVersion: "0.2.0", fetch: (async () => { calls++; return new Response("x"); }) as any });
    await store.load();
    await Bun.write(join(d, "src/nookdeck.json"), JSON.stringify(mk("stat", VALID.stat)));
    const r = await store.install(join(d, "src"));
    expect(r.plugin.widgets[0]!.preview).toEqual(VALID.stat);
    expect(calls).toBe(0);
  });
  test("the example plugin has a preview and is 1.0.1", () => {
    const m = parseManifest(JSON.parse(readFileSync(join(import.meta.dir, "fixtures/plugins/crypto-price/nookdeck.json"), "utf8")));
    expect(m.version).toBe("1.0.1");
    expect(m.widgets[0]!.preview).toEqual({ value: 60721, unit: "USD", label: "bitcoin" });
  });
});
