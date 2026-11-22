import type { Layout, PluginInfo } from "@/types";
import { t } from "@/lib/i18n";
import type { PluginPermissions } from "@/types";

export type Risk = "low" | "medium" | "high";
export interface PermChip { key: string; label: string; risk: Risk; /** One plain sentence for the details drawer. */ plain: string }

/** What a plugin asks for as chips, riskiest first. Hosts and storage are low risk, the keyboard medium, the shell high. */
export function permChips(p: PluginPermissions): PermChip[] {
  const out: PermChip[] = [];
  if (p.shell) out.push({ key: "shell", label: t("Runs commands"), risk: "high", plain: t("Can run any command on this computer, as you. Only allow it if you trust the author.") });
  if (p.keyboard) out.push({ key: "keyboard", label: t("Presses keys"), risk: "medium", plain: t("Can press keys and type text on this computer, as if you did.") });
  for (const h of p.network) out.push({ key: `net-${h}`, label: h, risk: "low", plain: t("Can connect to {host} and nowhere else on the internet.", { host: h }) });
  if (p.storage) out.push({ key: "storage", label: t("Saves data"), risk: "low", plain: t("Can keep its own small file of saved data on this computer.") });
  return out;
}

export const riskTone = (r: Risk): "danger" | "warning" | "neutral" => (r === "high" ? "danger" : r === "medium" ? "warning" : "neutral");
export const hasPerms = (p: PluginPermissions): boolean => p.network.length > 0 || p.shell || p.keyboard || p.storage;

/** What a tile renderer is called to people. A raw renderer id (stat, custom:quota) is never shown. */
export function rendererLabel(r: string, short = false): string {
  switch (r) {
    case "stat": return t("Number");
    case "gauge": return t("Gauge");
    case "text": return t("Text");
    case "list": return t("List");
    case "chart": return t("Chart");
    case "image": return t("Image");
    case "status": return t("Status light");
    case "custom:quota": return short ? t("AI usage") : t("AI usage tile");
    case "custom:weather": return short ? t("Weather") : t("Weather tile");
    default: return t("Custom tile");
  }
}

/**
 * What the phone preview shows for every plugin tile of a layout, by tile id: the installed plugin's own sample data for the tile's
 * widget, or a plain state ("plugin missing", "plugin disabled", "no preview|Name · Kind"). Nothing is invented.
 */
export function previewPluginData(layout: Layout, plugins: PluginInfo[]): Record<string, { render: string; data: unknown; style?: string } | { error: string }> {
  const out: Record<string, { render: string; data: unknown; style?: string } | { error: string }> = {};
  for (const pg of layout.pages) for (const it of pg.items) {
    if (it.kind !== "widget" || it.widget !== "plugin" || !it.plugin) continue;
    const p = plugins.find((x) => x.id === it.plugin!.id);
    if (!p) { out[it.id] = { error: "plugin missing" }; continue; }
    if (!p.enabled) { out[it.id] = { error: "plugin disabled" }; continue; }
    if (p.needsApproval) { out[it.id] = { error: "plugin not granted" }; continue; }
    const w = p.widgets.find((x) => x.id === it.plugin!.widget);
    if (!w) { out[it.id] = { error: "plugin widget missing" }; continue; }
    out[it.id] = w.preview !== undefined && w.preview !== null ? { render: w.render, data: w.preview, ...(w.style ? { style: w.style } : {}) } : { error: `no preview|${p.name} · ${rendererLabel(w.render)}` };
  }
  return out;
}
