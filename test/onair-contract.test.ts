// The On Air contract (web/shared/onair.ts): the exact `onair` message of the spec parses as it is, odd values fall back, settings get
// their defaults, and the onair / mic / camera actions and macro steps validate the same way on every side.
import { expect, test } from "bun:test";
import { parseOnAir, parseOnAirSettings, validOnairAction } from "../web/shared/onair";

const ONAIR = { type: "onair", on: true, since: 1764170000000, sources: ["obs-record", "mic"], label: "Podcast", mic: { inUse: true, muted: false }, camera: { inUse: false } };

test("the contract message parses as it is", () => {
  expect(parseOnAir(ONAIR)).toEqual(ONAIR as any);
  expect(parseOnAir(JSON.parse(JSON.stringify(ONAIR)))).toEqual(ONAIR as any);
  // GET /api/onair may come without type, and with settings (dropped here)
  expect(parseOnAir({ on: false, sources: [], mic: { inUse: false, muted: null }, camera: { inUse: false }, settings: {} })?.type).toBe("onair");
});

test("onair: unknown sources dropped, muted null kept, label capped", () => {
  const p = parseOnAir({ type: "onair", on: false, sources: ["mic", "zoom"], mic: { inUse: false, muted: null }, camera: {}, label: "x".repeat(99) })!;
  expect(p.sources).toEqual(["mic"]);
  expect(p.mic.muted).toBeNull();
  expect(p.since).toBeUndefined();
  expect(p.label!.length).toBe(60);
  expect(parseOnAir({ type: "onair" })).toBeNull();
  expect(parseOnAir({ type: "obs", on: true })).toBeNull();
  expect(parseOnAir(null)).toBeNull();
});

test("settings defaults", () => {
  expect(parseOnAirSettings(undefined, false)).toEqual({ sources: { obs: false, mic: true, camera: true, manual: true, api: true }, ignoreSelf: true });
  expect(parseOnAirSettings({ sources: { mic: false }, ignoreSelf: false })).toEqual({ sources: { obs: true, mic: false, camera: true, manual: true, api: true }, ignoreSelf: false });
});

test("action and macro step validation", () => {
  const ok = [{ type: "onair" }, { type: "onair", mode: "on" }, { type: "mic", mode: "mute" }, { type: "mic" }, { type: "camera" }, { type: "camera", mode: "x" }, { kind: "onair", mode: "off" }, { kind: "mic", mode: "unmute" }];
  for (const a of ok) expect([a, validOnairAction(a)]).toEqual([a, null]);
  const bad = [{ type: "onair", mode: "flip" }, { type: "mic", mode: 1 }, { type: "mic", mode: "on" }, { type: "obs", op: "record" }, { type: "hotkey", keys: "a" }];
  for (const a of bad) expect([a, typeof validOnairAction(a)]).toEqual([a, "string"]);
});
