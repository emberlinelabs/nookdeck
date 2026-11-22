import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, PLUGINS_CHANGED } from "@/api";
import { IconAlertTriangle as Warn, IconDeviceMobile as Iphone, IconRotateClockwise as RotateRight, IconDeviceTablet as Tablet } from "@tabler/icons-react";
import { SegmentedControl } from "@/components/ui/knowns/segmented-control";
import { Select } from "@/components/ui/knowns/select";
import { Input } from "@/components/ui/knowns/input";
import { CUSTOM_MAX, CUSTOM_MIN, SCREEN_PRESETS, useScreenSize } from "@/lib/screen-size";
import { t, useLanguage } from "@/lib/i18n";
import { previewPluginData } from "@/lib/plugin-ui";
import type { PluginInfo } from "@/types";
import type { Layout } from "@/types";

export interface PreviewController {
  /** The grid cell under a client-coordinate point of the current page, or null when the point is off the grid. */
  cellAt: (clientX: number, clientY: number) => { x: number; y: number } | null;
}

/** A target rectangle (in cells) drawn over the phone while dragging; red when the drop would be refused. */
export interface DropGhost {
  x: number;
  y: number;
  w: number;
  h: number;
  bad: boolean;
}

interface GridGeometry { left: number; top: number; cell: number; gap: number; cols: number; rows: number }

/** Reads the deck's grid (same origin) in iframe pixels. Returns null when it cannot be read. */
function readGrid(frame: HTMLIFrameElement | null, pageId: string): GridGeometry | null {
  try {
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow;
    if (!doc || !win) return null;
    const grid = Array.from(doc.querySelectorAll<HTMLElement>("[data-grid]")).find((g) => g.dataset.grid === pageId);
    if (!grid) return null;
    const cs = win.getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(" ").map(parseFloat).filter((n) => Number.isFinite(n));
    const rows = cs.gridTemplateRows.split(" ").map(parseFloat).filter((n) => Number.isFinite(n));
    if (!cols.length || !rows.length) return null;
    const r = grid.getBoundingClientRect();
    return { left: r.left, top: r.top, cell: cols[0]!, gap: parseFloat(cs.columnGap) || 0, cols: cols.length, rows: rows.length };
  } catch {
    return null; // cross-origin preview
  }
}

/** Icon values the deck cannot draw by itself: Mac app icons and uploaded images. */
function iconValues(l: Layout): string[] {
  const out = new Set<string>();
  for (const p of l.pages) for (const i of p.items) if (i.kind === "button" && i.icon && /^(app|img):/.test(i.icon)) out.add(i.icon);
  return [...out];
}

/**
 * Asset map for the preview (POST /api/layout/assets), refreshed ~300 ms after the layout settles.
 * Per icon value: values already resolved (or already asked about) are not requested again.
 */
function usePreviewAssets(layout: Layout): Record<string, unknown> {
  const [assets, setAssets] = useState<Record<string, unknown>>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const need = iconValues(layout).filter((v) => !asked.current.has(v));
    if (!need.length) return;
    const t = setTimeout(() => {
      need.forEach((v) => asked.current.add(v));
      api.layoutAssets(layout).then(
        (got) => setAssets((cur) => ({ ...cur, ...got })),
        () => need.forEach((v) => asked.current.delete(v)), // retry on the next change
      );
    }, 300);
    return () => clearTimeout(t);
  }, [layout]);
  return assets;
}

export type Orientation = "portrait" | "landscape";
const BEZEL = 14;

// In production the deck is served by the same agent at "/". VITE_AGENT overrides the origin (dev against another host).
export const DECK_URL = `${(import.meta.env.VITE_AGENT as string | undefined) ?? ""}/?preview=1`;
export const DECK_ORIGIN = new URL(DECK_URL, location.href).origin;

/**
 * Frame orientation: follows theme.orientation (landscape by default) until the portrait/landscape toggle overrides it
 * for viewing. The override is not saved in the layout.
 */
export function usePreviewOrientation(themeOrientation: string | undefined): [Orientation, (o: Orientation) => void] {
  const [override, setOverride] = useState<Orientation | null>(null);
  const base: Orientation = themeOrientation === "portrait" ? "portrait" : "landscape";
  return [override ?? base, setOverride];
}

/**
 * The real phone deck in an iframe inside a device frame, scaled to fit. Driven by postMessage:
 * we send {type:"pd-preview", layout, pageId, selectedId}; the deck answers pd-ready / pd-select / pd-page.
 */
