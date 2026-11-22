// bun 1.3.x on macOS 27 emits a compiled binary with a malformed signature slot, and the kernel SIGKILLs it on launch
// (exit 137). Strip it and sign again. No-op elsewhere.
//
// Which identity (so Accessibility grants survive updates: the designated requirement is the same for every build):
//   ci     MACOS_SIGN_P12 (base64 .p12) + MACOS_SIGN_P12_PASSWORD: a temporary keychain is made, used and deleted
//   local  ~/.config/nookdeck-signing/signing.keychain-db (NOOKDECK_SIGN_DIR overrides): unlocked with its password file
//   adhoc  otherwise, with a loud log line. A tag build (NOOKDECK_REQUIRE_CI_SIGNING=1) refuses to fall back.
// Nothing from the signing folder is ever printed; the keychain is never added to the user's search list.
import { existsSync } from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const IDENTIFIER = "dev.nookdeck.agent";
export type SignMode = "ci" | "local" | "adhoc";

export function signDir(env: Record<string, string | undefined> = process.env): string {
  return env.NOOKDECK_SIGN_DIR ?? join(homedir(), ".config", "nookdeck-signing");
}

/** Pure: which mode to use. */
export function chooseMode(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): SignMode {
  if (env.MACOS_SIGN_P12) return "ci";
  if (exists(join(signDir(env), "signing.keychain-db"))) return "local";
  return "adhoc";
}

/** Throws when a release build would ship with less than the CI identity. */
export function checkRequired(mode: SignMode, env: Record<string, string | undefined>): void {
  if (env.NOOKDECK_REQUIRE_CI_SIGNING === "1" && mode !== "ci") {
    throw new Error(`this build must be signed with the CI identity, but the mode is "${mode}" (is the MACOS_SIGN_P12 secret set for this step?)`);
  }
}

function sh(argv: string[], secrets: string[] = []): string {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim();
  if (p.exitCode !== 0) {
    let msg = `${argv[0]} ${argv[1] ?? ""}: ${out}`;
    for (const s of secrets) if (s) msg = msg.split(s).join("***");
    throw new Error(msg.slice(0, 400));
  }
  return out;
}

export function signMacos(file: string, env: Record<string, string | undefined> = process.env): SignMode {
  const mode = chooseMode(env);
  checkRequired(mode, env);
  sh(["codesign", "--remove-signature", file]);
  if (mode === "adhoc") {
    sh(["codesign", "--force", "-s", "-", file]);
    console.warn(`signed ${file} AD-HOC: no signing identity found. Accessibility resets on every update. Set MACOS_SIGN_P12 (CI) or create ${signDir(env)}.`);
  } else if (mode === "local") {
    const dir = signDir(env);
    const kc = join(dir, "signing.keychain-db");
    const pw = readFileSync(join(dir, "keychain-password.txt"), "utf8").trim();
    const hash = readFileSync(join(dir, "sha1.txt"), "utf8").trim();
    sh(["security", "unlock-keychain", "-p", pw, kc], [pw]);
    sh(["codesign", "--force", "-s", hash, "-i", IDENTIFIER, "--keychain", kc, file], [pw]);
    console.log(`signed ${file} with the local identity ${hash.slice(0, 8)}...`);
  } else {
    const work = mkdtempSync(join(tmpdir(), "nookdeck-sign-"));
    const kc = join(work, "build.keychain-db");
    const pw = randomBytes(18).toString("hex");
    const p12Pass = env.MACOS_SIGN_P12_PASSWORD ?? "";
    // codesign on the CI runner only finds an identity in a keychain that is on the user search list, even with
    // --keychain. The runner is thrown away after the job; the list is restored anyway.
    const listed = Bun.spawnSync(["security", "list-keychains", "-d", "user"], { stdout: "pipe" }).stdout.toString()
      .split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
    try {
      writeFileSync(join(work, "id.p12"), Buffer.from(env.MACOS_SIGN_P12!, "base64"), { mode: 0o600 });
      sh(["security", "create-keychain", "-p", pw, kc], [pw]);
      sh(["security", "set-keychain-settings", "-lut", "3600", kc]);
      sh(["security", "unlock-keychain", "-p", pw, kc], [pw]);
      sh(["security", "import", join(work, "id.p12"), "-k", kc, "-P", p12Pass, "-T", "/usr/bin/codesign"], [pw, p12Pass]);
      sh(["security", "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", pw, kc], [pw]);
      sh(["security", "list-keychains", "-d", "user", "-s", kc, ...listed]);
      const hash = /\b([0-9A-F]{40})\b/.exec(sh(["security", "find-identity", "-p", "codesigning", kc]))?.[1];
      if (!hash) throw new Error("the imported .p12 has no signing identity");
      sh(["codesign", "--force", "-s", hash, "-i", IDENTIFIER, "--keychain", kc, file], [pw, p12Pass]);
      console.log(`signed ${file} with the CI identity ${hash.slice(0, 8)}...`);
    } finally {
      if (listed.length) Bun.spawnSync(["security", "list-keychains", "-d", "user", "-s", ...listed]);
      Bun.spawnSync(["security", "delete-keychain", kc]);
      rmSync(work, { recursive: true, force: true });
    }
  }
  const dr = Bun.spawnSync(["codesign", "-d", "-r-", file], { stdout: "pipe", stderr: "pipe" });
  console.log(`mode: ${mode}\n${`${dr.stdout.toString()}${dr.stderr.toString()}`.split("\n").filter((l) => l.startsWith("designated")).join("\n")}`);
  return mode;
}

if (import.meta.main && process.platform === "darwin") {
  const file = process.argv[2] ?? "dist/nookdeck";
  try { signMacos(file); } catch (e: any) { console.error(`sign-macos: ${e?.message ?? e}`); process.exit(1); }
}
