import { createHash, randomBytes } from "node:crypto";
import type { HassConfigStore } from "./config";
import { normalizeHassUrl } from "./config";

/**
 * "Sign in with Home Assistant": OAuth 2 as Home Assistant does it (IndieAuth style, developers.home-assistant.io/docs/auth_api).
 * The client id is the agent's own URL, `http://127.0.0.1:<port>/`; HA accepts a redirect URI on the same host and port as the
 * client id (`http://127.0.0.1:<port>/api/hass/callback`), so no `<link rel="redirect_uri">` page is needed. PKCE (S256) is used.
 * The refresh token goes to the Keychain (or the 0600 file); the 30-minute access token stays in memory. Neither is ever
 * returned by an API, logged, or sent to a phone.
 */
export const STATE_TTL_MS = 10 * 60_000;
const EARLY_MS = 60_000; // refresh this long before the access token runs out
const MAX_PENDING = 8;

interface Pending { url: string; origin: string; verifier: string; at: number }
export interface OAuthOptions { store: HassConfigStore; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

export const clientIdFor = (origin: string) => `${origin}/`;
export const redirectUriFor = (origin: string) => `${origin}/api/hass/callback`;
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class HassOAuth {
  private pending = new Map<string, Pending>();
  private access: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string | null> | null = null;
  /** The origin the client id was made from (HA wants the same client_id on refresh); after a restart it is read from hass.json. */
  private origin: string | null = null;
  constructor(private o: OAuthOptions) {}

  private now() { return (this.o.now ?? Date.now)(); }
  private f(): typeof fetch { return this.o.fetch ?? fetch; }
  private signal() { return AbortSignal.timeout(this.o.timeoutMs ?? 15_000); }

  /** Starts a login: remembers a random state (10 minutes) with the HA url and returns where to send the browser. */
  login(rawUrl: unknown, origin: string): { authorizeUrl: string } {
    const url = normalizeHassUrl(rawUrl);
    const t0 = this.now();
    for (const [k, v] of this.pending) if (t0 - v.at > STATE_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.pending.set(state, { url, origin, verifier, at: t0 });
    const q = new URLSearchParams({
      response_type: "code", client_id: clientIdFor(origin), redirect_uri: redirectUriFor(origin), state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256",
    });
    return { authorizeUrl: `${url}/auth/authorize?${q}` };
  }

  /** The browser came back: checks the state (one use), exchanges the code, stores the refresh token and the url. */
  async callback(code: unknown, state: unknown): Promise<void> {
    const p = typeof state === "string" ? this.pending.get(state) : undefined;
    if (typeof state === "string") this.pending.delete(state); // a state is good once
    if (!p || this.now() - p.at > STATE_TTL_MS) throw new Error("the sign-in request is unknown or expired: start it again");
    if (typeof code !== "string" || !code) throw new Error("Home Assistant sent no code");
    const r = await this.post(`${p.url}/auth/token`, { grant_type: "authorization_code", code, client_id: clientIdFor(p.origin), code_verifier: p.verifier });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || typeof j?.refresh_token !== "string" || typeof j?.access_token !== "string") throw new Error(`Home Assistant refused the code (${r.status}${typeof j?.error === "string" ? `: ${j.error}` : ""})`);
    await this.o.store.setUrl(p.url);
    await this.o.store.setRefreshToken(j.refresh_token);
    await this.o.store.setOauthOrigin(p.origin);
    this.origin = p.origin;
    this.access = { token: j.access_token, expiresAt: this.now() + (Number(j.expires_in) || 1800) * 1000 };
  }

  private async post(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await this.f()(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: this.signal() });
    } catch (e: any) { throw new Error(`cannot reach Home Assistant (${String(e?.message ?? e).slice(0, 80)})`); }
  }

  async connected(): Promise<boolean> { return this.o.store.hasRefreshToken(); }

  /** A valid access token, refreshed when it is about to run out; null without a sign-in (or after HA ended it). */
  async accessToken(): Promise<string | null> {
    if (this.access && this.access.expiresAt - this.now() > EARLY_MS) return this.access.token;
    this.inflight ??= this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /** The access token was rejected (HA said so): drop it, so the next call refreshes. */
  invalidate() { this.access = null; }

  private async refresh(): Promise<string | null> {
    const refresh = await this.o.store.refreshToken();
    const url = await this.o.store.url();
    if (!refresh || !url) return null;
    const origin = this.origin ?? (await this.o.store.oauthOrigin());
    if (!origin) return null;
    const r = await this.post(`${url}/auth/token`, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientIdFor(origin) });
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 400 || r.status === 401) { await this.o.store.clearRefreshToken(); this.access = null; return null; } // HA ended the sign-in
    if (!r.ok || typeof j?.access_token !== "string") throw new Error(`Home Assistant did not refresh the sign-in (${r.status})`);
    this.access = { token: j.access_token, expiresAt: this.now() + (Number(j.expires_in) || 1800) * 1000 };
    return this.access.token;
  }

  /** Revokes the refresh token (and every access token it made) at HA, then forgets it here. HA unreachable: forgotten anyway. */
  async logout(): Promise<void> {
    const refresh = await this.o.store.refreshToken();
    const url = await this.o.store.url();
    this.access = null;
    try { if (refresh && url) await this.post(`${url}/auth/revoke`, { token: refresh }); } catch { /* still sign out here */ }
    await this.o.store.clearRefreshToken();
  }
}
