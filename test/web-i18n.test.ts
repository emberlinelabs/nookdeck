// Key parity of the manage page and phone deck translations: every language has every key the others have, with the
// placeholders of its English key, and no em dash.
import { describe, expect, test } from "bun:test";

const MANAGE_FILES = ["app", "editor", "palette", "screens", "automation", "plugins", "themes"] as const;
const LANGS = ["vi", "zh", "fr", "pt"] as const;
const UPPER = { vi: "VI", zh: "ZH", fr: "FR", pt: "PT" } as const;
const cap = (s: string) => s.toUpperCase();

const manage: Record<string, Record<string, Record<string, string>>> = {};
for (const l of LANGS) {
  manage[l] = {};
  for (const f of MANAGE_FILES) {
    const mod = await import(`../web/manage/src/i18n/${l}/${f}.ts`);
    manage[l]![f] = mod[`${UPPER[l]}_${cap(f)}`];
  }
}
const deck: Record<string, Record<string, string>> = {};
for (const l of LANGS) deck[l] = (await import(`../web/deck/src/i18n-${l}.ts`))[UPPER[l]];

/** Sorted placeholder names: {name} for manage, {0} for the deck. */
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();

function checkTable(name: string, tables: Record<string, Record<string, string>>) {
  const union = new Set(Object.values(tables).flatMap((t) => Object.keys(t)));
  // vi and zh grew separately and each misses a few keys (English shows for those); fr and pt carry the full set
  for (const l of ["fr", "pt"]) {
    test(`${name}: ${l} has every key vi or zh has, and no other`, () => {
      const t = tables[l]!;
      expect(t).toBeDefined();
      expect([...union].filter((k) => !(k in t))).toEqual([]);
      expect(Object.keys(t).filter((k) => !(k in tables.vi!) && !(k in tables.zh!))).toEqual([]);
    });
  }
  for (const l of LANGS) {
    test(`${name}: ${l} keeps the placeholders of each key, no empty value, no em dash`, () => {
      const bad: string[] = [];
      for (const [k, v] of Object.entries(tables[l]!)) {
        if (/^[a-z_]+\./.test(k) || k.includes("{brightness_pct")) continue; // literal braces in a service example
        if (ph(k) !== ph(v) || !v.trim() || v.includes("\u2014")) bad.push(`${k} => ${v}`);
      }
      expect(bad).toEqual([]);
    });
  }
}

describe("manage translations", () => {
  for (const f of MANAGE_FILES) checkTable(`manage/${f}`, Object.fromEntries(LANGS.map((l) => [l, manage[l]![f]!])));
  test("each language index merges all its files", async () => {
    for (const l of LANGS) {
      const all = (await import(`../web/manage/src/i18n/${l}/index.ts`))[UPPER[l]];
      for (const f of MANAGE_FILES) for (const k of Object.keys(manage[l]![f]!)) expect(k in all).toBe(true);
    }
  });
});

describe("deck translations", () => {
  checkTable("deck", deck);
});

describe("language codes", () => {
  test("manage: the picker lists the five languages, the stored value and the browser language map to them", async () => {
    const I = await import("../web/manage/src/lib/i18n");
    expect(I.LANGUAGES.map((l) => l.id)).toEqual(["en", "vi", "zh", "fr", "pt"]);
    expect(I.LANGUAGES.find((l) => l.id === "fr")!.label).toBe("Français");
    expect(I.LANGUAGES.find((l) => l.id === "pt")!.label).toBe("Português");
    expect(I.asLanguage("fr")).toBe("fr");
    expect(I.asLanguage("pt")).toBe("pt");
    expect(I.asLanguage("de")).toBe("en");
    expect(I.fromBrowser("fr-CA")).toBe("fr");
    expect(I.fromBrowser("pt-PT")).toBe("pt");
    expect(I.fromBrowser("pt-BR")).toBe("pt");
    expect(I.fromBrowser("de-DE")).toBe("en");
    expect(I.localeTag("pt")).toBe("pt-BR");
    expect(I.localeTag("fr")).toBe("fr-FR");
    expect(I.translationsOf("New button").length).toBe(4);
  });
  test("deck: the device language and the layout value map to the five languages", async () => {
    const D = await import("../web/deck/src/i18n");
    expect(D.fromDevice("fr-FR")).toBe("fr");
    expect(D.fromDevice("pt-BR")).toBe("pt");
    expect(D.fromDevice("es-ES")).toBe("en");
    D.setLang("pt");
    expect(D.getLang()).toBe("pt");
    expect(D.locale()).toBe("pt-BR");
    expect(D.t("Cancel")).toBe(deck.pt!["Cancel"] ?? "Cancel");
    D.setLang("en");
  });
});
