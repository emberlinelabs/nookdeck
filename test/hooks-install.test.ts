import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookCommand, installHook, isHookInstalled, uninstallHook, HOOK_MARKER } from "../src/hooks-install";

const dir = () => mkdtempSync(join(tmpdir(), "pd-hk-"));
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const CMD = hookCommand("claude", { execPath: "/opt/nookdeck", indexPath: "/x/src/index.ts" });

describe("hookCommand", () => {
  test("compiled vs source mode, always carries the marker", () => {
    expect(hookCommand("claude", { execPath: "/opt/pd dir/nookdeck" })).toBe(`'/opt/pd dir/nookdeck' hook claude # ${HOOK_MARKER}`);
    expect(hookCommand("codex", { execPath: "/u/.bun/bin/bun", indexPath: "/r/src/index.ts" })).toBe(`'/u/.bun/bin/bun' '/r/src/index.ts' hook codex # ${HOOK_MARKER}`);
    expect(hookCommand("claude", { execPath: "/it's/nookdeck" })).toContain(`'/it'\\''s/nookdeck'`);
  });
});

describe("install / uninstall", () => {
  test("creates a missing file; idempotent; no backup for a new file", async () => {
    const f = join(dir(), "sub", "settings.json");
    expect(await isHookInstalled(f)).toBe(false);
    expect((await installHook(f, CMD)).changed).toBe(true);
    expect(await isHookInstalled(f)).toBe(true);
    expect(read(f).hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: "command", command: CMD });
    expect((await installHook(f, CMD)).changed).toBe(false);
    expect(read(f).hooks.PermissionRequest.length).toBe(1);
    expect(existsSync(f + ".nookdeck.bak")).toBe(false);
  });

  test("keeps other settings and hooks, backs up the original, updates a moved binary", async () => {
    const f = join(dir(), "hooks.json");
    const original = { theme: "dark", hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "echo other" }] }], PostToolUse: [{ hooks: [{ type: "command", command: "x" }] }] } };
    writeFileSync(f, JSON.stringify(original, null, 2));
    await installHook(f, CMD);
    expect(read(f + ".nookdeck.bak")).toEqual(original);
    const after = read(f);
    expect(after.theme).toBe("dark");
    expect(after.hooks.PostToolUse).toEqual(original.hooks.PostToolUse);
    expect(after.hooks.PermissionRequest.length).toBe(2);
    expect(after.hooks.PermissionRequest[0]).toEqual(original.hooks.PermissionRequest[0]);

    const moved = hookCommand("claude", { execPath: "/new/nookdeck" });
    expect((await installHook(f, moved)).changed).toBe(true);
    expect(read(f).hooks.PermissionRequest.length).toBe(2);
    expect(read(f).hooks.PermissionRequest[1].hooks[0].command).toBe(moved);
  });

  test("uninstall removes only ours and restores the shape", async () => {
    const f = join(dir(), "settings.json");
    const original = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "echo other" }] }] } };
    writeFileSync(f, JSON.stringify(original));
    await installHook(f, CMD);
    expect((await uninstallHook(f)).changed).toBe(true);
    expect(read(f)).toEqual(original);
    expect((await uninstallHook(f)).changed).toBe(false);
    expect(await isHookInstalled(f)).toBe(false);

    const g = join(dir(), "s.json");
    await installHook(g, CMD);
    await uninstallHook(g);
    expect(read(g).hooks.PermissionRequest).toBeUndefined();
    expect((await uninstallHook(join(dir(), "nope.json"))).changed).toBe(false);
  });

  test("invalid JSON is never touched", async () => {
    const f = join(dir(), "settings.json");
    writeFileSync(f, "{ not json");
    await expect(installHook(f, CMD)).rejects.toThrow("not valid JSON");
    expect(readFileSync(f, "utf8")).toBe("{ not json");
    expect(existsSync(f + ".nookdeck.bak")).toBe(false);
  });
});

describe("hookCommand targets the installing agent", () => {
  test("default port and home add no flags", () => {
    expect(hookCommand("claude", { execPath: "/bin/nookdeck", port: 7420, home: "/h/.nookdeck", defaultHome: "/h/.nookdeck" })).toBe("'/bin/nookdeck' hook claude # nookdeck hook");
  });
  test("other port and home are carried, quoted", () => {
    expect(hookCommand("codex", { execPath: "/bin/nookdeck", port: 7460, home: "/tmp/a b", defaultHome: "/h/.nookdeck" })).toBe("'/bin/nookdeck' hook codex --port 7460 --home '/tmp/a b' # nookdeck hook");
  });
});
