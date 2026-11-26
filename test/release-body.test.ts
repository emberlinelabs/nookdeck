import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A GitHub release shows only its own notes (plus Install and Files); .github/release-notes.md keeps every version.
const root = join(import.meta.dir, "..");
const body = (tag: string, file?: string) =>
  Bun.spawnSync(["sh", join(root, "scripts/release-body.sh"), tag, ...(file ? [file] : [])], { cwd: root }).stdout.toString();
const heads = (s: string) => s.split("\n").filter((l) => l.startsWith("## "));

test.skipIf(process.platform === "win32")("one version's section, with or without a title, then Install and Files", () => {
  const dir = mkdtempSync(join(tmpdir(), "nd-relbody-"));
  const f = join(dir, "notes.md");
  writeFileSync(f, ["## Nookdeck 0.6.1", "", "- fix", "", "## Nookdeck 0.6.0: Linux", "", "- linux", "", "## Nookdeck 0.6.10", "", "- not me", "", "## Install", "", "run it", "", "## Files", "", "a table", ""].join("\n"));
  expect(heads(body("v0.6.1", f))).toEqual(["## Nookdeck 0.6.1", "## Install", "## Files"]);
  expect(heads(body("v0.6.0", f))).toEqual(["## Nookdeck 0.6.0: Linux", "## Install", "## Files"]);
  expect(body("v0.6.1", f)).not.toContain("linux");
  expect(heads(body("v9.9.9", f))).toEqual(["## Install", "## Files"]);
});

test.skipIf(process.platform === "win32")("the real notes file has a section for the version in package.json", () => {
  const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  expect(heads(body(`v${v}`))[0]).toMatch(new RegExp(`^## Nookdeck ${v.replace(/\./g, "\\.")}(:|$)`));
});

test("the publish step uses the extracted body, not the whole file", () => {
  const wf = readFileSync(join(root, ".github/workflows/release.yml"), "utf8").replace(/\r\n/g, "\n");
  expect(wf).toContain('sh scripts/release-body.sh "$GITHUB_REF_NAME" > release-body.md');
  expect(wf).toContain("--notes-file release-body.md");
  expect(wf).not.toContain("--notes-file .github/release-notes.md");
});
