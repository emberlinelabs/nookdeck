import { useCallback, useEffect, useRef, useState } from "react";
import { parseSize } from "@/lib/plugins";
import { rendererLabel } from "@/lib/plugin-ui";
import type { Layout, TileDef, Theme } from "@/types";

const DECK_URL = `${(import.meta.env.VITE_AGENT as string | undefined) ?? ""}/?preview=1&np=clean`;
const DECK_ORIGIN = new URL(DECK_URL, location.href).origin;
/** The deck runs at a real phone cell size and is scaled down with CSS, so text and spacing look like the phone. */
const CELL = 112;
const PAD = 16;
/** The deck draws its own status bar above the grid; the preview pushes it out of view so only the tile shows. */
const BAR = 44;


/**
 * How one tile of a plugin looks on the phone: the real deck (the same iframe the Screens preview uses) with a one-tile
 * layout, the current theme and the tile's sample data. Without sample data it shows the registry screenshot, and without
 * that a neutral placeholder with the renderer's name. The deck mounts only once the tile scrolls into view.
 */
export function TilePreview({ pluginId, widget, theme, screenshot, className }: { pluginId: string; widget: TileDef; theme?: Theme; screenshot?: string; className?: string }) {
  const [w, h] = parseSize(widget.sizes?.[0] ?? "2x1") ?? [2, 1];
  const IW = w * CELL + PAD * 2;
  const IH = h * CELL + PAD * 2;
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [seen, setSeen] = useState(false);
  const [scale, setScale] = useState(0.3);
  const has = widget.preview !== undefined && widget.preview !== null;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / IW);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    const io = has ? new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io?.disconnect(); } }) : null;
    io?.observe(el);
    return () => { ro.disconnect(); io?.disconnect(); };
  }, [IW, has]);

  const post = useCallback(() => {
    const layout: Layout = {
      version: 1, theme: { ...(theme ?? {}), orientation: IH + BAR > IW ? "portrait" : "landscape" } as Theme,
      pages: [{ id: "p", name: "", columns: w, rows: h, items: [{ id: "t", kind: "widget", widget: "plugin", x: 0, y: 0, ...(w > 1 || h > 1 ? { w, h } : {}), plugin: { id: pluginId, widget: widget.id } } as never] }],
    };
    frame.current?.contentWindow?.postMessage({ type: "pd-preview", layout, pageId: "p", selectedId: null, pluginData: { t: { render: widget.render, data: widget.preview } } }, DECK_ORIGIN);
  }, [pluginId, widget, theme, w, h, IW, IH]);

  useEffect(() => {
    const on = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow && e.data?.type === "pd-ready") post(); };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [post]);
  useEffect(() => { if (seen) post(); }, [seen, post]);

  return (
    <div ref={box} className={className ?? "w-full"} style={{ aspectRatio: `${IW} / ${IH}` }}>
      {has ? (
        <div className="relative size-full overflow-hidden rounded-xl border bg-black" aria-hidden>
          {seen && <iframe ref={frame} src={DECK_URL} title="" tabIndex={-1} className="pointer-events-none absolute left-0 top-0 border-0"
            style={{ width: IW, height: IH + BAR, top: -BAR * scale, transformOrigin: "0 0", transform: `scale(${scale})` }} />}
        </div>
      ) : screenshot ? (
        <img src={screenshot} alt="" loading="lazy" className="size-full rounded-xl border object-cover" />
      ) : (
        <div className="grid size-full place-items-center rounded-xl border bg-muted/40 px-2 text-center text-[11px] text-muted-foreground" aria-hidden>{rendererLabel(widget.render)}</div>
      )}
    </div>
  );
}
