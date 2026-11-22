import { describe, expect, test } from "bun:test";
import { NP_COL_MIN, NP_NEED, npCoverSize, npInlineVol, npVariant } from "../web/deck/src/now-playing-utils";

// Tile sizes of 2x1, 2x2, 3x2 and 4x2 cells at cell sizes 90-140 px with the usual gaps: whatever layout is chosen must have room for
// all its controls (nothing clipped), and the volume control is always there (a slider row, or the volume button of the transport row).
describe("Now Playing: no control is cut off", () => {
  for (const gap of [8, 10, 12]) {
    for (const [cw, ch] of [[2, 1], [2, 2], [3, 2], [4, 2]] as const) {
      for (let cell = 90; cell <= 140; cell += 2) {
        const tw = cell * cw + gap * (cw - 1), th = cell * ch + gap * (ch - 1);
        test(`${cw}x${ch} cell ${cell} gap ${gap} (${tw}x${th})`, () => {
          const v = npVariant(tw, th);
          expect(v).not.toBe("capsule");
          expect(tw).toBeGreaterThanOrEqual(NP_NEED[v]!.w);
          expect(th).toBeGreaterThanOrEqual(NP_NEED[v]!.h);
          if (v === "large") {
            // the controls column keeps the room for 3 transport buttons + the volume button
            const col = tw - 32 - 14 - npCoverSize(tw, th);
            expect(col).toBeGreaterThanOrEqual(NP_COL_MIN);
            expect(npCoverSize(tw, th)).toBeLessThanOrEqual(th - 24);
          }
          // the slider row only when the column is tall enough for it; otherwise the volume button (always rendered by every layout above capsule)
          if (npInlineVol(v, tw, th)) expect(th).toBeGreaterThanOrEqual(v === "large" ? 236 : 250);
        });
      }
    }
  }
  test("a short wide tile gets the one-row layout, not stacked rows", () => {
    expect(npVariant(390, 100)).toBe("compact");
    expect(npVariant(260, 125)).toBe("compact");
    expect(npVariant(506, 248)).toBe("large");
  });
});
