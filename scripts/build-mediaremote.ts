#!/usr/bin/env bun
// Builds vendor/mediaremote-adapter into build/mediaremote/MediaRemoteAdapter: a universal (arm64 + x86_64) dylib, ad-hoc signed,
// then regenerates src/platform/mra-embed.gen.ts so the next `bun build --compile` embeds it. macOS only (needs clang).
// The sources are the CMake target's ADAPTER_SOURCES, pinned at the commit in vendor/mediaremote-adapter/COMMIT.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MRA_BUILT, MRA_ROOT, writeMraEmbed } from "./mra-assets";

if (process.platform !== "darwin") {
  console.log("build-mediaremote: not macOS, skipped");
  writeMraEmbed();
  process.exit(0);
}
const src = join(MRA_ROOT, "vendor", "mediaremote-adapter");
const cmake = readFileSync(join(src, "CMakeLists.txt"), "utf8");
const list = /set\(ADAPTER_SOURCES([\s\S]*?)\)/.exec(cmake)?.[1];
if (!list) throw new Error("ADAPTER_SOURCES not found in CMakeLists.txt");
const files = list.split(/\s+/).filter(Boolean);

mkdirSync(join(MRA_BUILT, ".."), { recursive: true });
const run = (argv: string[]) => {
  const p = Bun.spawnSync(argv, { cwd: src, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`${argv[0]} failed (${p.exitCode})`);
};
run([
  "clang", "-fobjc-arc", "-dynamiclib", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0",
  "-Iinclude", "-Isrc", ...files,
  "-framework", "Foundation", "-framework", "AppKit", "-framework", "UniformTypeIdentifiers",
  "-install_name", "@rpath/MediaRemoteAdapter", "-o", MRA_BUILT,
]);
run(["codesign", "--force", "-s", "-", MRA_BUILT]);
console.log(`built ${MRA_BUILT}`);
writeMraEmbed();
