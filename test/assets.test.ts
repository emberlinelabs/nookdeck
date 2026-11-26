import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { generate, contentType, buildHash, deckBuildId } = await import("../scripts/gen-assets");
const { resolveAsset } = await import("../src/assets");

describe("gen-assets", () => {
  test("empty when dist folders are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-gen-"));
    const out = join(root, "src", "assets.gen.ts");
    mkdirSync(join(root, "src"));
    expect(generate(join(root, "web"), out)).toEqual({ deck: 0, manage: 0 });
    expect(readFileSync(out, "utf8")).toContain("export const DECK");
  });

  test("walks dist and emits file imports", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-gen-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "web/deck/dist/assets"), { recursive: true });
    mkdirSync(join(root, "web/manage/dist"), { recursive: true });
    writeFileSync(join(root, "web/deck/dist/index.html"), "<html>");
    writeFileSync(join(root, "web/deck/dist/assets/a.woff2"), "x");
    writeFileSync(join(root, "web/manage/dist/index.html"), "<html>");
    const out = join(root, "src", "assets.gen.ts");
    expect(generate(join(root, "web"), out)).toEqual({ deck: 2, manage: 1 });
    const src = readFileSync(out, "utf8");
    expect(src).toContain('from "../web/deck/dist/assets/a.woff2" with { type: "file" }');
    expect(src).toContain('"assets/a.woff2"');
    expect(src).toContain("font/woff2");
  });

  test("buildHash: stable for the same build, changes with index.html or asset names, none without a dist", () => {
    const mk = (html: string, asset: string) => {
      const root = mkdtempSync(join(tmpdir(), "pd-hash-"));
      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "index.html"), html);
      writeFileSync(join(root, "assets", asset), "x");
      return root;
    };
    const a = buildHash(mk("<html>1", "index-AAA.js"));
    expect(a).toMatch(/^[0-9a-f]{10}$/);
    expect(buildHash(mk("<html>1", "index-AAA.js"))).toBe(a);
    expect(buildHash(mk("<html>2", "index-AAA.js"))).not.toBe(a);
    expect(buildHash(mk("<html>1", "index-BBB.js"))).not.toBe(a);
    expect(buildHash(join(tmpdir(), "pd-no-such-dist"))).toBe("none");
  });

  test("generated module exports DECK_BUILD", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-gen-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "web/deck/dist"), { recursive: true });
    writeFileSync(join(root, "web/deck/dist/index.html"), "<html>");
    const out = join(root, "src", "assets.gen.ts");
    generate(join(root, "web"), out);
    expect(readFileSync(out, "utf8")).toContain(`export const DECK_BUILD = "${deckBuildId(join(root, "web/deck/dist"))}";`);
  });

  test("DECK_BUILD is the id the deck page carries (build.json), so hello never forces a reload", () => {
    const root = mkdtempSync(join(tmpdir(), "pd-gen-"));
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "web/deck/dist"), { recursive: true });
    writeFileSync(join(root, "web/deck/dist/index.html"), "<html><head><meta name=\"pd-build\" content=\"abc123def456\">");
    writeFileSync(join(root, "web/deck/dist/build.json"), JSON.stringify({ build: "abc123def456", files: [] }));
    const out = join(root, "src", "assets.gen.ts");
    generate(join(root, "web"), out);
    expect(readFileSync(out, "utf8")).toContain(`export const DECK_BUILD = "abc123def456";`);
  });

  test("contentType", () => {
    expect(contentType("a.css")).toContain("text/css");
    expect(contentType("a.bin")).toBe("application/octet-stream");
  });
});

