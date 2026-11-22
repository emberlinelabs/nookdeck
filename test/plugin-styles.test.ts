import { describe, expect, test } from "bun:test";
import { PLUGIN_STYLES } from "../web/shared/plugin-styles";
import { ALL_STYLES, STYLES } from "../src/config";
import { PLUGIN_STYLES as DECK, pickStyle } from "../web/deck/src/plugin-logic";
import { PLUGIN_STYLES as MANAGE } from "../web/manage/src/components/plugin-style";
import { RENDERERS } from "../src/plugins/types";

describe("plugin display styles: one table", () => {
  test("the agent, the deck and the manage picker use the shared table", () => {
    expect(STYLES).toEqual(PLUGIN_STYLES);
    expect(DECK).toEqual(PLUGIN_STYLES);
    expect(MANAGE).toEqual(PLUGIN_STYLES);
    expect(STYLES).toBe(PLUGIN_STYLES);
    expect(DECK).toBe(PLUGIN_STYLES);
    expect(MANAGE).toBe(PLUGIN_STYLES);
  });
  test("every renderer has styles and the agent accepts every one", () => {
    for (const r of RENDERERS) expect(PLUGIN_STYLES[r]?.length).toBeGreaterThan(1);
    for (const s of Object.values(PLUGIN_STYLES).flat()) expect(ALL_STYLES).toContain(s);
  });
  test("pickStyle: choice, then suggestion, then the first style", () => {
    expect(pickStyle("chart", "bars", "area")).toBe("bars");
    expect(pickStyle("chart", undefined, "area")).toBe("area");
    expect(pickStyle("chart", "pill", "nope")).toBe("line");
    expect(pickStyle("status", undefined, undefined)).toBe("card");
  });
});
