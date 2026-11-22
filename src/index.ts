#!/usr/bin/env bun
import "./compat";
import { startServer } from "./server";
import { lanIp, localHostName, phoneAddresses, tailnetName } from "./net";
import { hookSecretPath, runHook } from "./permissions";
import { runAskHook } from "./questions";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { t } from "./i18n";
import { platform } from "./platform";
import pkg from "../package.json" with { type: "json" };

function parsePort(argv: string[]): number {
  const i = argv.findIndex((a) => a === "--port" || a === "-p");
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--port="))?.slice(7) ?? process.env.NOOKDECK_PORT;
  const n = raw === undefined ? 7420 : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`Invalid port: ${raw}`);
    process.exit(1);
  }
  return n;
}

const argv = process.argv.slice(2);

// `nookdeck hook claude|codex`: called by the AI tool, never by hand. Always exits 0.
if (argv[0] === "hook") {
  const source = argv[1];
  if (source === "claude-ask") {
    // PreToolUse for AskUserQuestion: the phone answers, Claude Code gets the answers. Prints nothing in every other case.
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const home = flag("--home");
    const secretFile = home ? join(home, "hook-secret") : hookSecretPath();
    const secret = await readFile(secretFile, "utf8").then((t) => t.trim(), () => "");
    const port = Number(flag("--port")) || Number(process.env.NOOKDECK_PORT) || 7420;
    const out = secret ? await runAskHook({ stdin: await Bun.stdin.text(), port, secret }) : null;
    if (out) process.stdout.write(out + "\n");
    process.exit(0);
  }
  if (source === "grok") {
    // `nookdeck hook grok busy|idle|waiting`: Grok's own hook (~/.grok/hooks/nookdeck.json) tells the agent its state.
    // Short and silent: it never prints and never blocks Grok.
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const state = argv[2];
    if (state === "busy" || state === "idle" || state === "waiting") {
      const home = flag("--home");
      const secret = await readFile(home ? join(home, "hook-secret") : hookSecretPath(), "utf8").then((t) => t.trim(), () => "");
      const port = Number(flag("--port")) || Number(process.env.NOOKDECK_PORT) || 7420;
      const { grokStateFromStdin } = await import("./ai/grok");
      const info = grokStateFromStdin(await Bun.stdin.text());
      if (secret && info.sessionId) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        await fetch(`http://127.0.0.1:${port}/api/hooks/state`, { method: "POST", headers: { "content-type": "application/json", "x-nookdeck-hook": secret }, body: JSON.stringify({ source: "grok", state, ...info }), signal: ctl.signal }).catch(() => {});
        clearTimeout(timer);
      }
    }
    process.exit(0);
  }
  if (source === "claude" || source === "codex") {
    // The installed command carries --port/--home when the agent that installed it is not on the defaults.
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const home = flag("--home");
    const secretFile = home ? join(home, "hook-secret") : hookSecretPath();
    const secret = await readFile(secretFile, "utf8").then((t) => t.trim(), () => "");
    const port = Number(flag("--port")) || Number(process.env.NOOKDECK_PORT) || 7420;
    const out = secret ? await runHook(source, { stdin: await Bun.stdin.text(), port, secret }) : null;
    if (out) process.stdout.write(out + "\n");
  }
  process.exit(0);
}
// `nookdeck migrate`: the PhoneDesk -> Nookdeck move on its own (setup.sh / setup.ps1 call it before they install over an old install).
if (argv[0] === "migrate") {
  const { migrateFromEnv } = await import("./migrate");
  try {
    const r = await migrateFromEnv(parsePort(argv.slice(1)), (l) => console.log(l), { service: !argv.includes("--no-service") });
    for (const n of r.notes) console.warn(n);
    if (!r.changed.length) console.log("Nothing to migrate.");
  } catch (e: any) { console.error(`nookdeck migrate: ${e?.message ?? e}`); process.exit(1); }
  process.exit(0);
}
// `nookdeck mcp [--port N]`: MCP server on stdio so an AI can arrange the deck; talks to the running agent.
if (argv[0] === "mcp") {
  const { runMcp } = await import("./mcp/server");
  await runMcp({ port: parsePort(argv.slice(1)) });
  process.exit(0);
}
// `nookdeck pair [--port N] [--all] [--plain]`: the phone addresses and the PIN of the running agent (the setup scripts print them).
if (argv[0] === "pair") {
  const port = parsePort(argv.slice(1));
  let info: any;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/pairing${argv.includes("--all") ? "?all=1" : ""}`, { signal: AbortSignal.timeout(3000) });
    info = await r.json();
  } catch { console.error(`nookdeck: no agent answered on port ${port}. Start it with: nookdeck`); process.exit(1); }
  const list: any[] = info.addresses ?? [];
  const first = list.find((a) => a.id === info.defaultAddress);
  const ordered = first ? [first, ...list.filter((a) => a !== first)] : list;
  const plain = argv.includes("--plain");
  for (const a of ordered) console.log(plain ? `${a === first ? "*" : "-"}\t${a.url}\t${a.label}` : `  ${a === first ? "Phone (default)" : "Phone          "}  ${a.url}   ${a.label}${a.note ? `  (${a.note})` : ""}`);
  if (!ordered.length) console.log(plain ? `*\t${info.url}\t` : `  Phone  ${info.url}`);
  console.log(plain ? `PIN\t${info.pin}` : `  PIN             ${info.pin}`);
  process.exit(0);
}
// `nookdeck qr <text>`: prints a QR code (the setup scripts use it for the pairing URL). Silent when stdout is not a terminal.
if (argv[0] === "qr") {
  const text = argv[1];
  if (!text) { console.error("Usage: nookdeck qr <text>"); process.exit(1); }
  if (process.stdout.isTTY) { const { qrText } = await import("./qr"); console.log(qrText(text)); }
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
  console.log((await import("./about")).versionLine());
  process.exit(0);
}
// `nookdeck service install|uninstall|status|restart [--port N]`: run the agent in the background at login (macOS launchd).
if (argv[0] === "service") {
  const svc = await import("./service");
  const deps = svc.realServiceDeps();
  try {
    const cmd = argv[1];
    if (cmd === "install") {
      const port = argv.includes("--port") || argv.some((a) => a.startsWith("--port=")) ? parsePort(argv) : undefined;
      await svc.serviceInstall(deps, { port });
      // an upgrade may have moved the binary: keep our Claude/Codex hooks pointing at this one
      const tg = svc.hookTargets();
      for (const n of tg.notes) console.log(n);
      for (const r of await svc.repointHooks(tg.files, deps.program, svc.currentInstance(port))) if (r.changed) console.log(`Hook updated: ${r.file}`);
    } else if (cmd === "uninstall") await svc.serviceUninstall(deps);
    else if (cmd === "restart") await svc.serviceRestart(deps);
    else if (cmd === "status") console.log(svc.formatStatus(await svc.serviceStatus(deps)));
    else { console.error("Usage: nookdeck service install [--port N] | uninstall | status | restart"); process.exit(2); }
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
  process.exit(0);
}
// `nookdeck hooks repoint|remove`: used by setup.sh and uninstall.sh. Only entries carrying our marker are touched.
if (argv[0] === "hooks") {
  const svc = await import("./service");
  if (argv[1] === "repoint") {
    const tg = svc.hookTargets();
    for (const n of tg.notes) console.log(n);
    const port = argv.includes("--port") || argv.some((a) => a.startsWith("--port=")) ? parsePort(argv) : undefined;
    for (const r of await svc.repointHooks(tg.files, svc.defaultProgram(), svc.currentInstance(port))) console.log(r.changed ? `Hook updated: ${r.file}` : `Hook unchanged: ${r.file}`);
  } else if (argv[1] === "remove") {
    for (const n of svc.hookTargets().notes) console.log(n);
    for (const r of await svc.removeHooks()) console.log(r.changed ? `Hook removed: ${r.file}` : `No Nookdeck hook in ${r.file}`);
  } else { console.error("Usage: nookdeck hooks repoint | remove"); process.exit(2); }
  process.exit(0);
}
// `nookdeck doctor [--port N] [--open <id>] [--request <id>] [--json]`: what the OS lets Nookdeck do. macOS ties permissions
// to the process that asks, so the checks run inside the running agent (GET /api/doctor); only without an agent do they run here.
if (argv[0] === "doctor") {
  const d = await import("./doctor");
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = argv.includes("--port") || argv.some((a) => a.startsWith("--port=")) ? parsePort(argv) : Number(process.env.NOOKDECK_PORT) || 7420;
  const base = `http://127.0.0.1:${port}`;
  const post = { method: "POST", headers: { "content-type": "application/json", "x-nookdeck": "1" } };
  let report: import("./doctor").DoctorReport | null = null;
  try {
    const res = await fetch(`${base}/api/doctor`, { headers: { "x-nookdeck": "1" }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) report = (await res.json()) as import("./doctor").DoctorReport;
  } catch { /* no agent */ }
  const reqId = flag("--request");
  if (reqId) {
    if (!report) { console.error(`No Nookdeck agent answered on port ${port}. Start it (or \`nookdeck service install\`) and try again: the prompt must come from the agent itself.`); process.exit(1); }
    const r = await fetch(`${base}/api/doctor/request`, { ...post, body: JSON.stringify({ id: reqId, reset: argv.includes("--reset") }) });
    const body = (await r.json()) as any;
    if (!r.ok) { console.error(body?.error ?? `request failed (${r.status})`); process.exit(1); }
    console.log(`Asked ${platform.label} for "${reqId}". Answer the prompt if one appeared, then run \`nookdeck doctor\` again.`);
    if (body.item) console.log(`${d.STATUS_MARK[body.item.status as import("./doctor").DoctorStatus]} ${body.item.title} - ${body.item.detail}`);
    process.exit(0);
  }
  let local = false;
  if (!report) {
    local = true;
    const { default: pkg2 } = await import("../package.json", { with: { type: "json" } });
    report = await d.runDoctor(d.realProbes(pkg2.version), { instance: (await import("./service")).currentInstance(port) });
  }
  const openId = flag("--open");
  if (openId) {
    const item = report.items.find((i) => i.id === openId);
    const url = item?.fix?.settingsUrl;
    if (!url) { console.error(`Nothing to open for "${openId}". Ids: ${report.items.filter((i) => i.fix?.settingsUrl).map((i) => i.id).join(", ")}`); process.exit(1); }
    await platform.openExternal(url).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
    console.log(`Opened ${url}`);
    process.exit(0);
  }
  if (argv.includes("--json")) { console.log(JSON.stringify({ ...report, source: local ? "terminal" : "agent" }, null, 2)); process.exit(0); }
  if (local) console.log(`! No Nookdeck agent answered on port ${port}. These results are for THIS terminal app, not for the agent: macOS grants permissions per program.\n  Start Nookdeck (or \`nookdeck service install\`) and run doctor again for the real answer.\n`);
  console.log(d.formatReport(report, { color: !!process.stdout.isTTY }));
  process.exit(report.items.some((i) => i.status === "missing" || i.status === "denied") ? 1 : 0);
}
// `nookdeck __ae <bundle-id>`: internal. Prints the Automation permission state for one app (doctor asks a child so a stuck call cannot freeze the agent).
if (argv[0] === "__ae") {
  const { realAutomation } = await import("./doctor");
  console.log(realAutomation(String(argv[1] ?? ""), argv[2] === "ask"));
  process.exit(0);
}
// `nookdeck __native ping|volume|running|nowplaying`: internal, read-only self-check of the macOS native helper (also proves the worker is inside this binary).
if (argv[0] === "__native") {
  if (argv[1] === "nowplaying") {
    // what every app is playing right now, read through the bundled adapter (read-only; prints one JSON line)
    const { platform } = await import("./platform");
    const status = await platform.nowPlayingStatus();
    const media = status.ok ? await platform.readMedia() : null;
    console.log(JSON.stringify({ status, media }));
    platform.dispose();
    process.exit(status.ok ? 0 : 1);
  }
  const { macNative } = await import("./platform/mac-client");
  const mn = macNative();
  try {
    const op = argv[1] ?? "ping";
    const out = op === "volume" ? await mn.call("volumeGet")
      : op === "running" ? await mn.call("running", { bundles: argv.slice(2) })
      : op === "ping" ? await mn.call("ping")
      : (() => { throw new Error("use ping, volume or running <bundle-id>..."); })();
    console.log(JSON.stringify(out));
    mn.dispose();
    process.exit(0);
  } catch (e: any) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}
// `nookdeck __ax [prompt]`: internal, same idea for the Accessibility check (prompt = show macOS's own prompt).
if (argv[0] === "__ax") {
  const { realAxPrompt, realAxTrusted } = await import("./doctor");
  console.log(String(argv[1] === "prompt" ? realAxPrompt() : realAxTrusted()));
  process.exit(0);
}
// `nookdeck update [--version X] [--check]`: replaces this program with the latest (or the given) release.
if (argv[0] === "update") {
  const { runUpdate } = await import("./update");
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1); };
  const port = argv.includes("--port") || argv.some((a) => a.startsWith("--port=")) ? parsePort(argv) : Number(process.env.NOOKDECK_PORT) || 7420;
  try {
    await runUpdate({
      check: argv.includes("--check"), version: flag("--version"), port, tty: !!process.stdout.isTTY,
      restartService: async () => {
        const svc = await import("./service");
        const d = svc.realServiceDeps(() => {});
        if (!(await svc.serviceStatus(d)).installed) return false;
        await svc.serviceRestart(d);
        return true;
      },
      agentVersion: async (p) => {
        try { const r = await fetch(`http://127.0.0.1:${p}/api/about`, { headers: { "x-nookdeck": "1" }, signal: AbortSignal.timeout(2000) }); return r.ok ? String(((await r.json()) as any).version ?? "") || null : null; } catch { return null; }
      },
    });
  } catch (err: any) {
    console.error(`nookdeck update: ${err?.message ?? String(err)}`);
    process.exit(1);
  }
  process.exit(0);
}
if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
  console.log("Usage: nookdeck [--port N]\n       nookdeck mcp [--port N]   MCP server (stdio) to arrange the deck with an AI\n       nookdeck service install|uninstall|status|restart [--port N]   run in the background at login (macOS, Windows)\n       nookdeck hooks repoint|remove   re-point or remove the Claude/Codex hooks\n       nookdeck doctor [--open <id>] [--request <id>] [--json]   check OS permissions (asks the running agent)\n       nookdeck update [--version X] [--check]   install the latest release (or only check)\n       nookdeck --version\n       --no-qr   do not print the pairing QR code at start\n       nookdeck qr <text>   print a QR code in the terminal\n\nEnv: NOOKDECK_PORT, NOOKDECK_HOME");
  process.exit(0);
}

