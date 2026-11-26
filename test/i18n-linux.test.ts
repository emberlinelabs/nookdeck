import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Every message the Linux platform code shows (through t()) has a Vietnamese and a Chinese line, checked per table so a key
// present in one language cannot hide a missing line in the other (the same rule test/doctor.test.ts applies to doctor.ts).
test("every t() key in src/platform/linux*.ts is in the vi and zh tables", () => {
  const dir = join(import.meta.dir, "..", "src", "platform");
  const files = readdirSync(dir).filter((f) => /^linux.*\.ts$/.test(f));
  expect(files.length).toBeGreaterThan(3);
  const keys = new Set<string>();
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]!);
  }
  expect(keys.size).toBeGreaterThan(5);
  const i18n = readFileSync(join(import.meta.dir, "..", "src", "i18n.ts"), "utf8");
  const table = (name: string, next: string) => i18n.slice(i18n.indexOf(`const ${name}: Record`), i18n.indexOf(next));
  const tables = { vi: table("vi", "const zh: Record"), zh: table("zh", "const DICTS") };
  for (const [lang, body] of Object.entries(tables)) {
    const missing = [...keys].filter((k) => !body.includes(`"${k}":`));
    expect({ lang, missing }).toEqual({ lang, missing: [] });
  }
});
