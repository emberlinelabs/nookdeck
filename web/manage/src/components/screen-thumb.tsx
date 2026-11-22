import { useEffect, useMemo, useRef, useState } from "react";
import { DECK_ORIGIN, DECK_URL } from "@/components/phone-preview";
import { api, PLUGINS_CHANGED } from "@/api";
import { previewPluginData } from "@/lib/plugin-ui";
import { t } from "@/lib/i18n";
import type { Layout, PluginInfo } from "@/types";

const W = 844, H = 390;

/** True once the element has scrolled into view (and stays true), so a page of cards mounts only the ones the user sees. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

let pluginCache: PluginInfo[] | null = null;
/** The installed plugins' sample data (what the preview shows plugin tiles with), fetched once for all thumbnails. */
function usePlugins(): PluginInfo[] {
  const [p, setP] = useState<PluginInfo[]>(pluginCache ?? []);
  useEffect(() => {
    let live = true;
    const load = () => api.getPlugins().then((x) => { pluginCache = x; if (live) setP(x); }, () => undefined);
    if (!pluginCache) void load();
    window.addEventListener(PLUGINS_CHANGED, load);
    return () => { live = false; window.removeEventListener(PLUGINS_CHANGED, load); };
  }, []);
  return p;
}

/**
 * A read-only picture of the user's own screen drawn by the real deck in a theme: a small deck frame, mounted only when
 * visible, no interaction and no polling. `layout` already carries the theme to show.
 */
export function ScreenThumb({ layout, pageId, label, className }: { layout: Layout; pageId: string; label: string; className?: string }) {
  const [box, seen] = useSeen<HTMLDivElement>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [width, setWidth] = useState(0);
  const plugins = usePlugins();
  const pluginData = useMemo(() => previewPluginData(layout, plugins), [layout, plugins]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [box]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => { if (e.origin === DECK_ORIGIN && e.source === frame.current?.contentWindow && (e.data as { type?: string } | null)?.type === "pd-ready") setReady(true); };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ type: "pd-preview", layout, pageId, selectedId: null, pluginData }, DECK_ORIGIN);
  }, [ready, layout, pageId, pluginData]);
  const scale = width ? width / W : 0;
  return (
    <div ref={box} role="img" aria-label={label} className={className} style={{ position: "relative", width: "100%", height: scale ? H * scale : undefined, aspectRatio: scale ? undefined : `${W} / ${H}`, overflow: "hidden", borderRadius: 10, background: "#0b0b0d" }}>
      {seen && scale > 0 && (
        <iframe ref={frame} title={t("Phone screen preview")} src={DECK_URL} tabIndex={-1} aria-hidden="true" loading="lazy"
          style={{ position: "absolute", left: 0, top: 0, width: W, height: H, border: 0, transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none" }} />
      )}
    </div>
  );
}
