/** The renderer data checks. Pure (no Node), so the demo deck's tile page runs the same ones as the agent. */
import { validateCard } from "./card";
import type { Renderer } from "./types";

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})$/;
const clip = (v: unknown, n: number): string => String(v).slice(0, n);
const scalar = (v: unknown): string | number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" ? v.slice(0, 200) : undefined);
const opt = (o: Record<string, unknown>, k: string, v: unknown): void => { if (v !== undefined && v !== null && v !== "") o[k] = v; };
const colorOf = (v: unknown): string | undefined => (typeof v === "string" && COLOR_RE.test(v) ? v : undefined);
const STATES = ["ok", "warn", "error", "off"];

/** Checks and trims `data` for a renderer (the same limits the deck assumes). Returns the clean data, or an error message. */
export function cleanRender(render: Renderer, data: unknown): { data: unknown } | { error: string } {
  if (render === "card") return validateCard(data); // strict: unknown parts and fields are an error, not trimmed
  const d = (data !== null && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  switch (render) {
    case "stat": {
      const value = scalar(d.value);
      if (value === undefined || value === "") return { error: "no value to show" };
      out.value = value;
      opt(out, "unit", d.unit !== undefined ? clip(d.unit, 20) : undefined);
      opt(out, "label", d.label !== undefined ? clip(d.label, 60) : undefined);
      opt(out, "delta", scalar(d.delta));
      opt(out, "color", colorOf(d.color));
      if (Array.isArray(d.points)) { const pts = d.points.filter((n) => typeof n === "number" && Number.isFinite(n)).slice(-60); if (pts.length) out.points = pts; }
      return { data: out };
    }
    case "gauge": {
      const v = Number(d.value);
      if (d.value === undefined || d.value === null || d.value === "" || !Number.isFinite(v)) return { error: "no value to show" };
      out.value = Math.min(100, Math.max(0, v));
      opt(out, "label", d.label !== undefined ? clip(d.label, 60) : undefined);
      opt(out, "color", colorOf(d.color));
      return { data: out };
    }
    case "text": {
      if (d.body === undefined || d.body === null) return { error: "no text to show" };
      out.body = clip(d.body, 2000);
      opt(out, "title", d.title !== undefined ? clip(d.title, 80) : undefined);
      return { data: out };
    }
    case "list": {
      if (!Array.isArray(d.items)) return { error: "no list to show" };
      out.items = d.items.slice(0, 20).map((it: any) => {
        const o: Record<string, unknown> = { title: clip(it?.title ?? "", 100) };
        opt(o, "subtitle", it?.subtitle !== undefined ? clip(it.subtitle, 100) : undefined);
        opt(o, "value", scalar(it?.value));
        opt(o, "icon", it?.icon !== undefined ? clip(it.icon, 40) : undefined);
        return o;
      });
      return { data: out };
    }
    case "chart": {
      if (!Array.isArray(d.points)) return { error: "no points to show" };
      const pts = d.points.map(Number).filter((n) => Number.isFinite(n)).slice(-120);
      if (!pts.length) return { error: "no points to show" };
      out.points = pts;
      opt(out, "label", d.label !== undefined ? clip(d.label, 60) : undefined);
      opt(out, "unit", d.unit !== undefined ? clip(d.unit, 20) : undefined);
      return { data: out };
    }
    case "image": {
      const url = typeof d.url === "string" ? d.url : "";
      const ok = /^https:\/\//i.test(url) || (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(url) && url.length <= 500_000);
      if (!ok) return { error: "the image must be an https address or a data:image" };
      out.url = url;
      if (d.fit === "contain" || d.fit === "cover") out.fit = d.fit;
      return { data: out };
    }
    case "status": {
      if (!STATES.includes(d.state as string)) return { error: "state must be ok, warn, error or off" };
      out.state = d.state;
      out.label = clip(d.label ?? "", 80);
      // optional richer fields (all may be absent: {state, label} alone still renders)
      opt(out, "title", d.title !== undefined ? clip(d.title, 40) : undefined);
      if (typeof d.value === "number" && Number.isFinite(d.value)) out.value = clip(d.value, 12);
      else if (typeof d.value === "string") opt(out, "value", clip(d.value, 12));
      opt(out, "unit", d.unit !== undefined ? clip(d.unit, 8) : undefined);
      opt(out, "detail", d.detail !== undefined ? clip(d.detail, 60) : undefined);
      if (Array.isArray(d.points)) { const pts = d.points.filter((n) => typeof n === "number" && Number.isFinite(n)).slice(-60); if (pts.length) out.points = pts; }
      return { data: out };
    }
  }
}
