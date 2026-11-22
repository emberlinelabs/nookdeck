import { describe, expect, test } from "bun:test";
import { AGENT_TARGETS, APP_ID, DMGBUILD, DMG_LAYOUT, dmgDefines, infoPlist, parseArgs } from "../scripts/build-macos-app";
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

describe("the install window (dmgbuild)", () => {
  test("660x400 content, 128 pt icons, app left and Applications right on the same row, as the artwork expects", () => {
    expect([DMG_LAYOUT.width, DMG_LAYOUT.height, DMG_LAYOUT.iconSize]).toEqual([660, 400, 128]);
    expect(DMG_LAYOUT.app).toEqual([170, 190]);
    expect(DMG_LAYOUT.apps).toEqual([490, 190]);
  });
  test("dmgbuild is pinned and the definitions carry the layout, volume icon, background and explicit size", () => {
    expect(DMGBUILD).toMatch(/^dmgbuild==\d+\.\d+\.\d+$/);
    const d = dmgDefines({ app: "/x/Nookdeck.app", volicon: "/x/AppIcon.icns", background: "/x/background.png", sizeBytes: 123456 });
    expect(d).toEqual(expect.arrayContaining(["app=/x/Nookdeck.app", "width=660", "height=400", "icon_size=128", "app_x=170", "apps_x=490", "volicon=/x/AppIcon.icns", "background=/x/background.png", "size=123456"]));
    expect(dmgDefines({ app: "/x/a.app" }).some((x) => x.startsWith("background="))).toBe(false);
  });
});
