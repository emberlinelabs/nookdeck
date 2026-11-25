import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanOs, osReason } from "../src/plugins/os";
import { parseManifest } from "../src/plugins/manifest";
import { parseRegistry } from "../src/plugins/registry";
import { PluginStore } from "../src/plugins/store";
import { osBadges } from "../web/manage/src/lib/plugin-ui";
import { normalizePlugin, normalizeRegistryEntry } from "../web/manage/src/api";

const MANIFEST = { id: "dev.t.mac", name: "Mac only", version: "1.0.0", permissions: {}, os: ["darwin"], actions: [] };

describe("manifest os", () => {
  test("missing means every system; a list is kept in one order without repeats", () => {
    const { os: _os, ...everywhere } = MANIFEST;
    expect("os" in parseManifest(everywhere)).toBe(false);
    expect(parseManifest(MANIFEST).os).toEqual(["darwin"]);
    expect(cleanOs(["linux", "darwin", "linux"])).toEqual(["darwin", "linux"]);
  });
  test("anything else is refused", () => {
    for (const os of [[], "darwin", ["macos"], ["darwin", 1], null]) expect(() => parseManifest({ ...MANIFEST, os })).toThrow("os must be a list");
  });
  test("the reason names the matching list", () => {
    expect(osReason(["darwin"], "darwin")).toBeUndefined();
    expect(osReason(undefined, "linux")).toBeUndefined();
    expect(osReason(["darwin"], "win32")).toBe("This plugin works on macOS only");
    expect(osReason(["darwin", "win32"], "linux")).toBe("This plugin works on macOS and Windows only");
  });
});

describe("another operating system", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const make = async () => {
    dir = mkdtempSync(join(tmpdir(), "pd-os-"));
    await Bun.write(join(dir, "src", "nookdeck.json"), JSON.stringify(MANIFEST));
    const store = (platform: string) => new PluginStore({ dir: join(dir, "plugins"), stateFile: join(dir, "plugins.json"), platform });
    return { src: join(dir, "src"), store };
  };

  test("install and link are refused with the reason, and nothing is written", async () => {
    const m = await make();
    const s = m.store("linux");
    await s.load();
    await expect(s.install(m.src)).rejects.toThrow("This plugin works on macOS only");
    await expect(s.link(m.src)).rejects.toThrow("This plugin works on macOS only");
    expect(s.ids()).toEqual([]);
    expect(await Bun.file(join(dir, "plugins", "dev.t.mac", "1.0.0", "nookdeck.json")).exists()).toBe(false);
  });
  test("an already installed plugin is shown disabled with the reason, and works again on its own system", async () => {
    const m = await make();
    const mac = m.store("darwin");
    await mac.load();
    await mac.install(m.src);
    await mac.grant("dev.t.mac", { network: [] });
    await mac.setEnabled("dev.t.mac", true);
    expect(mac.runnable("dev.t.mac")).toBe("ok");

    const win = m.store("win32");
    await win.load();
    expect(win.summary("dev.t.mac")).toMatchObject({ enabled: false, os: ["darwin"], error: "This plugin works on macOS only" });
    expect(win.runnable("dev.t.mac")).toBe("disabled");
    await expect(win.setEnabled("dev.t.mac", true)).rejects.toThrow("This plugin works on macOS only");

    const back = m.store("darwin");
    await back.load();
    expect(back.runnable("dev.t.mac")).toBe("ok");
  });
});

describe("the Store", () => {
  test("a registry entry keeps a valid os and drops a bad one", () => {
    const row = (id: string, os: unknown) => ({ id, name: id, version: "1.0.0", repo: "https://github.com/a/b", sha256: "a".repeat(64), os });
    const list = parseRegistry([row("dev.a.one", ["darwin"]), row("dev.a.two", ["amiga"])]);
    expect(list.map((e) => e.os)).toEqual([["darwin"], undefined]);
  });
  test("the manage page keeps os and the reason, and names the badges", () => {
    expect(normalizeRegistryEntry({ id: "dev.a.one", os: ["darwin"], unavailable: "This plugin works on macOS only" })).toMatchObject({ os: ["darwin"], unavailable: "This plugin works on macOS only" });
    expect(normalizePlugin({ id: "dev.a.one", os: ["darwin", "linux"] })?.os).toEqual(["darwin", "linux"]);
    expect(osBadges(["darwin", "linux"])).toEqual(["macOS", "Linux"]);
    expect(osBadges(undefined)).toEqual([]);
  });
});
