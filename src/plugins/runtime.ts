/**
 * Keeps the data of every plugin tile on the layout fresh and tells the phones: one timer per tile at its source's `every`, only while
 * a phone is connected. Also runs plugin actions. A plugin that is missing, disabled or not granted gives its tiles a neutral error.
 */
import { iconWarning, unknownCardIcons } from "./card-icons";
import type { Layout, MacroStep, PluginRef } from "../config";
import { platform } from "../platform";
import { covers } from "./manifest";
import { cleanRender } from "./sources";
import type { PluginHosts } from "./hosts";
import { layoutPluginTiles, layoutTileSizes, type CoreHost } from "./core";
import type { TileSize } from "./api";
import { actionSteps, coerce, evaluateWidget, resolveSettings, runHttpAction, widgetEvery, type SourceDeps } from "./sources";
import type { PluginStore } from "./store";
import { ERR_DISABLED, ERR_MISSING, ERR_NOT_GRANTED, type Renderer, type TileItem, type TileItems } from "./types";

export interface RuntimeDeps extends SourceDeps {
  /** Called with the tiles whose item changed (a partial map; the deck merges by tile id). */
  onItems: (items: TileItems) => void;
  /** Multiplies every refresh interval (tests use a small number). */
  scale?: number;
  /** Runs the core plugins (core.weather, core.quota); their tiles, legacy weather/quota widgets included, are served by it. */
  core?: CoreHost;
  /** Runs the code plugins (their own processes); a widget with an `agent` source is served by it. */
  hosts?: PluginHosts;
  /** A line for a plugin's own log (refused card buttons). */
  log?: (plugin: string, line: string) => void;
}

interface Tile { ref: PluginRef; size: TileSize; timer?: ReturnType<typeof setTimeout>; gen: number; /** the buttons of the card shown now and of the one before it (a tap may be on its way while the card changes) */ buttons?: string[][] }

type Args = Record<string, string | number | boolean>;
const buttonKey = (action: string, args: Args | undefined): string => JSON.stringify([action, Object.keys(args ?? {}).sort().map((k) => [k, args![k]])]);
function cardButtons(node: any, out: string[] = []): string[] {
  if (node?.t === "button") out.push(buttonKey(node.action, node.args));
  if (Array.isArray(node?.children)) for (const c of node.children) cardButtons(c, out);
  return out;
}

const same = (a: TileItem | undefined, b: TileItem): boolean => !!a && JSON.stringify(a) === JSON.stringify(b);

/** How long after a card tap the plugin's tiles are asked again. */
export const CARD_REFRESH_MS = 250;

export class PluginRuntime {
  private tiles = new Map<string, Tile>();
  private warned = new Set<string>(); // "plugin icon" already reported
  private soon = new Map<string, ReturnType<typeof setTimeout>>(); // plugin id -> the refresh its card taps are waiting for
  private items: TileItems = {};
  private active = false;
  private gen = 0;
  private stopped = false;

  constructor(private store: PluginStore, private deps: RuntimeDeps) {
    store.onChange(() => this.rebuild());
    deps.hosts?.onPush((plugin, widget, u, key) => this.pushCode(plugin, widget, u.render, u.data, key));
    deps.hosts?.setTiles?.((plugin, widget) => this.tilesOf(plugin, widget).map(([key, t]) => ({ key, size: { ...t.size } })));
    // a code plugin's process (re)started: its tiles ask it again at once
    deps.hosts?.onRegistered((plugin) => { if (!this.active) return; for (const [id, t] of this.tiles) if (t.ref.id === plugin) { clearTimeout(t.timer); t.gen = ++this.gen; void this.refresh(id, t.gen); } });
    deps.core?.onPush((plugin, widget, u) => {
      if (typeof u !== "function") return this.pushCore(plugin, widget, u.data);
      for (const [id, t] of this.tilesOf(plugin, widget)) {
        const size = { ...t.size };
        void (async () => u(size))().then((made) => this.pushCore(plugin, widget, made.data, id), (err) => this.deps.log?.(plugin, `[agent] widgets.push("${widget}") failed: ${String(err?.message ?? err).slice(0, 200)}`));
      }
    });
  }

  private tilesOf(plugin: string, widget: string): Array<[string, Tile]> {
    return [...this.tiles].filter(([, t]) => t.ref.id === plugin && t.ref.widget === widget);
  }

  /** What a core plugin pushed: for every tile of the widget, or for the one named. */
  private pushCore(plugin: string, widget: string, data: unknown, only?: string): void {
    const changed: TileItems = {};
    const def = this.store.entry(plugin)?.manifest.widgets.find((w) => w.id === widget);
    if (!def || this.store.runnable(plugin) !== "ok") return;
    for (const [id] of this.tilesOf(plugin, widget)) if (only === undefined || id === only) this.put(id, { render: def.render as Renderer, data }, changed);
    if (Object.keys(changed).length) this.deps.onItems(changed);
  }

