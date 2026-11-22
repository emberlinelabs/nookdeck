import { describe, expect, test } from "bun:test";
import { AGENT_TARGETS, APP_ID, infoPlist, parseArgs } from "../scripts/build-macos-app";
import { IDENTIFIER } from "../scripts/sign-macos";

describe("build-macos-app (pure parts)", () => {
  test("the app and the agent keep their own identifiers", () => {
    expect(APP_ID).toBe("dev.nookdeck.app");
    expect(IDENTIFIER).toBe("dev.nookdeck.agent"); // Accessibility grants belong to this one: it must never change
  });
  test("Info.plist: a menu bar only app for macOS 13+, with the version and the three languages", () => {
    const p = infoPlist("0.4.0", "123");
    expect(p).toContain("<key>CFBundleIdentifier</key><string>dev.nookdeck.app</string>");
    expect(p).toContain("<key>LSUIElement</key><true/>");
    expect(p).toContain("<key>LSMinimumSystemVersion</key><string>13.0</string>");
    expect(p).toContain("<key>CFBundleShortVersionString</key><string>0.4.0</string>");
    expect(p).toContain("<string>vi</string><string>zh-Hans</string>");
    expect(infoPlist("1<2", "1")).toContain("1&lt;2");
  });
  test("both architectures are bundled by name the app looks for", () => {
    expect(AGENT_TARGETS.map((t) => t.file)).toEqual(["nookdeck-arm64", "nookdeck-x86_64"]);
    expect(AGENT_TARGETS.map((t) => t.bunTarget)).toEqual(["bun-darwin-arm64", "bun-darwin-x64"]);
  });
  test("flags", () => {
    expect(parseArgs([])).toMatchObject({ hostAgent: false, dmg: true });
    expect(parseArgs(["--host-agent", "--no-dmg", "--agent-arm64", "a", "--agent-x64", "b"])).toMatchObject({ hostAgent: true, dmg: false, agentArm64: "a", agentX64: "b" });
    expect(/[\\/]x$/.test(parseArgs(["--out", "x"]).out)).toBe(true);
  });
});
