import type { HassLike, HassState, HassWeather } from "../automation-types";
import { HassConfigStore, hassWsUrl, normalizeHassUrl } from "./config";
import { tempUnitOf, type TempUnit } from "../temperature";
import { toPhoneEntity, type PhoneEntity, type PhoneRelated } from "./entities";
import { t } from "../i18n";
import type { HassOAuth } from "./oauth";

export interface HassStatus { url: string | null; hasToken: boolean; connected: boolean; error?: string; /** the last underlying error, short (for support) */ detail?: string; version?: string }

interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((e: any) => void) | null;
  onmessage: ((e: { data: any }) => void) | null;
  onclose: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
}

export interface HassClientOptions {
  store: HassConfigStore;
  /** Sign in with Home Assistant: supplies (and refreshes) the access token. */
  oauth?: HassOAuth;
  createSocket?: (url: string) => SocketLike;
  /** Reconnect delays in ms; the last one repeats. */
  backoffMs?: number[];
  pingMs?: number;
  requestTimeoutMs?: number;
  /** Waiting for the TCP/TLS connection (default 8 s), for HA's auth_required (5 s) and for auth_ok (8 s). */
  connectMs?: number;
  greetMs?: number;
  authMs?: number;
  /** Name lookup used to tell a DNS failure from an unreachable host. */
  resolveHost?: (host: string) => Promise<unknown>;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Home Assistant WebSocket API client with reconnect, keep-alive and a live view of the entities the layout uses. */
export class HassClient implements HassLike {
  private ws: SocketLike | null = null;
  private ready = false;
  private err: string | undefined;
  private detail: string | undefined;
  private phase: "idle" | "connecting" | "greeting" | "auth" | "ready" = "idle";
  private phaseTimer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;
  private classifying = false;
  private version: string | undefined;
  private haName: string | undefined;
  private haUser: string | undefined;
  /** The credential of this attempt came from OAuth (a rejected one is refreshed once before giving up). */
  private usedOAuth = false;
  private oauthRetried = false;
  /** HA's configured temperature unit (get_config), for climate/weather entities that carry none. */
  private sysUnit: string | undefined;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private states = new Map<string, HassState>();
  private wanted: string[] = [];
  /** A weather.* entity found for weather tiles that picked none ("auto"); subscribed on top of `wanted`, reset per connection. */
  /** entity -> device, and device -> its select entities, from the entity registry (one fetch per connection). */
  private deviceOf = new Map<string, string>();
  private selectsOf = new Map<string, string[]>();
  private subIds = "";
  private autoWeather: { id: string | null } | undefined;
  private subId: number | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongAt = 0;
  private stopped = true;
  private stateListeners = new Set<(id: string, s: HassState | undefined) => void>();
  private entityListeners = new Set<(changed: Record<string, PhoneEntity | null>) => void>();
  private statusListeners = new Set<(s: HassStatus) => void>();
  readonly store: HassConfigStore;

  constructor(private o: HassClientOptions) { this.store = o.store; }
  get oauth(): HassOAuth | undefined { return this.o.oauth; }

