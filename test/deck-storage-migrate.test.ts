import { describe, expect, test } from "bun:test";
import { RENAMED_KEYS, migrateKeys } from "../web/deck/src/storage-migrate";

const mem = (init: { [k: string]: string }) => {
  const m = new Map<string, string>(Object.keys(init).map((k) => [k, init[k]] as [string, string]));
  return { m, get: (k: string) => (m.has(k) ? (m.get(k) as string) : null), set: (k: string, v: string) => void m.set(k, v) };
};
const PAIRS: Array<[string, string]> = [["phonedesk.token", "nookdeck.token"], ["phonedesk.deviceId", "nookdeck.deviceId"]];

describe("deck storage key migration", () => {
  test("copies old to new when the new key is missing, keeps the old", () => {
    const s = mem({ "phonedesk.token": "tok", "phonedesk.deviceId": "dev" });
    expect(migrateKeys(s, PAIRS).sort()).toEqual(["nookdeck.deviceId", "nookdeck.token"]);
    expect(s.get("nookdeck.token")).toBe("tok");
    expect(s.get("phonedesk.token")).toBe("tok");
  });
  test("never overwrites an existing new key, and a second run changes nothing", () => {
    const s = mem({ "phonedesk.token": "old", "nookdeck.token": "new" });
    expect(migrateKeys(s, PAIRS)).toEqual([]);
    expect(s.get("nookdeck.token")).toBe("new");
    const t = mem({ "phonedesk.deviceId": "d" });
    migrateKeys(t, PAIRS);
    expect(migrateKeys(t, PAIRS)).toEqual([]);
  });
  test("missing old key and throwing storage are harmless", () => {
    expect(migrateKeys(mem({}), PAIRS)).toEqual([]);
    const bad = { get: () => { throw new Error("denied"); }, set: () => { throw new Error("denied"); } };
    expect(migrateKeys(bad, PAIRS)).toEqual([]);
    const ro = { get: (k: string) => (k === "phonedesk.token" ? "t" : null), set: () => { throw new Error("full"); } };
    expect(migrateKeys(ro, PAIRS)).toEqual([]);
  });
  test("the deck's real keys never contained the product name, so none are renamed", () => {
    expect(RENAMED_KEYS).toEqual([]);
  });
});
