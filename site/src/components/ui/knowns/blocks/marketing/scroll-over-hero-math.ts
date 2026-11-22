export const TITLE_END = 0.35;
/** How far the title lifts by TITLE_END, px, and the scale it reaches. */
export const TITLE_LIFT = 40;
export const TITLE_TO_SCALE = 0.92;
/** The panel has fully arrived (top reached, scale 1) by this much progress; the rest is a still hold. */
export const PANEL_END = 0.5;
/** The panel's scale when it starts to peek. */
export const PANEL_FROM_SCALE = 0.95;
/** Space between the title and the peeking panel, px. */
export const PEEK_GAP = 24;
/** The panel stops this far from the top of the stage, px. */
export const PANEL_TOP = 48;
/** Under this much visible panel at rest (px) there is nothing to reveal, so the layout falls back to stacked. */
export const MIN_PEEK = 120;

export const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Progress through the pinned span of a track: 0 while its top is at or below the viewport top, 1 once pinning ends. */
export function pinProgress(trackTop: number, trackHeight: number, viewport: number): number {
  const span = trackHeight - viewport;
  return span <= 0 ? 0 : clamp01(-trackTop / span) + 0;
}

/** The title's pose at progress p: it fades out, lifts and scales down toward TITLE_TO_SCALE by TITLE_END. */
export function titlePose(p: number) {
  const t = clamp01(p / TITLE_END);
  return { opacity: 1 - t, y: -TITLE_LIFT * t, scale: 1 - (1 - TITLE_TO_SCALE) * t };
}

/** The panel's pose at progress p; `from` is its resting offset in px (how far below its final top it starts). */
export function panelPose(p: number, from: number) {
  const t = clamp01(p / PANEL_END);
  return { y: from * (1 - t), scale: PANEL_FROM_SCALE + (1 - PANEL_FROM_SCALE) * t };
}

/** How far down the panel starts: it peeks just below the title (whose height, with its own top space, is `titleBottom`). */
export function panelFrom(titleBottom: number): number {
  return titleBottom + PEEK_GAP - PANEL_TOP;
}

/** How much of the panel shows at rest, px, for a stage of height `viewport`. */
export const peekHeight = (viewport: number, titleBottom: number) => viewport - (titleBottom + PEEK_GAP);

/** True when the title nearly fills the viewport, so the panel would barely peek and the stacked layout reads better. */
export const shouldStack = (viewport: number, titleBottom: number) => peekHeight(viewport, titleBottom) < MIN_PEEK;