  // ---- state ----
  connected() { return this.ready; }
  getState(id: string) { return this.states.get(id); }
  /** HA's temperature unit, once known. */
  systemTempUnit(): TempUnit | undefined { return tempUnitOf(this.sysUnit); }
  async status(): Promise<HassStatus> {
    const mode = await this.mode();
    return { url: (await this.store.url()) ?? null, hasToken: mode !== null, connected: this.ready, ...(this.err ? { error: this.err } : {}), ...(this.detail && this.err ? { detail: this.detail } : {}), ...(this.version ? { version: this.version } : {}) };
  }
  /** "oauth" when signed in with Home Assistant, "token" for a pasted long-lived token, null for neither. */
  async mode(): Promise<"oauth" | "token" | null> {
    if (this.o.oauth && (await this.store.hasRefreshToken())) return "oauth";
    return (await this.store.hasToken()) ? "token" : null;
  }
  /** GET /api/hass/status. */
  async oauthStatus() {
    const mode = await this.mode();
    return { connected: this.ready, mode, haVersion: this.version ?? null, haName: this.haName ?? null, user: this.haUser ?? null };
  }
  /** The access token to authenticate with: OAuth when signed in (refreshed when due), else the pasted token. */
  private async credential(): Promise<string | null> {
    if (this.o.oauth && (await this.store.hasRefreshToken())) {
      this.usedOAuth = true;
      try { return await this.o.oauth.accessToken(); }
      catch (e) { this.err = t("could not refresh the Home Assistant sign-in"); this.detail = shortMsg(e); return null; }
    }
    this.usedOAuth = false;
    return (await this.store.token()) ?? null;
  }
  /** Select entities on the same device as a light (scene pickers), with their options and current option. */
  related(entityId: string): PhoneRelated[] {
    if (!entityId.startsWith("light.")) return [];
    const dev = this.deviceOf.get(entityId);
    if (!dev) return [];
    const out: PhoneRelated[] = [];
    for (const sid of this.selectsOf.get(dev) ?? []) {
      const s = this.states.get(sid);
      if (!s) continue;
      const options = Array.isArray(s.attributes?.options) ? s.attributes!.options.map(String) : [];
      out.push({ id: sid, name: String(s.attributes?.friendly_name ?? sid), options, current: s.state === "unavailable" || s.state === "unknown" ? null : s.state });
    }
    return out;
  }
  private phone(id: string, s: HassState): PhoneEntity {
    const e = toPhoneEntity(id, s.state, s.attributes, this.sysUnit);
    const rel = this.related(id);
    return rel.length ? { ...e, related: rel } : e;
  }
  private lightsOf(selectId: string): string[] {
    const dev = this.deviceOf.get(selectId);
    return dev ? this.wanted.filter((w) => w.startsWith("light.") && this.deviceOf.get(w) === dev) : [];
  }
  private async loadRegistry() {
    const gen = this.gen;
    const reg = await this.request<any[]>({ type: "config/entity_registry/list" }).catch(() => null);
    if (!reg || gen !== this.gen) return;
    this.deviceOf.clear(); this.selectsOf.clear();
    for (const r of reg) {
      if (!r?.device_id || !r.entity_id) continue;
      this.deviceOf.set(String(r.entity_id), String(r.device_id));
      if (String(r.entity_id).startsWith("select.")) this.selectsOf.set(String(r.device_id), [...(this.selectsOf.get(String(r.device_id)) ?? []), String(r.entity_id)]);
    }
    if (this.subscribed().join(",") !== this.subIds) this.subscribe(); // only when the registry added selects to follow
  }

  /** Everything the phone should know right now. */
  snapshot(): Record<string, PhoneEntity> {
    const out: Record<string, PhoneEntity> = {};
    for (const id of this.wanted) { const s = this.states.get(id); if (s) out[id] = this.phone(id, s); }
    return out;
  }
  onState(cb: (id: string, s: HassState | undefined) => void) { this.stateListeners.add(cb); return () => void this.stateListeners.delete(cb); }
  onEntities(cb: (changed: Record<string, PhoneEntity | null>) => void) { this.entityListeners.add(cb); return () => void this.entityListeners.delete(cb); }
  onStatus(cb: (s: HassStatus) => void) { this.statusListeners.add(cb); return () => void this.statusListeners.delete(cb); }
  private emitStatus() { void this.status().then((s) => this.statusListeners.forEach((f) => f(s))); }

