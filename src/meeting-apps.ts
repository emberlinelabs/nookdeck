/**
 * The Camera button (FR-11): there is no OS-wide camera switch, so it sends the camera shortcut of the meeting app in use.
 * ONE table: add an app here (its ids per OS, or the browser tab title it shows, and its shortcut per OS).
 * Keys use the layout's hotkey format ("cmd+shift+v"); on Windows and Linux "cmd" is not used here, the table says ctrl/alt.
 */

export interface MeetingApp {
  id: string;
  name: string;
  /** macOS bundle ids of the native app */
  mac?: string[];
  /** Windows exe names (lower case) or packaged family names (prefix match) */
  win?: string[];
  /** Linux WM classes (lower case) */
  linux?: string[];
  /** a web app: matched by the title of a browser window that is in front */
  title?: RegExp;
  keys: { mac: string; win: string; linux: string };
}

export const MEETING_APPS: MeetingApp[] = [
  { id: "zoom", name: "Zoom", mac: ["us.zoom.xos"], win: ["zoom.exe"], linux: ["zoom"], keys: { mac: "cmd+shift+v", win: "alt+v", linux: "alt+v" } },
  { id: "teams", name: "Microsoft Teams", mac: ["com.microsoft.teams2", "com.microsoft.teams"], win: ["ms-teams.exe", "teams.exe", "msteams_"], linux: ["teams-for-linux"], keys: { mac: "cmd+shift+o", win: "ctrl+shift+o", linux: "ctrl+shift+o" } },
  // Google Meet in a browser: the tab title is "Meet - <code>" or "<name> - Google Meet"
  { id: "meet", name: "Google Meet", title: /(^|\s)Meet\s+[-–]\s|Google Meet/, keys: { mac: "cmd+e", win: "ctrl+e", linux: "ctrl+e" } },
];

/** Browsers whose front window title is read for web meeting apps. */
export const BROWSERS = {
  mac: ["com.google.Chrome", "com.apple.Safari", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser", "org.mozilla.firefox", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "com.ardia.browser"],
  win: ["chrome.exe", "msedge.exe", "brave.exe", "firefox.exe", "vivaldi.exe", "opera.exe"],
  linux: ["google-chrome", "chromium", "chromium-browser", "firefox", "brave-browser", "microsoft-edge", "vivaldi-stable"],
};

type Os = "mac" | "win" | "linux";
export const osKey = (p: NodeJS.Platform): Os => (p === "darwin" ? "mac" : p === "win32" ? "win" : "linux");

const matchesNative = (app: MeetingApp, os: Os, id: string): boolean => {
  const ids = app[os];
  if (!ids) return false;
  const lc = id.toLowerCase();
  return ids.some((x) => (os === "mac" ? x === id : x.endsWith("_") ? lc.startsWith(x) : lc === x));
};

export interface CameraPick { app: MeetingApp; keys: string; /** bring this app forward first (it is not in front) */ activate?: string }

/**
 * Which meeting app gets the camera shortcut:
 * 1. an app the OS says uses the camera (Windows names it; macOS and Linux do not);
 * 2. the frontmost app when it is a known meeting app, or a browser showing a known web meeting;
 * 3. on macOS, a known native meeting app that runs while the camera is in use (it is brought forward first).
 * Null: nothing known, send no keys.
 */
export function pickMeetingApp(o: {
  os: Os;
  cameraApps: string[];
  front: { id: string; title?: string } | null;
  running?: string[];
  cameraInUse?: boolean;
}): CameraPick | null {
  for (const a of o.cameraApps) {
    const app = MEETING_APPS.find((m) => matchesNative(m, o.os, a));
    if (app && o.front && matchesNative(app, o.os, o.front.id)) return { app, keys: app.keys[o.os] };
    if (app) return { app, keys: app.keys[o.os], ...(o.os === "mac" ? { activate: a } : {}) };
  }
  if (o.front) {
    const native = MEETING_APPS.find((m) => matchesNative(m, o.os, o.front!.id));
    if (native) return { app: native, keys: native.keys[o.os] };
    const isBrowser = (BROWSERS[o.os] as string[]).some((b) => (o.os === "mac" ? b === o.front!.id : b === o.front!.id.toLowerCase()));
    if (isBrowser && o.front.title) {
      const web = MEETING_APPS.find((m) => m.title && m.title.test(o.front!.title!));
      if (web) return { app: web, keys: web.keys[o.os] };
    }
  }
  if (o.os === "mac" && o.cameraInUse && o.running) {
    for (const app of MEETING_APPS) {
      const bundle = app.mac?.find((b) => o.running!.includes(b));
      if (bundle) return { app, keys: app.keys.mac, activate: bundle };
    }
  }
  return null;
}
