/**
 * Bringing an app forward on Linux (the Camera button, src/mic-camera.ts, sends the meeting app's shortcut only once it is in
 * front). The app is named the way the camera check names it (linux-av.ts cameraApps): a process comm such as "zoom", or
 * "pid:<n>" when the comm could not be read.
 *
 * X11 only, with xdotool: its windows are found by the process ids of that name (pgrep -x), else by the WM class, then
 * activated with xdotool (wmctrl -ia when xdotool's activation fails), and the active window is read back. Wayland has no
 * common way for another program to raise a window: activateApp says false there, and the shortcut is sent only to a meeting
 * app that is already in front.
 */

type Run = (argv: string[], timeoutMs?: number) => Promise<string>;

export const pgrepCommand = (name: string) => ["pgrep", "-x", "--", name];
export const xdotoolSearchPidCommand = (pid: number) => ["xdotool", "search", "--onlyvisible", "--pid", String(pid)];
export const xdotoolSearchClassCommand = (cls: string) => ["xdotool", "search", "--onlyvisible", "--class", `^${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`];
export const xdotoolActivateCommand = (wid: string) => ["xdotool", "windowactivate", "--sync", wid];
export const wmctrlActivateCommand = (wid: string) => ["wmctrl", "-ia", wid];
export const XDOTOOL_ACTIVE_WINDOW = ["xdotool", "getactivewindow"];

/** Window ids (decimal) from xdotool search output; anything else is skipped. */
export const parseWindowIds = (out: string): string[] => out.split(/\s+/).filter((x) => /^\d+$/.test(x));
/** Process ids from pgrep output. */
export const parsePids = (out: string): number[] => out.split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number);

/** The comm names the camera check gives: no spaces or slashes, at most 15 characters (TASK_COMM_LEN - 1). */
const SAFE_NAME = /^[\w.+-][\w .+:-]{0,14}$/;

export async function activateX11App(id: string, run: Run, which: (n: string) => string | null): Promise<boolean> {
  if (!which("xdotool")) return false;
  const quiet = (argv: string[], ms = 3000) => run(argv, ms).catch(() => ""); // search and pgrep exit 1 when nothing matches
  const byPid = /^pid:(\d+)$/.exec(id);
  if (!byPid && !SAFE_NAME.test(id)) return false;
  const pids = byPid ? [Number(byPid[1])] : parsePids(await quiet(pgrepCommand(id)));
  let wins: string[] = [];
  for (const pid of pids.slice(0, 20)) {
    wins = parseWindowIds(await quiet(xdotoolSearchPidCommand(pid)));
    if (wins.length) break;
  }
  // Electron apps hold the camera in a child process with no window of its own: try the WM class too
  if (!wins.length && !byPid) wins = parseWindowIds(await quiet(xdotoolSearchClassCommand(id)));
  const wid = wins[wins.length - 1];
  if (!wid) return false;
  try {
    await run(xdotoolActivateCommand(wid), 3000);
  } catch {
    if (!which("wmctrl")) return false;
    try { await run(wmctrlActivateCommand(wid), 3000); } catch { return false; }
  }
  return (await quiet(XDOTOOL_ACTIVE_WINDOW, 2000)).trim() === wid;
}
