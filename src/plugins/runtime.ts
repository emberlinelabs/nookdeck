/**
 * Keeps the data of every plugin tile on the layout fresh and tells the phones: one timer per tile at its source's `every`, only while
 * a phone is connected. Also runs plugin actions. A plugin that is missing, disabled or not granted gives its tiles a neutral error.
 */
import type { Layout, MacroStep, PluginRef } from "../config";
import { platform } from "../platform";
import { covers } from "./manifest";
import { actionSteps, evaluateWidget, resolveSettings, runHttpAction, widgetEvery, type SourceDeps } from "./sources";
import type { PluginStore } from "./store";
import { ERR_DISABLED, ERR_MISSING, ERR_NOT_GRANTED, type TileItem, type TileItems } from "./types";

export interface RuntimeDeps extends SourceDeps {
  /** Called with the tiles whose item changed (a partial map; the deck merges by tile id). */
  onItems: (items: TileItems) => void;
  /** Multiplies every refresh interval (tests use a small number). */
  scale?: number;
}

interface Tile { ref: PluginRef; timer?: ReturnType<typeof setTimeout>; gen: number }

const same = (a: TileItem | undefined, b: TileItem): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

export class PluginRuntime {
  private tiles = new Map<string, Tile>();
  private items: TileItems = {};
  private active = false;
  private gen = 0;
  private stopped = false;

  constructor(private store: PluginStore, private deps: RuntimeDeps) {
    store.onChange(() => this.rebuild());
  }

  /** The plugin tiles of the layout in force. */
  setLayout(layout: Layout): void {
    const next = new Map<string, PluginRef>();
    for (const p of layout.pages) for (const it of p.items) if (it.kind === "widget" && it.widget === "plugin" && it.plugin) next.set(it.id, it.plugin);
    for (const [id, t] of this.tiles) if (!next.has(id)) { clearTimeout(t.timer); this.tiles.delete(id); delete this.items[id]; }
    for (const [id, ref] of next) {
      const old = this.tiles.get(id);
      if (old && JSON.stringify(old.ref) === JSON.stringify(ref)) continue;
      if (old) clearTimeout(old.timer);
      this.tiles.set(id, { ref, gen: ++this.gen });
      delete this.items[id];
    }
    this.rebuild();
  }

  /** Polling runs while at least one phone is connected. */
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.rebuild();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.tiles.values()) clearTimeout(t.timer);
  }

  /** Everything known now (sent in full to a phone that just connected). */
  snapshot(): TileItems { return { ...this.items }; }

  /** Re-checks every tile against the store (after an install, grant, enable, settings change) and refreshes the ones that can run. */
  rebuild(): void {
    if (this.stopped) return;
    const changed: TileItems = {};
    for (const [id, tile] of this.tiles) {
      clearTimeout(tile.timer);
      tile.gen = ++this.gen;
      const status = this.store.runnable(tile.ref.id);
      if (status !== "ok") {
        this.put(id, { error: status === "missing" ? ERR_MISSING : status === "disabled" ? ERR_DISABLED : ERR_NOT_GRANTED }, changed);
        continue;
      }
      const widget = this.store.entry(tile.ref.id)!.manifest.widgets.find((w) => w.id === tile.ref.widget);
      if (!widget) { this.put(id, { error: "plugin widget missing" }, changed); continue; }
      if (this.active) void this.refresh(id, tile.gen);
    }
    if (Object.keys(changed).length) this.deps.onItems(changed);
  }

  private put(id: string, item: TileItem, out: TileItems): void {
    if (same(this.items[id], item)) return;
    this.items[id] = item;
    out[id] = item;
  }

  private async refresh(id: string, gen: number): Promise<void> {
    const tile = this.tiles.get(id);
    if (!tile || tile.gen !== gen || this.stopped) return;
    const e = this.store.entry(tile.ref.id);
    const widget = e?.manifest.widgets.find((w) => w.id === tile.ref.widget);
    if (!e || !widget) return;
    const settings = resolveSettings([...e.manifest.settings, ...widget.settings], [e.state.settings, tile.ref.settings]);
    const item = await evaluateWidget(widget, settings, e.state.granted ?? { network: [] }, this.deps);
    if (tile.gen !== gen || this.stopped) return; // rebuilt or removed while the request ran
    const changed: TileItems = {};
    this.put(id, item, changed);
    if (Object.keys(changed).length) this.deps.onItems(changed);
    if (this.active) tile.timer = setTimeout(() => void this.refresh(id, gen), widgetEvery(widget) * 1000 * (this.deps.scale ?? 1));
    (tile.timer as any)?.unref?.();
  }

  /**
   * Runs a plugin button. Macro steps go through `runSteps` (the server's macro runner); an http action runs here.
   * Throws an Error with a message for the owner when the plugin cannot run.
   */
  async runAction(a: { plugin: string; action: string; settings?: Record<string, string | number | boolean> }, runSteps: (steps: MacroStep[]) => Promise<void>): Promise<void> {
    const status = this.store.runnable(a.plugin);
    if (status !== "ok") throw new Error(status === "missing" ? ERR_MISSING : status === "disabled" ? ERR_DISABLED : ERR_NOT_GRANTED);
    const e = this.store.entry(a.plugin)!;
    const def = e.manifest.actions.find((x) => x.id === a.action);
    if (!def) throw new Error("plugin action missing");
    const settings = resolveSettings([...e.manifest.settings, ...def.settings], [e.state.settings, a.settings]);
    const granted = e.state.granted ?? { network: [] };
    if (!covers(granted, e.manifest.permissions)) throw new Error(ERR_NOT_GRANTED);
    if ("macro" in def.run) return runSteps(actionSteps(def, settings));
    return runHttpAction(def, settings, granted, this.deps);
  }
}

/** Runs a command line with the OS shell (sh -c, cmd /c), killing it after `timeoutMs`. */
export async function realShell(command: string, timeoutMs: number): Promise<{ code: number; stdout: string }> {
  const { buildCommand } = await import("../actions");
  const p = Bun.spawn(buildCommand({ type: "shell", command }, platform.id), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, stdout };
  } finally { clearTimeout(timer); }
}