// anything that is not an option is a command we do not know: never start the agent for it
if (argv[0] && !argv[0].startsWith("-")) {
  console.error(`nookdeck: unknown command "${argv[0]}". Run nookdeck --help`);
  process.exit(2);
}
// Windows: the previous program, renamed while it was running by `nookdeck update`, can go now
if (platform.id === "win32") { const { rm } = await import("node:fs/promises"); await rm(`${process.execPath}.old`, { force: true }).catch(() => {}); }

import { qrText } from "./qr";
const printed = { port: 0 };
const host = await localHostName();
const printPairing = async (pin: string) => {
  // a scannable code for the .local URL (it keeps working when the IP changes); not when piped, or with --no-qr
  if (process.stdout.isTTY && !argv.includes("--no-qr")) { try { console.log(`\n${qrText(`http://${host}.local:${printed.port}/?pin=${pin}`)}`); } catch { /* the URL below is enough */ } }
  console.log(`\nPairing PIN: ${pin}`);
  let first = true;
  for (const a of phoneAddresses({ hostName: host, tailnetName: await tailnetName().catch(() => null) })) {
    console.log(`${first ? "Pair URL:    " : "             "}http://${a.host}:${printed.port}/?pin=${pin}  (${a.label})`);
    first = false;
  }
  if (first) console.log(`Pair URL:    http://${lanIp()}:${printed.port}/?pin=${pin}`);
  console.log("");
};

// 0.1.x -> 0.2.0: PhoneDesk became Nookdeck. Moves the data, the service, the PATH entry and the hooks over (idempotent, never deletes data).
try {
  const { migrateFromEnv } = await import("./migrate");
  for (const n of (await migrateFromEnv(parsePort(argv), (l) => console.log(`[migration] ${l}`))).notes) console.warn(`[migration] ${n}`);
} catch (e: any) { console.warn(`[migration] skipped: ${e?.message ?? e}`); }

const wantPort = parsePort(argv);
let app: Awaited<ReturnType<typeof startServer>>;
try {
  app = await startServer({ port: wantPort, onPinChange: (pin) => { console.log("Too many failed attempts, PIN regenerated."); void printPairing(pin); } });
} catch (err: any) {
  if (err?.code === "EADDRINUSE" || /in use/i.test(String(err?.message))) {
    const { explainBusyPort } = await import("./busy");
    console.error(`nookdeck: ${await explainBusyPort(wantPort, { service: async () => { const svc = await import("./service"); return (await svc.serviceStatus(svc.realServiceDeps(() => {}))).installed; } })}`);
    process.exit(1);
  }
  throw err;
}
printed.port = app.port;
// Event-loop watchdog: when something blocks the main thread (a synchronous call that never returns) the agent looks dead from outside.
// A blocked loop cannot log while it is stuck, but a long stall that ends is recorded, with its length, in agent.err.log.
{ let last = Date.now(); setInterval(() => { const now = Date.now(); if (now - last > 3000) console.warn(`[watchdog] the event loop was blocked for ${Math.round((now - last) / 1000)} s`); last = now; }, 1000).unref(); }

console.log(`Nookdeck running on port ${app.port}`);
console.log(`Phone:  http://${lanIp()}:${app.port}  or  http://${host}.local:${app.port}`);
console.log(`${t("Manage:")} http://localhost:${app.port}/manage/`);
void printPairing(app.pin);

const shutdown = () => { app.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
