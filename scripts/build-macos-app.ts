// Builds the macOS menu bar app: dist/macos/Nookdeck.app and Nookdeck.dmg (spec: Knowns doc specs/desktop-apps, A2, A3).
//
//   bun scripts/build-macos-app.ts                     full build: both agent programs, universal app, sign, dmg
//   bun scripts/build-macos-app.ts --host-agent        dev: bundle dist/nookdeck for this Mac's architecture only
//   --agent-arm64 <file> --agent-x64 <file>            use programs built earlier instead of compiling them
//   --no-dmg                                           stop after the .app
//   --out <dir>                                        default dist/macos
//
// The app is a controller (A1): it bundles the agent program per architecture in Contents/Resources/agent/ and installs it on
// first run. Both the agent programs and the app are signed with the release identity (scripts/sign-macos.ts: ci, local or ad hoc);
// the agent keeps the identifier dev.nookdeck.agent so Accessibility grants survive updates, the app is dev.nookdeck.app.
// Prerequisites (CI runs them before this): bun scripts/ensure-icons.ts, bun run build:web, bun scripts/build-mediaremote.ts, bun run gen-assets.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { arch as hostArch } from "node:os";
import { signMacos } from "./sign-macos";

export const APP_ID = "dev.nookdeck.app";
export const AGENT_TARGETS = [
  { arch: "arm64", bunTarget: "bun-darwin-arm64", file: "nookdeck-arm64" },
  { arch: "x86_64", bunTarget: "bun-darwin-x64", file: "nookdeck-x86_64" },
] as const;

/** Info.plist of the app: a menu bar only app (LSUIElement), macOS 13+ (MenuBarExtra, SMAppService). */
export function infoPlist(version: string, build: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>Nookdeck</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleLocalizations</key><array><string>en</string><string>vi</string><string>zh-Hans</string></array>
  <key>CFBundleName</key><string>Nookdeck</string>
  <key>CFBundleDisplayName</key><string>Nookdeck</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${esc(version)}</string>
  <key>CFBundleVersion</key><string>${esc(build)}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Nookdeck</string>
</dict>
</plist>
`;
}

export interface Options { hostAgent: boolean; agentArm64?: string; agentX64?: string; dmg: boolean; out: string }

export function parseArgs(argv: string[]): Options {
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  return { hostAgent: argv.includes("--host-agent"), agentArm64: flag("--agent-arm64"), agentX64: flag("--agent-x64"), dmg: !argv.includes("--no-dmg"), out: resolve(flag("--out") ?? "dist/macos") };
}

function run(argv: string[], cwd?: string): string {
  const p = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  if (p.exitCode !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (${p.exitCode}): ${out.slice(-600)}`);
  return out;
}

const root = resolve(import.meta.dir, "..");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A compiled agent for one architecture, signed with dev.nookdeck.agent. */
function buildAgent(t: (typeof AGENT_TARGETS)[number], work: string, o: Options): string {
  const given = t.arch === "arm64" ? o.agentArm64 : o.agentX64;
  const dest = join(work, t.file);
  if (given) copyFileSync(resolve(given), dest);
  else if (o.hostAgent) {
    const host = hostArch() === "arm64" ? "arm64" : "x86_64";
    if (t.arch !== host) return "";
    copyFileSync(join(root, "dist/nookdeck"), dest);
  } else {
    console.log(`compiling the agent for ${t.arch} ...`);
    run(["bun", "build", "src/index.ts", "src/platform/mac-worker.ts", "--compile", `--target=${t.bunTarget}`, "--outfile", dest], root);
  }
  signMacos(dest);
  return dest;
}