export function PhonePreview({ layout, override, ghost, controller, pageId, selectedId, orientation, onOrientation, onSelect, onMove, onResize, onPage, onEditGrid, dimLevel }: {
  layout: Layout;
  /** Tentative layout to draw instead of `layout` (live drag preview). */
  override?: Layout | null;
  ghost?: DropGhost | null;
  controller?: { current: PreviewController | null };
  pageId: string;
  selectedId: string | null;
  orientation: Orientation;
  onOrientation: (o: Orientation) => void;
  /** itemId is null for an empty cell; x/y are then the cell the user tapped. */
  onSelect?: (pageId: string, itemId: string | null, cell?: { x: number; y: number }) => void;
  onMove?: (pageId: string, itemId: string, x: number, y: number) => void;
  onResize?: (pageId: string, itemId: string, w: number, h: number, x?: number, y?: number) => void;
  onPage?: (pageId: string) => void;
  /** Jump to the page grid settings (offered when tiles are small). */
  onEditGrid?: () => void;
  /** Draws a black overlay (0..0.9) over the screen, to see what dimming looks like. */
  dimLevel?: number;
}) {
  useLanguage();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [avail, setAvail] = useState<[number, number]>([0, 0]);
  const base = override ?? layout;
  const assets = usePreviewAssets(base);
  const shown = useMemo(() => (Object.keys(assets).length ? { ...base, assets: { ...(base.assets ?? {}), ...assets } } : base), [base, assets]);
  // The installed plugins: their sample data is what plugin tiles show here (never invented values).
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => { api.getPlugins().then((p) => live && setPlugins(p), () => undefined); };
    load();
    window.addEventListener(PLUGINS_CHANGED, load);
    return () => { live = false; window.removeEventListener(PLUGINS_CHANGED, load); };
  }, []);
  const pluginData = useMemo(() => previewPluginData(shown, plugins), [shown, plugins]);
  const latest = useRef({ layout: shown, pageId, selectedId, pluginData });
  latest.current = { layout: shown, pageId, selectedId, pluginData };

  const post = useCallback(() => {
    const w = frame.current?.contentWindow;
    if (!w) return;
    const { layout, pageId, selectedId, pluginData } = latest.current;
    w.postMessage({ type: "pd-preview", layout, pageId, selectedId, pluginData }, DECK_ORIGIN);
  }, []);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== DECK_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; pageId?: string; itemId?: string | null; x?: number; y?: number; w?: number; h?: number } | null;
      const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      if (!d || typeof d !== "object") return;
      if (d.type === "pd-ready") {
        setReady(true);
        post();
      } else if (d.type === "pd-select" && d.pageId) {
        if (d.itemId) onSelect?.(d.pageId, d.itemId);
        else if (num(d.x) && num(d.y)) onSelect?.(d.pageId, null, { x: d.x, y: d.y });
      } else if (d.type === "pd-move" && d.pageId && d.itemId && num(d.x) && num(d.y)) onMove?.(d.pageId, d.itemId, d.x, d.y);
      else if (d.type === "pd-resize" && d.pageId && d.itemId && num(d.w) && num(d.h)) onResize?.(d.pageId, d.itemId, d.w, d.h, num(d.x) ? d.x : undefined, num(d.y) ? d.y : undefined);
      else if (d.type === "pd-page" && d.pageId) onPage?.(d.pageId);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post, onSelect, onMove, onResize, onPage]);

  useEffect(() => {
    if (ready) post();
  }, [ready, shown, pageId, selectedId, pluginData, post]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail([el.clientWidth, el.clientHeight]));
    ro.observe(el);
    setAvail([el.clientWidth, el.clientHeight]);
    return () => ro.disconnect();
  }, []);

  const [ghostPx, setGhostPx] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!ghost) return setGhostPx(null);
    const g = readGrid(frame.current, pageId);
    if (!g) return setGhostPx(null);
    const pitch = g.cell + g.gap;
    setGhostPx({ left: g.left + ghost.x * pitch, top: g.top + ghost.y * pitch, width: ghost.w * g.cell + (ghost.w - 1) * g.gap, height: ghost.h * g.cell + (ghost.h - 1) * g.gap });
  }, [ghost, pageId, shown]);

  useEffect(() => {
    if (!controller) return;
    controller.current = {
      cellAt: (cx, cy) => {
        const f = frame.current;
        const g = readGrid(f, latest.current.pageId);
        if (!f || !g) return null;
        const fr = f.getBoundingClientRect();
        if (cx < fr.left || cx > fr.right || cy < fr.top || cy > fr.bottom) return null;
        const sc = fr.width / f.offsetWidth || 1;
        const pitch = g.cell + g.gap;
        const lx = (cx - fr.left) / sc - g.left;
        const ly = (cy - fr.top) / sc - g.top;
        const tol = pitch * 0.5;
        if (lx < -tol || ly < -tol || lx > g.cols * pitch + tol || ly > g.rows * pitch + tol) return null;
        return { x: Math.min(g.cols - 1, Math.max(0, Math.floor(lx / pitch))), y: Math.min(g.rows - 1, Math.max(0, Math.floor(ly / pitch))) };
      },
    };
    return () => {
      controller.current = null;
    };
  }, [controller]);

  const [size, setSize] = useScreenSize();
  const [lw, lh] = [Math.max(size.w, size.h), Math.min(size.w, size.h)];
  const [w, h] = orientation === "portrait" ? [lh, lw] : [lw, lh];
  // Cell size as the deck lays it out at this screen size (read from the same-origin iframe after it settles).
  const [cell, setCell] = useState<number | null>(null);
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => setCell(readGrid(frame.current, pageId)?.cell ?? null), 250);
    return () => clearTimeout(id);
  }, [ready, shown, pageId, w, h]);
  const fullW = w + BEZEL * 2;
  const fullH = h + BEZEL * 2;
  const scale = avail[0] > 0 && avail[1] > 0 ? Math.min(1, avail[0] / fullW, avail[1] / fullH) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-center gap-3">
        <SegmentedControl
          size="sm"
          aria-label={t("Phone orientation")}
          value={orientation}
          onValueChange={(v) => onOrientation(v as Orientation)}
          options={[
            { value: "portrait", label: t("Portrait"), icon: <Iphone className="size-3.5" /> },
            { value: "landscape", label: t("Landscape"), icon: <Tablet className="size-3.5 -rotate-90" /> },
          ]}
        />
        <Select
          size="sm"
          aria-label={t("Screen size")}
          className="w-[250px]"
          value={size.preset}
          onChange={(e) => setSize({ preset: e.target.value, w: size.w, h: size.h })}
          options={[...SCREEN_PRESETS.map((p) => ({ value: p.id, label: `${t(p.label)} · ${p.w}×${p.h}` })), { value: "custom", label: t("Custom…") }]}
        />
        {size.preset === "custom" && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Input size="sm" type="number" min={CUSTOM_MIN} max={CUSTOM_MAX} aria-label={t("Width (px)")} className="w-[72px]" value={size.w} onChange={(e) => setSize({ preset: "custom", w: Number(e.target.value), h: size.h })} />×
            <Input size="sm" type="number" min={CUSTOM_MIN} max={CUSTOM_MAX} aria-label={t("Height (px)")} className="w-[72px]" value={size.h} onChange={(e) => setSize({ preset: "custom", w: size.w, h: Number(e.target.value) })} />
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setReady(false);
            if (frame.current) frame.current.src = DECK_URL;
          }}
          title={t("Reload preview")}
          aria-label={t("Reload preview")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RotateRight className="size-3.5" />
        </button>
      </div>
      <div ref={box} className="relative min-h-0 flex-1">
        {scale > 0 && (
          <div
            className="absolute left-1/2 top-1/2"
            style={{ width: fullW * scale, height: fullH * scale, transform: "translate(-50%, -50%)" }}
          >
            <div
              style={{
                width: fullW,
                height: fullH,
                padding: BEZEL,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
                borderRadius: 54,
              }}
              className="bg-[#050506] shadow-[0_0_0_2px_#2a2a2e,0_0_0_5px_#0c0c0e,0_24px_60px_rgb(0_0_0/0.45)]"
            >
              <div style={{ position: "relative", width: w, height: h }}>
                <iframe
                  ref={frame}
                  title={t("Phone screen preview")}
                  src={DECK_URL}
                  onLoad={post}
                  style={{ width: w, height: h, borderRadius: 42, border: 0, background: "#0b0b0d", display: "block" }}
                />
                {dimLevel ? <div aria-hidden="true" data-testid="dim-overlay" style={{ position: "absolute", inset: 0, borderRadius: 42, pointerEvents: "none", background: `rgba(0,0,0,${dimLevel})` }} /> : null}
                {ghost && ghostPx && (
                  <div
                    aria-hidden="true"
                    data-testid="drop-ghost"
                    style={{
                      position: "absolute",
                      pointerEvents: "none",
                      ...ghostPx,
                      borderRadius: 14,
                      border: `2px ${ghost.bad ? "solid" : "dashed"} ${ghost.bad ? "#ef4444" : "#a78bfa"}`,
                      background: ghost.bad ? "rgba(239,68,68,0.28)" : "rgba(167,139,250,0.16)",
                      boxShadow: ghost.bad ? "0 0 0 3px rgba(239,68,68,0.25)" : "none",
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums" data-testid="preview-readout">{w} × {h}{cell ? ` · ${t("cell {n} px", { n: Math.round(cell) })}` : ""}{scale > 0 && scale < 1 ? ` · ${Math.round(scale * 100)}%` : ""}</span>
        {cell !== null && cell < 64 && (
          <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-2.5 py-0.5 text-amber-600 dark:text-amber-400">
            <Warn className="size-3.5" />
            {t("Tiles are small on this screen: fewer columns or the compact look helps")}
            {onEditGrid && <button type="button" onClick={onEditGrid} className="font-medium underline underline-offset-2 hover:no-underline">{t("Change grid")}</button>}
          </span>
        )}
      </div>
    </div>
  );
}