describe("resolveAsset", () => {
  const f = (type: string) => ({ path: "/x", type });
  const deck = { "index.html": f("text/html"), "assets/a.js": f("text/javascript") };
  const manage = { "index.html": f("text/html"), "assets/m.js": f("text/javascript") };
  test("deck", () => {
    expect(resolveAsset("/", deck, manage)?.localOnly).toBe(false);
    expect(resolveAsset("/assets/a.js", deck, manage)?.cache).toContain("immutable");
    expect(resolveAsset("/index.html", deck, manage)?.cache).toBe("no-cache");
    expect(resolveAsset("/", deck, manage)?.cache).toBe("no-cache");
    expect(resolveAsset("/registerSW.js", { ...deck, "registerSW.js": f("text/javascript") }, manage)?.cache).toBe("no-cache"); // an unhashed entry is never cached
    expect(resolveAsset("/missing.js", deck, manage)).toBeNull();
  });
  test("manage is local only with SPA fallback", () => {
    expect(resolveAsset("/manage", deck, manage)?.file).toBe(manage["index.html"]);
    expect(resolveAsset("/manage/devices", deck, manage)?.file).toBe(manage["index.html"]);
    expect(resolveAsset("/manage/assets/m.js", deck, manage)?.file).toBe(manage["assets/m.js"]);
    expect(resolveAsset("/manage/assets/none.js", deck, manage)).toBeNull();
    expect(resolveAsset("/manage/", deck, manage)?.localOnly).toBe(true);
    expect(resolveAsset("/manage/x", deck, {})).toBeNull();
  });
});

test("generate bakes the build info in; versionLine shows the commit", async () => {
  const { mkdtempSync, mkdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pd-gen-"));
  mkdirSync(join(root, "web"), { recursive: true });
  const out = join(root, "assets.gen.ts");
  generate(join(root, "web"), out, { commit: "abc1234", dirty: true, builtAt: "2026-01-02T03:04:05.000Z" });
  expect(readFileSync(out, "utf8")).toContain('{"commit":"abc1234","dirty":true,"builtAt":"2026-01-02T03:04:05.000Z"}');
  const { versionLine } = await import("../src/about");
  const base = { name: "Nookdeck", version: "1.2.3", build: "b", builtAt: "", platform: "darwin", arch: "arm64", bun: "1", repo: "", license: "MIT" };
  expect(versionLine({ ...base, commit: "abc1234", dirty: false })).toBe("nookdeck 1.2.3 (abc1234)");
  expect(versionLine({ ...base, commit: "abc1234", dirty: true })).toBe("nookdeck 1.2.3 (abc1234-dirty)");
  expect(versionLine({ ...base, commit: "", dirty: false })).toBe("nookdeck 1.2.3");
});

test("forbidden page: language choice and escaping of the port", async () => {
  const { pickLanguage, forbiddenPage, wantsPage } = await import("../src/forbidden-page");
  expect(pickLanguage("vi", "en-US")).toBe("vi");
  expect(pickLanguage("en", "vi")).toBe("en");
  expect(pickLanguage(undefined, "vi-VN,vi;q=0.9,en;q=0.8")).toBe("vi");
  expect(pickLanguage(undefined, "en-US,en;q=0.9,vi;q=0.1")).toBe("en");
  expect(pickLanguage(undefined, null)).toBe("en");
  expect(pickLanguage("fr", "en-US")).toBe("fr");
  expect(pickLanguage("pt", null)).toBe("pt");
  expect(pickLanguage("toString", null)).toBe("en");
  expect(pickLanguage(undefined, "fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
  expect(pickLanguage(undefined, "pt-BR,pt;q=0.9")).toBe("pt");
  expect(pickLanguage(undefined, "pt-PT")).toBe("pt");
  expect(pickLanguage(undefined, "en-US,fr;q=0.5")).toBe("en");
  expect(forbiddenPage(7420, "fr")).toContain('lang="fr"');
  expect(forbiddenPage(7420, "pt")).toContain('lang="pt-BR"');
  expect(wantsPage("GET", "/manage/")).toBe(true);
  expect(wantsPage("GET", "/api/layout")).toBe(false);
  expect(wantsPage("POST", "/manage/")).toBe(false);
  expect(forbiddenPage(7420, "en")).toContain("http://localhost:7420/manage/");
  expect(forbiddenPage("7420<script>" as any, "en")).not.toContain("<script>");
});
