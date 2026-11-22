import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME = mkdtempSync(join(tmpdir(), "pd-demo-home-"));
const { DEMO_LAYOUT, checkDemoCss, decodeDemoParam, demoFontCss, demoIcon, demoStats, demoHist, installNetGuard } = await import("../web/deck/src/demo-lib");
const { validateLayout } = await import("../src/config");
const { themeDemo } = await import("../src/plugins/theme-cli");

const O = "https://nookdeck.app";

describe("demo deck: what the parent may send", () => {
  test("the sample layout is a valid layout", () => {
    const l = validateLayout(DEMO_LAYOUT);
    expect(l.pages[0]!.items.length).toBeGreaterThan(10);
  });
  test("css: own files only, nothing that loads from elsewhere", () => {
    expect(checkDemoCss('.a{background:url("bg.png")}', O)).not.toBe("");
    expect(checkDemoCss(`.a{background:url(${O}/themes/x/bg.png)}`, O)).not.toBe("");
    expect(checkDemoCss(".a{background:url(data:image/png;base64,AAAA)}", O)).not.toBe("");
    for (const bad of ["@import 'x.css';", ".a{background:url(https://evil.test/x.png)}", ".a{background:url(//evil.test/x)}", ".a{background:url(../x.png)}", ".a{width:expression(alert(1))}", ".a{behavior:url(x.htc)}", "</style><script>x</script>", ".a{background:url(javascript:alert(1))}"]) expect(checkDemoCss(bad, O)).toBe("");
    expect(checkDemoCss("x".repeat(129 * 1024), O)).toBe("");
  });
  test("fonts: own urls only", () => {
    expect(demoFontCss([{ family: "Orbitron", url: "fonts/o.woff2", weight: 700 }], O)).toContain("font-weight:700");
    expect(demoFontCss([{ family: "Orbitron", url: "https://evil.test/o.woff2" }], O)).toBe("");
    expect(demoFontCss([{ family: "a;b", url: "fonts/o.woff2" }], O)).toBe("");
    expect(demoFontCss([{ family: "A", url: "fonts/o.woff2" }, { family: "B", url: "fonts/o.woff2" }, { family: "C", url: "fonts/o.woff2" }, { family: "D", url: "fonts/o.woff2" }, { family: "E", url: "fonts/o.woff2" }], O).match(/@font-face/g)!.length).toBe(4);
  });
  test("icons: an svg with anything active is dropped", () => {
    expect(demoIcon('<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>')).toMatchObject({ vb: "0 0 10 10", brand: true });
    for (const bad of ["<svg><script>1</script></svg>", '<svg><foreignObject/></svg>', '<svg><image href="https://evil.test/x.png"/></svg>', '<svg onload="x()"></svg>', '<svg><rect style="fill:url(https://evil.test/x)"/></svg>', "not svg"]) expect(demoIcon(bad)).toBeNull();
    expect(demoIcon('<svg><use href="#a"/></svg>')).not.toBeNull();
  });
  test("the ?d= form decodes base64url JSON", () => {
    const b = Buffer.from(JSON.stringify({ type: "nd-demo", pkg: "dev.a.b", note: "é" })).toString("base64url");
    expect(decodeDemoParam(b)).toEqual({ type: "nd-demo", pkg: "dev.a.b", note: "é" });
    expect(decodeDemoParam("%%%")).toBeNull();
  });
  test("sample data drifts but is deterministic", () => {
    expect(demoStats(5)).toEqual(demoStats(5));
    expect(demoStats(5).cpu).not.toBe(demoStats(6).cpu);
    expect(demoHist(3).cpu).toEqual(demoHist(3).cpu);
    expect(demoHist(3).cpu).not.toEqual(demoHist(4).cpu);
    for (let t = 0; t < 200; t++) { const s = demoStats(t); expect(s.cpu).toBeGreaterThanOrEqual(0); expect(s.cpu).toBeLessThanOrEqual(100); }
  });
});