  /** An update a code plugin pushed (ctx.widgets.push): shown on every tile of that widget (or, from a push with a function, on one), through the same checks as polled data. */
  private pushCode(plugin: string, widgetId: string, render: unknown, data: unknown, only?: string): void {
    const changed: TileItems = {};
    const def = this.store.entry(plugin)?.manifest.widgets.find((w) => w.id === widgetId);
    if (!def || this.store.runnable(plugin) !== "ok") return;
    const item = codeItem(def.render, render, data);
    for (const [id] of this.tilesOf(plugin, widgetId)) if (only === undefined || id === only) this.put(id, item, changed);
    if (Object.keys(changed).length) this.deps.onItems(changed);
  }

  /** The plugin tiles of the layout in force. */
  setLayout(layout: Layout): void {
    const next = layoutPluginTiles(layout); // plugin tiles, plus legacy weather/quota widgets mapped to their core plugin (D7)
    for (const [id, t] of this.tiles) if (!next.has(id)) { clearTimeout(t.timer); this.tiles.delete(id); delete this.items[id]; }
    const sizes = layoutTileSizes(layout);
    for (const [id, ref] of next) {
      const old = this.tiles.get(id);
      const size = sizes.get(id) ?? { w: 1, h: 1 };
      // a tile that only changed size keeps what it shows; rebuild() below asks again with the new size
      if (old && JSON.stringify(old.ref) === JSON.stringify(ref)) { old.size = size; continue; }
      if (old) clearTimeout(old.timer);
      this.tiles.set(id, { ref, size, gen: ++this.gen });
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
    for (const t of this.soon.values()) clearTimeout(t);
    this.soon.clear();
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

  private put(id: string, item0: TileItem, out: TileItems): void {
    let item = item0;
    if ("render" in item) { // the widget's suggested style travels with the data (the tile's own choice is applied by the deck)
      const ref = this.tiles.get(id)?.ref;
      const st = ref ? this.store.entry(ref.id)?.manifest.widgets.find((w) => w.id === ref.widget)?.style : undefined;
      if (st) item = { ...item, style: st };
    }
    if (same(this.items[id], item)) return;
    const tile = this.tiles.get(id);
    if (tile && "render" in item && item.render === "card") this.warnIcons(tile.ref.id, (item.data as any)?.root);
    if (tile) tile.buttons = "render" in item && item.render === "card" ? [cardButtons((item.data as any)?.root), tile.buttons?.[0] ?? []] : undefined;
    this.items[id] = item;
    out[id] = item;
  }

  /** Says once in the plugin's log that a card names an icon the phone does not have. */
  private warnIcons(plugin: string, root: any): void {
    for (const name of unknownCardIcons(root)) {
      const key = `${plugin} ${name}`;
      if (this.warned.has(key) || this.warned.size >= 500) continue;
      this.warned.add(key);
      this.deps.log?.(plugin, `[agent] ${iconWarning(name)}`);
    }
  }

  private async refresh(id: string, gen: number): Promise<void> {
    const tile = this.tiles.get(id);
    if (!tile || tile.gen !== gen || this.stopped) return;
    const e = this.store.entry(tile.ref.id);
    const widget = e?.manifest.widgets.find((w) => w.id === tile.ref.widget);
    if (!e || !widget) return;
    const settings = resolveSettings([...e.manifest.settings, ...widget.settings], [e.state.settings, tile.ref.settings]);
    const core = this.deps.core?.has(tile.ref.id) ? this.deps.core : undefined;
    let item: TileItem;
    if (core) {
      try { const u = await core.get(tile.ref.id, tile.ref.widget, settings, tile.size); item = { render: u.render, data: u.data }; }
      catch (err: any) { item = { error: String(err?.message ?? err).slice(0, 120) }; }
    } else if ("agent" in widget.source) {
      const hosts = this.deps.hosts;
      if (!hosts) item = { error: "plugin host unavailable" };
      else {
        try { const u = await hosts.widget(tile.ref.id, tile.ref.widget, settings, { ...tile.size }); item = codeItem(widget.render, u?.render, u?.data); }
        catch (err: any) { item = { error: String(err?.message ?? err).slice(0, 120) }; }
      }
    } else item = await evaluateWidget(widget, settings, e.state.granted ?? { network: [] }, this.deps);
    if (tile.gen !== gen || this.stopped) return; // rebuilt or removed while the request ran
    const changed: TileItems = {};
    this.put(id, item, changed);
    if (Object.keys(changed).length) this.deps.onItems(changed);
    if (this.active) tile.timer = setTimeout(() => void this.refresh(id, gen), (core ? core.every(tile.ref.id, tile.ref.widget) : "agent" in widget.source && this.deps.hosts ? this.deps.hosts.every(tile.ref.id, tile.ref.widget) : widgetEvery(widget)) * 1000 * (this.deps.scale ?? 1));
    (tile.timer as any)?.unref?.();
  }

  /**
   * A tap on a button of a card tile (D2). Only the plugin that owns the tile, only an action its manifest declares, only a
   * button the agent itself sent to that tile (so a phone cannot make up its own arguments), and `args` only as that action's
   * own settings: unknown keys are dropped, a value that does not fit its field is refused. Then it runs like any plugin button,
   * and the plugin's tiles are refreshed at once so the card shows the new state.
   */
  async cardAction(tileId: unknown, action: unknown, args: unknown, runSteps: (steps: MacroStep[]) => Promise<void>): Promise<void> {
    const tile = typeof tileId === "string" ? this.tiles.get(tileId) : undefined;
    if (!tile || typeof action !== "string" || (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))) throw new Error("this button is not on the layout");
    const plugin = tile.ref.id;
    const refuse = (message: string, why: string): never => {
      this.deps.log?.(plugin, `[agent] refused a card button on tile "${String(tileId).slice(0, 40)}": ${why}`);
      throw new Error(message);
    };
    const e = this.store.entry(plugin);
    if (!e) throw new Error(ERR_MISSING);
    const def = e.manifest.actions.find((x) => x.id === action);
    if (!def) return refuse("this plugin has no such action", `the manifest declares no action "${action.slice(0, 48)}"`);
    const sent = (args ?? {}) as Args;
    if (!tile.buttons?.some((list) => list.includes(buttonKey(action, sent)))) return refuse("this button is no longer on the card", `no button of the card runs "${action}" with these args`);
    const settings: Args = {};
    for (const f of def.settings) {
      if (!Object.prototype.hasOwnProperty.call(sent, f.key) || f.type === "secret") continue; // a secret only comes from the plugin's settings
      const v = coerce(f, sent[f.key]);
      if (v === undefined) return refuse(`invalid value for "${f.label}"`, `args.${f.key} of "${action}" is not a valid ${f.type}`);
      settings[f.key] = v;
    }
    await this.runAction({ plugin, action, settings }, runSteps);
    this.refreshSoon(plugin);
  }

  /**
   * Taps that come close together share one refresh, CARD_REFRESH_MS after the first of them. A later tap does not push it
   * back, so someone who keeps tapping still sees the card change.
   */
  private refreshSoon(plugin: string): void {
    if (this.stopped || this.soon.has(plugin)) return;
    const timer = setTimeout(() => { this.soon.delete(plugin); this.refreshPlugin(plugin); }, CARD_REFRESH_MS);
    (timer as { unref?: () => void }).unref?.();
    this.soon.set(plugin, timer);
  }

  /** Asks every tile of a plugin for fresh data. */
  private refreshPlugin(plugin: string): void {
    if (!this.active || this.stopped) return;
    for (const [id, t] of this.tiles) {
      if (t.ref.id !== plugin || this.store.runnable(plugin) !== "ok") continue;
      clearTimeout(t.timer);
      t.gen = ++this.gen;
      void this.refresh(id, t.gen);
    }
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
    if ("agent" in def.run) {
      if (!this.deps.hosts) throw new Error("plugin host unavailable");
      return this.deps.hosts.action(a.plugin, a.action, settings);
    }
    if ("macro" in def.run) return runSteps(actionSteps(def, settings));
    return runHttpAction(def, settings, granted, this.deps);
  }
}

/** What a code plugin returned for a tile: its renderer is the manifest's, and the data goes through the same clean-up as no-code data. */
function codeItem(render: string, gotRender: unknown, data: unknown): TileItem {
  if (gotRender !== undefined && gotRender !== render) return { error: "the plugin used another renderer than its manifest declares" };
  const cleaned = cleanRender(render as Renderer, data);
  return "error" in cleaned ? { error: cleaned.error } : { render: render as Renderer, data: cleaned.data };
}

/** Runs a command line with the OS shell (sh -c, cmd /c), killing it after `timeoutMs`. */
export async function realShell(command: string, timeoutMs: number, env?: Record<string, string>): Promise<{ code: number; stdout: string }> {
  const { buildCommand } = await import("../actions");
  const p = Bun.spawn(buildCommand({ type: "shell", command }, platform.id), { stdin: "ignore", stdout: "pipe", stderr: "ignore", ...(env ? { env: { ...process.env, ...env } } : {}) });
  const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return { code, stdout };
  } finally { clearTimeout(timer); }
}
