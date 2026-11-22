import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { chooseMode, checkRequired, signDir } from "../scripts/sign-macos";

// Pure mode selection only: these tests never sign anything and never touch a keychain.
describe("sign-macos mode", () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  test("CI secret wins, then the local keychain, then ad hoc", () => {
    const env = { NOOKDECK_SIGN_DIR: "/s" };
    const kc = join("/s", "signing.keychain-db"); // the script joins with the OS separator
    expect(chooseMode({ ...env, MACOS_SIGN_P12: "AAAA" }, has(kc))).toBe("ci");
    expect(chooseMode(env, has(kc))).toBe("local");
    expect(chooseMode(env, has())).toBe("adhoc");
    expect(chooseMode({ ...env, MACOS_SIGN_P12: "" }, has())).toBe("adhoc");
  });
  test("NOOKDECK_SIGN_DIR overrides the default folder", () => {
    expect(signDir({ NOOKDECK_SIGN_DIR: "/x" })).toBe("/x");
    expect(signDir({})).toContain(join(".config", "nookdeck-signing"));
  });
  test("a tag build refuses anything but the CI identity", () => {
    const req = { NOOKDECK_REQUIRE_CI_SIGNING: "1" };
    expect(() => checkRequired("adhoc", req)).toThrow("CI identity");
    expect(() => checkRequired("local", req)).toThrow("CI identity");
    expect(() => checkRequired("ci", req)).not.toThrow();
    expect(() => checkRequired("adhoc", {})).not.toThrow();
  });
});