export function build(o: Options): { app: string; dmg?: string } {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  // build in a staging folder and swap it in only when everything worked, so a failed build never removes the last good app
  const finalOut = o.out;
  o = { ...o, out: `${finalOut}.building` };
  const work = join(o.out, "work");
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const finish = <T,>(r: T): T => { rmSync(finalOut, { recursive: true, force: true }); renameSync(o.out, finalOut); return r; };
  const at = (p: string) => p.replace(o.out, finalOut);

  const agents = AGENT_TARGETS.map((t) => ({ t, file: buildAgent(t, work, o) })).filter((a) => a.file);
  if (!agents.length) throw new Error("no agent program to bundle");

  console.log("building the app (universal) ...");
  const pkg = join(root, "apps/macos");
  const swiftArgs = ["-c", "release", "--arch", "arm64", "--arch", "x86_64", "--package-path", pkg];
  run(["swift", "build", ...swiftArgs], root);
  // where the product lands depends on the toolchain (.build/apple/... or .build/out/...): ask SwiftPM
  const bin = join(run(["swift", "build", ...swiftArgs, "--show-bin-path"], root).trim().split("\n").pop()!, "Nookdeck");
  if (!existsSync(bin)) throw new Error(`the Swift build left no ${bin}`);

  const app = join(o.out, "Nookdeck.app");
  const res = join(app, "Contents/Resources");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(res, "agent"), { recursive: true });
  mkdirSync(join(res, "icons"), { recursive: true });
  copyFileSync(bin, join(app, "Contents/MacOS/Nookdeck"));
  chmodSync(join(app, "Contents/MacOS/Nookdeck"), 0o755);
  writeFileSync(join(app, "Contents/Info.plist"), infoPlist(version, String(Math.floor(Date.now() / 1000))));
  writeFileSync(join(app, "Contents/PkgInfo"), "APPL????");
  for (const a of agents) { copyFileSync(a.file, join(res, "agent", a.t.file)); chmodSync(join(res, "agent", a.t.file), 0o755); }
  const shared = join(root, "apps/shared");
  copyFileSync(join(shared, "strings.json"), join(res, "strings.json"));
  copyFileSync(join(shared, "icons/macos/AppIcon.icns"), join(res, "AppIcon.icns"));
  for (const n of ["nookdeck", "nookdeck-running", "nookdeck-stopped", "nookdeck-attention"]) for (const f of [`${n}Template.png`, `${n}Template@2x.png`]) copyFileSync(join(shared, "icons/macos", f), join(res, "icons", f));

  // the programs inside are already signed (identifier dev.nookdeck.agent); now the bundle, with the app's own identifier
  signMacos(app, process.env, APP_ID);
  run(["codesign", "--verify", "--strict", "--deep", app]);
  rmSync(work, { recursive: true, force: true });
  if (!o.dmg) { console.log(`built ${at(app)}`); return finish({ app: at(app) }); }

  const stage = join(o.out, "dmg");
  mkdirSync(stage, { recursive: true });
  run(["ditto", app, join(stage, "Nookdeck.app")]);
  symlinkSync("/Applications", join(stage, "Applications"));
  const dmg = join(o.out, "Nookdeck.dmg");
  // hdiutil's own size estimate is sometimes too small on CI runners ("No space left on device" while copying the agent): give it room explicitly, and retry once or twice
  const mb = Math.ceil(Number(run(["du", "-sk", stage]).trim().split(/\s+/)[0]) / 1024 * 1.5) + 64;
  for (let attempt = 1; ; attempt++) {
    try { run(["hdiutil", "create", "-volname", "Nookdeck", "-srcfolder", stage, "-fs", "HFS+", "-size", `${mb}m`, "-ov", "-format", "UDZO", dmg]); break; }
    catch (e) {
      if (attempt >= 3) throw e;
      console.warn(`hdiutil failed (attempt ${attempt}), retrying: ${e instanceof Error ? e.message : e}`);
      try { run(["hdiutil", "detach", "/Volumes/Nookdeck", "-force"]); } catch {}
      rmSync(dmg, { force: true });
    }
  }
  rmSync(stage, { recursive: true, force: true });
  writeFileSync(`${dmg}.sha256`, `${sha256(dmg)}  Nookdeck.dmg\n`);
  console.log(`built ${at(app)}\nbuilt ${at(dmg)} (${Math.round(statSync(dmg).size / 1e6)} MB)`);
  return finish({ app: at(app), dmg: at(dmg) });
}

if (import.meta.main) {
  if (process.platform !== "darwin") { console.error("build-macos-app: macOS only"); process.exit(1); }
  try { build(parseArgs(process.argv.slice(2))); } catch (e: any) { console.error(`build-macos-app: ${e?.message ?? e}`); process.exit(1); }
}
