import { describe, expect, test } from "bun:test";
import { aboutInfo, compatVersion, isCompiled } from "../src/about";
import { versionAtLeast } from "../src/plugins/manifest";

describe("the version packages are checked against", () => {
  const clean = { ...aboutInfo(), version: "0.4.0", commit: "abc1234", dirty: false };
  test("a compiled program is told apart from a source run on every system", () => {
    expect(isCompiled("file:///$bunfs/root/nookdeck")).toBe(true);
    expect(isCompiled("file:///B:/~BUN/root/nookdeck.exe")).toBe(true);
    expect(isCompiled("file:///Users/me/nookdeck/src/about.ts")).toBe(false);
    expect(isCompiled()).toBe(false); // the tests run from source
  });
  test("a release keeps its number; a source run, a modified build and a build without git pass any minimum", () => {
    expect(compatVersion(clean, true)).toBe("0.4.0");
    expect(versionAtLeast(compatVersion(clean, true), ">=0.5.0")).toBe(false);
    for (const v of [compatVersion(clean, false), compatVersion({ ...clean, dirty: true }, true), compatVersion({ ...clean, commit: "" }, true)]) {
      expect(v).toBe("0.4.0-dev");
      expect(versionAtLeast(v, ">=0.5.0")).toBe(true);
    }
  });
});