  // ---- lifecycle ----
  /** Connects when a url and token are configured; otherwise stays idle until they are. Safe to call again. */
  async start() {
    this.stopped = false;
    await this.open();
  }
  stop() {
    this.stopped = true;
    this.teardown();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
  /** After the url or token changed. */
  async reconfigure() {
    this.err = undefined;
    this.attempt = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
    if (!this.stopped) await this.open();
    else this.emitStatus();
  }

  private teardown() {
    const was = this.ready;
    this.ready = false;
    this.gen++;
    this.classifying = false;
    this.phase = "idle";
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    this.subId = null;
    this.autoWeather = undefined;
    this.deviceOf.clear(); this.selectsOf.clear();
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* closed */ } }
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(t("lost the Home Assistant connection"))); this.pending.delete(id); }
    if (was) {
      this.entityListeners.forEach((f) => f(Object.fromEntries(this.wanted.map((id) => [id, null]))));
      this.emitStatus();
    }
  }

  private async open() {
    const url = await this.store.url();
    const token = await this.credential();
    if (!token && this.usedOAuth && this.err) return this.dropped(); // could not refresh (HA unreachable): try again with the usual back-off
    if (!url || !token) { this.emitStatus(); return; }
    if (this.ws || this.classifying) return; // an attempt is already running: let it finish
    let ws: SocketLike;
    const gen = ++this.gen;
    // a name that does not resolve is reported at once (a .local name can otherwise hang until the connect timeout)
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (!/^[\d.]+$/.test(host) && !host.includes(":")) {
      this.classifying = true;
      try { await (this.o.resolveHost ?? ((h) => import("node:dns").then((d) => d.promises.lookup(h))))(host); }
      catch (e) {
        if (gen === this.gen) { this.classifying = false; this.fail(t("cannot resolve the host name \"{host}\" (check DNS or the .local name)", { host }), shortMsg(e)); }
        return;
      }
      if (gen !== this.gen) return;
      this.classifying = false;
    }
    try { ws = (this.o.createSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike))(hassWsUrl(url)); }
    catch (e: any) { this.fail(t("invalid URL: {msg}", { msg: shortMsg(e) }), shortMsg(e)); return; }
    this.ws = ws;
    this.detail = undefined;
    this.setPhase("connecting", gen, this.o.connectMs ?? 8000, () => this.fail(t("cannot connect to {target} (timed out: the machine is off, the port is wrong or it is blocked)", { target: hostPort(url) }), "connect timeout"));
    ws.onopen = () => {
      if (gen !== this.gen) return;
      const ms = this.o.greetMs ?? 5000;
      this.setPhase("greeting", gen, ms, () => this.fail(t("the URL is not Home Assistant (no auth_required received)"), "no auth_required"));
    };
    ws.onmessage = (e) => this.onMessage(ws, String(e.data), token, gen);
    ws.onerror = (e: any) => { if (e?.message && gen === this.gen && !this.detail) this.detail = shortMsg(e.message); };
    ws.onclose = (e: any) => {
      if (this.ws !== ws || gen !== this.gen) return;
      this.ws = null;
      const phase = this.phase;
      if (this.phaseTimer) clearTimeout(this.phaseTimer);
      this.phaseTimer = undefined;
      const reason = shortMsg(e?.reason || this.detail || "");
      if (phase === "ready") { this.err = t("lost the Home Assistant connection, retrying"); this.detail = reason || undefined; return this.dropped(); }
      if (phase === "greeting") return this.fail(t("the URL is not Home Assistant (the connection closed right after opening)"), reason || "closed");
      if (phase === "auth") return this.fail(t("Home Assistant closed the connection during authentication"), reason || "closed");
      // never opened: why?
      this.classifying = true;
      void this.classifyConnect(url, e?.code, reason).then((m) => {
        if (gen !== this.gen) return;
        this.classifying = false;
        this.fail(m, reason || undefined);
      });
    };
  }

  private setPhase(p: HassClient["phase"], gen: number, ms: number | null, onTimeout?: () => void) {
    this.phase = p;
    if (this.phaseTimer) clearTimeout(this.phaseTimer);
    this.phaseTimer = undefined;
    if (ms && onTimeout) {
      this.phaseTimer = setTimeout(() => { if (gen === this.gen) onTimeout(); }, ms);
      (this.phaseTimer as any).unref?.();
    }
  }

  /** The socket never opened: DNS, TLS, "not a WebSocket server" or an unreachable host. */
  private async classifyConnect(url: string, code: unknown, reason: string): Promise<string> {
    const u = new URL(url);
    if (code === 1015 || /tls|certificate|ssl|handshake/i.test(reason)) return t("HTTPS certificate error (try http:// with an IP address, or use a valid certificate)");
    if (code === 1002 || /101|upgrade|expected/i.test(reason)) return t("the URL is not Home Assistant (the server answered but has no WebSocket at /api/websocket)");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!/^[\d.]+$/.test(host) && !host.includes(":")) {
      try { await (this.o.resolveHost ?? ((h) => import("node:dns").then((d) => d.promises.lookup(h))))(host); }
      catch { return t("cannot resolve the host name \"{host}\" (check DNS or the .local name)", { host }); }
    }
    return t("cannot connect to {target} (the machine is off, the port is wrong or it is blocked)", { target: hostPort(url) });
  }

  private fail(msg: string, detail?: string) {
    this.err = msg;
    this.detail = detail ? shortMsg(detail) : undefined;
    this.dropped();
  }

  private dropped() {
    this.teardown();
    this.emitStatus();
    if (this.stopped || this.err === t(AUTH_ERR)) return; // a bad token does not get better by retrying
    const d = this.o.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000];
    const wait = d[Math.min(this.attempt++, d.length - 1)]!;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.open(), wait);
    (this.retryTimer as any).unref?.();
  }

  private send(msg: Record<string, unknown>) { this.ws?.send(JSON.stringify(msg)); }

  private request<T = any>(msg: Record<string, unknown>): Promise<T> {
    if (!this.ready || !this.ws) return Promise.reject(new Error(t("Home Assistant is not connected")));
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(t("Home Assistant did not answer"))); }, this.o.requestTimeoutMs ?? 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...msg, id });
    });
  }

  private onMessage(ws: SocketLike, raw: string, token: string, gen: number) {
    if (gen !== this.gen) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case "auth_required": {
        const ms = this.o.authMs ?? 8000;
        this.setPhase("auth", gen, ms, () => this.fail(t("Home Assistant did not answer authentication within {s} seconds", { s: Math.round(ms / 1000) }), "auth timeout"));
        return this.send({ type: "auth", access_token: token });
      }
      case "auth_invalid":
        if (this.usedOAuth && !this.oauthRetried && this.o.oauth) {
          // the access token was rejected (revoked, or the clock): refresh once and reconnect at once
          this.oauthRetried = true;
          this.o.oauth.invalidate();
          this.teardown();
          void this.open();
          return;
        }
        this.err = t(AUTH_ERR); this.detail = shortMsg(m.message ?? "auth_invalid"); this.attempt = 0; return this.dropped();
      case "auth_ok":
        this.setPhase("ready", gen, null);
        this.ready = true; this.err = undefined; this.detail = undefined; this.attempt = 0; this.oauthRetried = false; this.version = m.ha_version;
        this.pongAt = Date.now();
        this.startPing();
        this.emitStatus();
        this.subscribe();
        void this.loadRegistry();
        void this.request<any>({ type: "auth/current_user" }).then((u) => { if (gen === this.gen && typeof u?.name === "string") this.haUser = u.name.slice(0, 80); }).catch(() => {});
        void this.request<any>({ type: "get_config" }).then((cfg) => {
          if (gen === this.gen && typeof cfg?.location_name === "string") this.haName = cfg.location_name.slice(0, 80);
          const u = tempUnitOf(cfg?.unit_system?.temperature);
          if (!u || gen !== this.gen) return;
          this.sysUnit = u === "f" ? "°F" : "°C";
          const snap = this.snapshot();
          if (Object.keys(snap).length) this.entityListeners.forEach((f) => f(snap)); // the phones learn the unit
        }).catch(() => { /* older HA: entities that carry a unit still work */ });
        return;
      case "pong": this.pongAt = Date.now(); return;
      case "event": if (m.id === this.subId) this.applyEvent(m.event); return;
      case "result": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.success) p.resolve(m.result ?? null);
        else p.reject(new Error(m.error?.message ?? t("Home Assistant reported an error")));
      }
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const every = this.o.pingMs ?? 30_000;
    this.pingTimer = setInterval(() => {
      if (!this.ready) return;
      if (Date.now() - this.pongAt > every * 2.5) return this.fail(t("connection lost (no pong)"));
      try { this.send({ id: this.seq++, type: "ping" }); } catch { /* closing */ }
    }, every);
    (this.pingTimer as any).unref?.();
  }

  /** Subscribes to exactly the wanted entities (an empty list unsubscribes). */
  private subscribe() {
    if (!this.ready) return;
    if (this.subId !== null) { this.send({ id: this.seq++, type: "unsubscribe_events", subscription: this.subId }); this.subId = null; }
    const ids = this.subscribed();
    this.subIds = ids.join(",");
    for (const id of [...this.states.keys()]) if (!ids.includes(id)) this.states.delete(id);
    if (!ids.length) return;
    this.subId = this.seq++;
    this.send({ id: this.subId, type: "subscribe_entities", entity_ids: ids });
  }

  private subscribed(): string[] {
    const extra = new Set<string>();
    const auto = this.autoWeather?.id;
    if (auto) extra.add(auto);
    for (const w of this.wanted) if (w.startsWith("light.")) for (const s of this.selectsOf.get(this.deviceOf.get(w) ?? "") ?? []) extra.add(s);
    for (const w of this.wanted) extra.delete(w);
    return extra.size ? [...this.wanted, ...extra].sort() : this.wanted;
  }

  /**
   * The weather.* entity to use when a weather tile picked none: the first one Home Assistant has (sorted by id),
   * looked up once per connection and then kept subscribed. Null when not connected or HA has no weather entity.
   */
  async weatherEntity(): Promise<string | null> {
    if (!this.ready) return null;
    if (this.autoWeather) return this.autoWeather.id;
    const gen = this.gen;
    const states = await this.request<any[]>({ type: "get_states" });
    if (gen !== this.gen) return null; // reconnected while asking
    const found = states.filter((s) => String(s.entity_id).startsWith("weather.")).sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)))[0];
    this.autoWeather = { id: found ? String(found.entity_id) : null };
    if (found) {
      this.states.set(String(found.entity_id), { state: String(found.state), attributes: { ...(found.attributes ?? {}) } }); // usable at once, the subscription keeps it fresh
      this.subscribe();
    }
    return this.autoWeather.id;
  }

  /** The entities the layout uses. */
  setWanted(ids: string[]) {
    const next = [...new Set(ids)].sort();
    if (next.join(",") === this.wanted.join(",")) return;
    this.wanted = next;
    this.subscribe();
  }

  private applyEvent(ev: any) {
    const changed: Record<string, PhoneEntity | null> = {};
    const set = (id: string, s: HassState | undefined) => {
      if (s) this.states.set(id, s); else this.states.delete(id);
      changed[id] = s ? this.phone(id, s) : null;
      this.stateListeners.forEach((f) => f(id, s));
    };
    for (const [id, e] of Object.entries<any>(ev?.a ?? {})) set(id, { state: String(e.s), attributes: { ...(e.a ?? {}) } });
    for (const [id, diff] of Object.entries<any>(ev?.c ?? {})) {
      const cur = this.states.get(id) ?? { state: "unknown", attributes: {} };
      const attrs = { ...(cur.attributes ?? {}) };
      for (const [k, v] of Object.entries<any>(diff["+"]?.a ?? {})) attrs[k] = v;
      for (const k of diff["-"]?.a ?? []) delete attrs[k];
      set(id, { state: diff["+"]?.s !== undefined ? String(diff["+"].s) : cur.state, attributes: attrs });
    }
    for (const id of ev?.r ?? []) set(id, undefined);
    for (const id of Object.keys(changed)) if (id.startsWith("select.")) for (const l of this.lightsOf(id)) { const s = this.states.get(l); if (s) changed[l] = this.phone(l, s); }
    if (Object.keys(changed).length) this.entityListeners.forEach((f) => f(changed));
  }

  // ---- commands ----
  async callService(service: string, entityId?: string, data?: Record<string, unknown>): Promise<void> {
    const dot = service.indexOf(".");
    if (dot <= 0) throw new Error(t("invalid service: {service}", { service }));
    await this.request({
      type: "call_service", domain: service.slice(0, dot), service: service.slice(dot + 1),
      ...(data ? { service_data: data } : {}),
      ...(entityId ? { target: { entity_id: entityId } } : {}),
    });
  }

  /** Weather entity with forecasts (new HA: weather.get_forecasts; older: the forecast attribute). */
  async weather(entityId: string): Promise<HassWeather | null> {
    const st = this.states.get(entityId);
    if (!st) return null;
    const forecast = async (type: "hourly" | "daily") => {
      try {
        const r = await this.request({ type: "call_service", domain: "weather", service: "get_forecasts", service_data: { type }, target: { entity_id: entityId }, return_response: true });
        return r?.response?.[entityId]?.forecast as any[] | undefined;
      } catch { return undefined; }
    };
    const [hourly, daily] = await Promise.all([forecast("hourly"), forecast("daily")]);
    return { state: st.state, attributes: st.attributes ?? {}, hourly: hourly ?? [], daily: daily ?? (Array.isArray(st.attributes?.forecast) ? st.attributes!.forecast : []) };
  }

  async entities(): Promise<{ id: string; name: string; domain: string; area: string | null; state: string; icon?: string }[]> {
    const [states, reg, devs, areas] = await Promise.all([
      this.request<any[]>({ type: "get_states" }),
      this.request<any[]>({ type: "config/entity_registry/list" }).catch(() => []),
      this.request<any[]>({ type: "config/device_registry/list" }).catch(() => []),
      this.request<any[]>({ type: "config/area_registry/list" }).catch(() => []),
    ]);
    const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
    const devArea = new Map(devs.map((d) => [d.id, d.area_id]));
    const entArea = new Map(reg.map((r) => [r.entity_id, r.area_id ?? devArea.get(r.device_id)]));
    return states.map((s) => ({
      id: s.entity_id, name: String(s.attributes?.friendly_name ?? s.entity_id), domain: String(s.entity_id).split(".")[0]!,
      area: areaName.get(entArea.get(s.entity_id)) ?? null, state: String(s.state), ...(s.attributes?.icon ? { icon: String(s.attributes.icon) } : {}),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async areas(): Promise<{ id: string; name: string }[]> {
    return (await this.request<any[]>({ type: "config/area_registry/list" })).map((a) => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async services(): Promise<{ service: string; name: string; description?: string }[]> {
    const all = await this.request<Record<string, Record<string, any>>>({ type: "get_services" });
    const out: { service: string; name: string; description?: string }[] = [];
    for (const [domain, svcs] of Object.entries(all)) for (const [name, def] of Object.entries<any>(svcs)) out.push({ service: `${domain}.${name}`, name: def?.name ?? name, ...(def?.description ? { description: String(def.description).slice(0, 200) } : {}) });
    return out.sort((a, b) => a.service.localeCompare(b.service));
  }

  /**
   * Connection attempt with the stored settings (the "Test connection" button). Reuses an attempt that is already
   * running instead of starting a second one, and reports the real cause when it fails.
   */
  async test(timeoutMs = 20_000): Promise<HassStatus> {
    this.stopped = false;
    if (this.ready) return this.status();
    const url = await this.store.url();
    const token = (await this.store.token()) ?? ((await this.store.hasRefreshToken()) ? "oauth" : undefined);
    if (!url || !token) { this.err = !url ? t("no Home Assistant URL yet") : t("no token yet"); this.detail = undefined; return this.status(); }
    const running = !!this.ws || this.classifying;
    if (!running) {
      // a pending retry is replaced by this attempt
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.err = undefined; this.detail = undefined; this.attempt = 0;
      await this.open();
    }
    const end = Date.now() + timeoutMs;
    while (!this.ready && Date.now() < end) {
      if ((this.err && !this.ws && !this.classifying) ) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    if (!this.ready && !this.err) {
      const phase = this.phase;
      this.err = phase === "auth" ? t("Home Assistant did not answer authentication") : phase === "greeting" ? t("the URL is not Home Assistant (no auth_required received)") : t("cannot connect (timed out)");
      this.detail = "test timeout";
    }
    return this.status();
  }
}

const shortMsg = (m: unknown): string => String((m as any)?.message ?? m ?? "").replace(/^WebSocket connection to '[^']*' failed:\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 120);
const hostPort = (url: string) => new URL(url).host;

export const AUTH_ERR = "invalid token (Home Assistant rejected it)";
export { normalizeHassUrl };