describe("demo deck: no network beyond its own files", () => {
  const mk = () => {
    const calls: string[] = [];
    const w: any = {
      fetch: async (u: string) => { calls.push(String(u)); return new Response("ok"); },
      XMLHttpRequest: class { static x = 1; open() { calls.push("xhr"); } },
      WebSocket: class {}, EventSource: class {},
      navigator: { sendBeacon: () => true },
    };
    w.XMLHttpRequest.prototype.open = function () { calls.push("xhr"); };
    return { w, calls, attempts: installNetGuard(w, O) };
  };
  test("fetch: its own files pass; the agent's paths and other hosts are refused and recorded", async () => {
    const { w, calls, attempts } = mk();
    await w.fetch("./assets/x.js");
    await w.fetch(`${O}/demo/assets/x.js`);
    expect(calls).toHaveLength(2);
    for (const bad of ["/api/layout", `${O}/api/themes`, "/ws", "https://evil.test/x", "//evil.test/x", `${O.replace("https", "http")}/x`]) await expect(w.fetch(bad)).rejects.toThrow(/no network/);
    expect(calls).toHaveLength(2);
    expect(attempts).toHaveLength(6);
  });
  test("xhr, websocket, eventsource and beacon are refused", () => {
    const { w, attempts } = mk();
    expect(() => new w.XMLHttpRequest().open("GET", "/api/x")).toThrow();
    expect(() => new w.WebSocket("ws://x")).toThrow();
    expect(() => new w.EventSource("/api/e")).toThrow();
    expect(w.navigator.sendBeacon("/api/b")).toBe(false);
    expect(attempts).toHaveLength(4);
  });
  describe("the build", () => {
    const dir = join(import.meta.dir, "../web/deck/dist-demo");
    beforeAll(async () => {
      const p = Bun.spawn(["bunx", "--bun", "vite", "build", "-c", "vite.demo.config.ts"], { cwd: join(import.meta.dir, "../web/deck"), stdout: "ignore", stderr: "ignore" });
      expect(await p.exited).toBe(0);
    }, 60000);
    test("index.html: relative urls only, a CSP that allows only its own files, no agent page parts", () => {
      const html = readFileSync(join(dir, "index.html"), "utf8");
      const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toMatch(/https?:|\*/);
      for (const m of html.matchAll(/(?:src|href|data-src)="([^"]+)"/g)) expect(m[1]).toMatch(/^\.\//);
      expect(html).not.toContain("manifest");
      expect(existsSync(join(dir, "build.json"))).toBe(false);
    });
    test("every file is under assets/ or index.html; the bundle is Safari 12 safe", () => {
      expect(readdirSync(dir).sort()).toEqual(["assets", "index.html"]);
      for (const f of readdirSync(join(dir, "assets")).filter((n) => n.endsWith(".js"))) expect(readFileSync(join(dir, "assets", f), "utf8")).not.toMatch(/\?\.[A-Za-z_$\[(]|\?\? |color-mix|oklch|clamp\(/);
    });
  });
});

describe("nookdeck theme demo", () => {
  test("prints the message the demo takes: the look, scoped css pointing at --base, fonts, icons, background", async () => {
    const d = mkdtempSync(join(tmpdir(), "pd-demo-pack-"));
    mkdirSync(join(d, "fonts")); mkdirSync(join(d, "icons"));
    writeFileSync(join(d, "nookdeck.json"), JSON.stringify({ type: "theme", id: "dev.t.demo", name: "Demo", version: "1.0.0", css: "theme.css", theme: { backgroundImage: "bg.png", font: "pkg:Foo", fonts: [{ family: "Foo", file: "fonts/foo.woff2" }] }, variants: [{ id: "a", name: "A", mode: "dark", theme: { accent: "#111111" } }, { id: "b", name: "B", mode: "light", theme: { accent: "#eeeeee" }, css: "b.css" }] }));
    writeFileSync(join(d, "theme.css"), '.x{background:url("bg.png")}');
    writeFileSync(join(d, "b.css"), ".y{color:red}");
    writeFileSync(join(d, "bg.png"), new Uint8Array([1, 2, 3]));
    writeFileSync(join(d, "fonts/foo.woff2"), new Uint8Array([1]));
    writeFileSync(join(d, "icons/home.svg"), '<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>');
    const lines: string[] = [];
    const m: any = await themeDemo([d, "--variant", "b", "--base", "https://nookdeck.app/themes/demo/"], (s) => lines.push(String(s)));
    expect(JSON.parse(lines[0]!)).toEqual(m);
    expect(m).toMatchObject({ type: "nd-demo", pkg: "dev.t.demo", variant: "b", theme: { mode: "light", accent: "#eeeeee", font: "pkg:Foo" } });
    expect(m.css).toContain('.pd-root[data-theme-pkg="dev.t.demo"] .x');
    expect(m.css).toContain('[data-theme-variant="b"] .y');
    expect(m.css).toContain('url("https://nookdeck.app/themes/demo/bg.png")');
    expect(m.fonts).toEqual([{ family: "Foo", url: "https://nookdeck.app/themes/demo/fonts/foo.woff2" }]);
    expect(Object.keys(m.icons)).toEqual(["home"]);
    expect(m.files).toEqual({ "theme:dev.t.demo/bg.png": "https://nookdeck.app/themes/demo/bg.png" });
    // and the demo accepts exactly that css and those fonts
    expect(checkDemoCss(m.css, O)).not.toBe("");
    expect(demoFontCss(m.fonts, O)).toContain("Foo");
  });
});
