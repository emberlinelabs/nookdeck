// platform.activateApp on Windows and Linux: the Camera button brings the meeting app forward before it sends the shortcut.
import { describe, expect, test } from "bun:test";
import { createWin32, pickAppWindow, type WinOwner } from "../src/platform/win32";
import { createLinux } from "../src/platform/linux";
import { activateX11App, parsePids, parseWindowIds, pgrepCommand, wmctrlActivateCommand, xdotoolActivateCommand, xdotoolSearchClassCommand, xdotoolSearchPidCommand } from "../src/platform/linux-activate";

const wins: WinOwner[] = [
  { hwnd: 11, pid: 1, exe: "chrome.exe", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { hwnd: 22, pid: 2, exe: "zoom.exe", path: "C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe" },
  { hwnd: 23, pid: 2, exe: "zoom.exe", path: "C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe" },
  { hwnd: 33, pid: 3, exe: "ms-teams.exe", path: "C:\\Program Files\\WindowsApps\\MSTeams_25031.805.3440.5290_x64__8wekyb3d8bbwe\\ms-teams.exe" },
];

describe("Windows", () => {
  test("the window: by exe name, the one nearest the front; a packaged app by its family name; null when it has none", () => {
    expect(pickAppWindow(wins, "Zoom.exe")).toBe(22);
    expect(pickAppWindow(wins, "msteams_8wekyb3d8bbwe")).toBe(33);
    expect(pickAppWindow(wins, "msteams_otherpublisher")).toBeNull();
    expect(pickAppWindow(wins, "teams.exe")).toBeNull();
    expect(pickAppWindow([], "zoom.exe")).toBeNull();
  });

  function fakeHelper(answers: Record<string, unknown>) {
    const calls: Array<{ cmd: string; args: any }> = [];
    return { calls, helper: { call: async (cmd: string, args: any = {}) => { calls.push({ cmd, args }); const a = answers[cmd]; if (a instanceof Error) throw a; return a ?? null; }, dispose: () => {} } as any };
  }
  test("activateApp lists the windows, focuses the app's window and returns whether it came to the front", async () => {
    const h = fakeHelper({ "window.owners": wins, "window.focus": true });
    expect(await createWin32({ helper: h.helper }).activateApp("zoom.exe")).toBe(true);
    expect(h.calls).toEqual([{ cmd: "window.owners", args: {} }, { cmd: "window.focus", args: { hwnd: 22 } }]);
    const refused = fakeHelper({ "window.owners": wins, "window.focus": false });
    expect(await createWin32({ helper: refused.helper }).activateApp("zoom.exe")).toBe(false);
  });
  test("no window, or a helper error: false, and nothing is focused", async () => {
    const none = fakeHelper({ "window.owners": wins });
    expect(await createWin32({ helper: none.helper }).activateApp("slack.exe")).toBe(false);
    expect(none.calls.map((c) => c.cmd)).toEqual(["window.owners"]);
    const broken = fakeHelper({ "window.owners": new Error("helper gone") });
    expect(await createWin32({ helper: broken.helper }).activateApp("zoom.exe")).toBe(false);
  });
});

describe("Linux", () => {
  test("commands and parsers", () => {
    expect(pgrepCommand("zoom")).toEqual(["pgrep", "-x", "--", "zoom"]);
    expect(xdotoolSearchPidCommand(42)).toEqual(["xdotool", "search", "--onlyvisible", "--pid", "42"]);
    expect(xdotoolSearchClassCommand("teams-for-linux")).toEqual(["xdotool", "search", "--onlyvisible", "--class", "^teams-for-linux$"]);
    expect(xdotoolSearchClassCommand("a.b")[4]).toBe("^a\\.b$");
    expect(xdotoolActivateCommand("123")).toEqual(["xdotool", "windowactivate", "--sync", "123"]);
    expect(wmctrlActivateCommand("123")).toEqual(["wmctrl", "-ia", "123"]);
    expect(parseWindowIds("Defaulting to search window name\n123\n456\n")).toEqual(["123", "456"]);
    expect(parsePids("12\n34\n")).toEqual([12, 34]);
  });

  /** A fake X11 desktop: processes, their windows, the active window. */
  function desktop(o: { procs?: Record<string, number[]>; windows?: Record<number, string[]>; classes?: Record<string, string[]>; activateFails?: boolean; wmctrlFails?: boolean } = {}) {
    let active = "1";
    const ran: string[][] = [];
    const run = async (argv: string[]) => {
      ran.push(argv);
      const [cmd, a1, , a3, a4] = argv;
      if (cmd === "pgrep") { const p = o.procs?.[argv[3]!]; if (!p) throw new Error("exit 1"); return p.join("\n"); }
      if (cmd === "xdotool" && a1 === "search") {
        const w = a3 === "--pid" ? o.windows?.[Number(a4)] : o.classes?.[a4!.slice(1, -1)];
        if (!w?.length) throw new Error("exit 1");
        return w.join("\n");
      }
      if (cmd === "xdotool" && a1 === "windowactivate") { if (o.activateFails) throw new Error("XGetWindowProperty failed"); active = argv[3]!; return ""; }
      if (cmd === "wmctrl") { if (o.wmctrlFails) throw new Error("no"); active = argv[2]!; return ""; }
      if (cmd === "xdotool" && a1 === "getactivewindow") return active + "\n";
      throw new Error("unexpected " + argv.join(" "));
    };
    return { run, ran };
  }
  const tools = (...names: string[]) => (n: string) => (names.includes(n) ? `/usr/bin/${n}` : null);

  test("by the process's windows: activated, then read back", async () => {
    const d = desktop({ procs: { zoom: [7, 8] }, windows: { 8: ["500", "501"] } });
    expect(await activateX11App("zoom", d.run, tools("xdotool"))).toBe(true);
    expect(d.ran).toContainEqual(["xdotool", "windowactivate", "--sync", "501"]);
  });
  test("an Electron app (camera in a child process with no window) is found by its WM class; pid:<n> names the process", async () => {
    const d = desktop({ procs: { "teams-for-linux": [9] }, classes: { "teams-for-linux": ["600"] } });
    expect(await activateX11App("teams-for-linux", d.run, tools("xdotool"))).toBe(true);
    const p = desktop({ windows: { 77: ["700"] } });
    expect(await activateX11App("pid:77", p.run, tools("xdotool"))).toBe(true);
    expect(p.ran[0]).toEqual(["xdotool", "search", "--onlyvisible", "--pid", "77"]);
  });
  test("wmctrl when xdotool's activation fails; false when nothing works, nothing runs, or xdotool is missing", async () => {
    const w = desktop({ procs: { zoom: [7] }, windows: { 7: ["500"] }, activateFails: true });
    expect(await activateX11App("zoom", w.run, tools("xdotool", "wmctrl"))).toBe(true);
    expect(w.ran).toContainEqual(["wmctrl", "-ia", "500"]);
    expect(await activateX11App("zoom", desktop({ procs: { zoom: [7] }, windows: { 7: ["500"] }, activateFails: true }).run, tools("xdotool"))).toBe(false);
    expect(await activateX11App("zoom", desktop().run, tools("xdotool"))).toBe(false);
    const none = desktop({ procs: { zoom: [7] }, windows: { 7: ["500"] } });
    expect(await activateX11App("zoom", none.run, tools())).toBe(false);
    expect(none.ran).toEqual([]);
    expect(await activateX11App("bad name; rm -rf /", desktop().run, tools("xdotool"))).toBe(false);
  });
  test("the adapter: X11 uses it; Wayland says false without running anything", async () => {
    const d = desktop({ procs: { zoom: [7] }, windows: { 7: ["500"] } });
    expect(await createLinux("linux", tools("xdotool"), { XDG_SESSION_TYPE: "x11" }, { run: d.run }).activateApp("zoom")).toBe(true);
    const w = desktop({ procs: { zoom: [7] }, windows: { 7: ["500"] } });
    expect(await createLinux("linux", tools("xdotool"), { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" }, { run: w.run }).activateApp("zoom")).toBe(false);
    expect(w.ran).toEqual([]);
  });
});
