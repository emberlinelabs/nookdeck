// The deck's On Air, mic and camera rendering from the exact contract messages (spec obs-integration-and-on-air, "Contract"), as they come off the wire.
import { expect, test } from "bun:test";
import { parseOnAir } from "../web/shared/onair";
import { liveView, onAirView, signVisible, elapsed, PEEK_MS } from "../web/deck/src/live-logic";

const T0 = 1764170000000;
const wire = (o: unknown) => JSON.parse(JSON.stringify(o));
const AIR = parseOnAir(wire({ type: "onair", on: true, since: T0, sources: ["obs-stream", "mic", "api"], label: "Podcast", mic: { inUse: true, muted: true }, camera: { inUse: true } }))!;
const AIR_OFF = parseOnAir(wire({ type: "onair", on: false, sources: [], mic: { inUse: false, muted: null }, camera: { inUse: false } }))!;

test("buttons without an On Air, mic or camera action have no live state", () => {
  expect(liveView({ type: "hotkey", keys: "a" }, AIR)).toBeNull();
  expect(liveView(undefined, AIR)).toBeNull();
  // OBS is a Store plugin now: its buttons are plugin actions, drawn by the plugin renderers
  expect(liveView({ type: "obs", op: "record" }, AIR)).toBeNull();
});

test("On Air, mic and camera buttons", () => {
  expect(liveView({ type: "onair", mode: "toggle" }, AIR)).toEqual({ state: "live", since: T0 });
  expect(liveView({ type: "onair" }, AIR_OFF)).toEqual({ state: "off" });
  expect(liveView({ type: "mic" }, AIR)).toEqual({ state: "muted", sub: "Mic off" });
  expect(liveView({ type: "mic" }, AIR_OFF)).toEqual({ state: "off", sub: "No microphone" });
  expect(liveView({ type: "camera" }, AIR)).toEqual({ state: "on", sub: "Camera in use" });
  expect(liveView({ type: "camera" }, AIR_OFF)).toEqual({ state: "off", sub: "Camera off" });
});

test("On Air tile: why, the API label, and Mic off", () => {
  const v = onAirView(AIR);
  expect(v.on).toBe(true);
  expect(v.title).toBe("ON AIR");
  expect(v.reasons).toEqual([{ text: "Live" }, { text: "Mic off" }, { text: "Podcast", raw: true }]);
  expect(v.micOff).toBe(true);
  expect(v.since).toBe(T0);
  expect(onAirView(AIR_OFF)).toEqual({ on: false, title: "Off air", reasons: [], micOff: false });
  expect(onAirView(undefined).on).toBe(false);
  const plain = parseOnAir(wire({ type: "onair", on: true, since: T0, sources: ["camera", "api"], mic: { inUse: false, muted: false }, camera: { inUse: true } }))!;
  expect(onAirView(plain).reasons).toEqual([{ text: "Camera" }, { text: "API" }]);
});

test("the full-screen sign: only with the option, while on, not during a 30 s peek", () => {
  expect(signVisible(true, AIR, 0, T0)).toBe(true);
  expect(signVisible(false, AIR, 0, T0)).toBe(false);
  expect(signVisible(true, AIR_OFF, 0, T0)).toBe(false);
  expect(signVisible(true, AIR, T0 + PEEK_MS, T0 + 1000)).toBe(false);
  expect(signVisible(true, AIR, T0 + PEEK_MS, T0 + PEEK_MS + 1)).toBe(true);
  expect(PEEK_MS).toBe(30000);
});

test("elapsed", () => {
  expect(elapsed(0)).toBe("0:00");
  expect(elapsed(-5000)).toBe("0:00");
  expect(elapsed(65000)).toBe("1:05");
  expect(elapsed(3600000 + 61000)).toBe("1:01:01");
});
