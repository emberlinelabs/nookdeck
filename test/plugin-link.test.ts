import { describe, expect, test } from "bun:test";
import { parsePluginLink, parseThemeLink, sameRepo } from "../web/manage/src/lib/plugin-link";

describe("plugin deeplinks", () => {
  test("add with a valid registry id", () => {
    expect(parsePluginLink("#plugins?add=dev.alice.crypto")).toEqual({ link: { kind: "add", id: "dev.alice.crypto" } });
  });
  test("install with an encoded https address", () => {
    const u = "https://github.com/alice/crypto";
    expect(parsePluginLink(`#plugins?install=${encodeURIComponent(u)}`)).toEqual({ link: { kind: "install", source: u } });
  });
  test("not a plugin link", () => {
    expect(parsePluginLink("")).toBeNull();
    expect(parsePluginLink("#plugins")).toBeNull();
    expect(parsePluginLink("#plugins?foo=1")).toBeNull();
    expect(parsePluginLink("#screens")).toBeNull();
  });
  test("rejects a bad id, an empty value and both at once", () => {
    for (const h of ["#plugins?add=", "#plugins?add=nodots", "#plugins?add=Dev.Alice.X", "#plugins?add=../etc.passwd", "#plugins?install=", "#plugins?add=dev.a.b&install=https%3A%2F%2Fx.io"])
      expect(parsePluginLink(h)).toEqual({ rejected: true });
  });
  test("rejects javascript:, http:, file:, data: and credentials", () => {
    for (const u of ["javascript:alert(1)", "http://github.com/a/b", "file:///etc/passwd", "data:text/html,x", "~/plugins/x", "https://user:pw@github.com/a/b", "https://", "https://a b.com", "git@github.com:a/b.git"])
      expect(parsePluginLink(`#plugins?install=${encodeURIComponent(u)}`)).toEqual({ rejected: true });
  });
  test("matches a registry repo", () => {
    expect(sameRepo("https://github.com/Alice/Crypto.git/", "https://github.com/alice/crypto")).toBe(true);
    expect(sameRepo("https://github.com/alice/other", "https://github.com/alice/crypto")).toBe(false);
  });
});

describe("parseThemeLink", () => {
  test("opens the Packs tab, with or without a pack", () => {
    expect(parseThemeLink("#themes")).toEqual({ open: true });
    expect(parseThemeLink("#themes?add=dev.nookdeck.catppuccin")).toEqual({ open: true, id: "dev.nookdeck.catppuccin" });
  });
  test("rejects a malformed id, ignores other hashes", () => {
    expect(parseThemeLink("#themes?add=../x")).toEqual({ rejected: true });
    expect(parseThemeLink("#theme")).toBeNull();
    expect(parseThemeLink("#plugins?add=x")).toBeNull();
  });
});
