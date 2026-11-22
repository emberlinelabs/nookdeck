import { arch } from "node:os";
import pkg from "../package.json" with { type: "json" };
import { BUILD_INFO, DECK_BUILD } from "./assets.gen";
import { platform } from "./platform";

export const REPO_URL = "https://github.com/howznguyen/nookdeck";

export interface About {
  name: string;
  version: string;
  build: string; // deck build id: phones compare it to know they run stale code
  commit: string; // short git SHA baked in at build time, "" when not built from a git checkout
  dirty: boolean; // the tree had uncommitted changes when it was built
  builtAt: string; // ISO time of the build
  platform: string;
  arch: string;
  bun: string;
  repo: string;
  license: string;
}

/** Everything is known at build or start time: no network calls, no update check. */
/** The version a package's "nookdeck": ">=x" is checked against: a modified or source build (dirty, or no commit) counts as a development build, which satisfies any minimum. */
export function compatVersion(): string {
  const a = aboutInfo();
  return a.dirty || !a.commit ? `${a.version}-dev` : a.version;
}

export function aboutInfo(): About {
  return {
    name: "Nookdeck",
    version: pkg.version,
    build: DECK_BUILD,
    commit: BUILD_INFO?.commit ?? "",
    dirty: BUILD_INFO?.dirty ?? false,
    builtAt: BUILD_INFO?.builtAt ?? "",
    platform: platform.id,
    arch: arch(),
    bun: typeof Bun !== "undefined" ? Bun.version : "",
    repo: REPO_URL,
    license: "MIT",
  };
}

/** "nookdeck 0.1.0 (abc1234)", "(abc1234-dirty)" for a tree with changes, plain "nookdeck 0.1.0" without git info. */
export function versionLine(a: About = aboutInfo(), exe: string = process.execPath): string {
  // 0.1.x updaters run the downloaded file as `.phonedesk.update --version` and insist on "phonedesk <version>": a program that carries
  // the old name (the phonedesk-* release assets, a not yet migrated bin/phonedesk) answers in the old way
  const name = /phonedesk/i.test(exe.split(/[\\/]/).pop() ?? "") ? "phonedesk" : "nookdeck";
  return `${name} ${a.version}${a.commit ? ` (${a.commit}${a.dirty ? "-dirty" : ""})` : ""}`;
}
