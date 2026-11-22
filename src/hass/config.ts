import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./../config";
import { platform } from "../platform";
import type { SecretStore } from "../platform/types";
import { keychainStore } from "../platform/darwin";

export const KEYCHAIN_SERVICE = "Nookdeck-HASS";
/** The Keychain item 0.1.x used: read once, copied to the new name, the old item is left alone. */
export const LEGACY_KEYCHAIN_SERVICE = "PhoneDesk-HASS";
export const KEYCHAIN_ACCOUNT = "token";
/** The OAuth refresh token ("Sign in with Home Assistant") lives in the same Keychain item name, under its own account. */
export const KEYCHAIN_REFRESH_ACCOUNT = "refresh";

interface FileShape { url?: string; token?: string; refreshToken?: string; /** the client id origin used at sign-in: a refresh must present the same client_id */ oauthOrigin?: string }

export type Runner = (argv: string[]) => Promise<string>;

/** Normalizes what the user typed into a base URL (no trailing slash, http or https only). Throws a readable error. */
export function normalizeHassUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("url is required");
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`); } catch { throw new Error("url is not valid"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("url must start with http:// or https://");
  if (u.username || u.password) throw new Error("do not put credentials in the url");
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

/** The websocket endpoint for a base URL. */
export const hassWsUrl = (base: string) => `${base.replace(/^http/i, "ws")}/api/websocket`;

/**
 * URL in ~/.nookdeck/hass.json. The token goes to the macOS Keychain (service Nookdeck-HASS); when that is not
 * available it falls back to the same file (0600). The token is never returned by any API.
 */
export class HassConfigStore {
  private file: string;
  private secrets: SecretStore | null;
  /** `run` / `platform` are for tests: a fake `security` on "darwin", or no secret store on another id. */
  constructor(o: { home?: string; run?: Runner; platform?: string } = {}) {
    this.file = join(o.home ?? HOME, "hass.json");
    if (o.run || o.platform) {
      this.secrets = (o.platform ?? "darwin") === "darwin" ? keychainStore(o.run ? (argv) => o.run!(argv) : undefined) : null;
    } else {
      this.secrets = null; // resolved lazily: the real platform store
    }
    this.useReal = !o.run && !o.platform;
  }
  private useReal: boolean;
  private store(): SecretStore | null { return this.useReal ? platform.secrets : this.secrets; }

  private async read(): Promise<FileShape> {
    try { return JSON.parse(await readFile(this.file, "utf8")) ?? {}; } catch { return {}; }
  }
  private async write(d: FileShape) {
    await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(d, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
  }

  async url(): Promise<string | undefined> { return (await this.read()).url; }

  async setUrl(raw: unknown): Promise<string> {
    const url = normalizeHassUrl(raw);
    const d = await this.read();
    await this.write({ ...d, url });
    return url;
  }

  /** The token, or undefined. Looks in the Keychain only when a url is configured, so a fresh install never touches it. */
  async token(): Promise<string | undefined> {
    const d = await this.read();
    if (d.token) return d.token;
    const store = this.store();
    if (!d.url || !store) return undefined;
    const cur = await store.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (cur) return cur;
    const old = await store.get(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (old) await store.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, old).catch(() => {});
    return old;
  }

  async hasToken(): Promise<boolean> { return !!(await this.token()); }

  async setToken(token: unknown): Promise<"keychain" | "file"> {
    if (typeof token !== "string" || !token.trim() || token.length > 2048 || /\s/.test(token.trim())) throw new Error("token is not valid");
    const t = token.trim();
    const d = await this.read();
    const store = this.store();
    if (store && (await store.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, t))) {
      if (d.token) { delete d.token; await this.write(d); }
      return "keychain";
    }
    await this.write({ ...d, token: t });
    return "file";
  }

  // ---- OAuth refresh token (Sign in with Home Assistant). Same rules as the long-lived token: Keychain, else the 0600 file; never returned by an API. ----
  async refreshToken(): Promise<string | undefined> {
    const d = await this.read();
    if (d.refreshToken) return d.refreshToken;
    return (await this.store()?.get(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT)) || undefined;
  }
  async hasRefreshToken(): Promise<boolean> { return !!(await this.refreshToken()); }
  async setRefreshToken(token: string): Promise<"keychain" | "file"> {
    const d = await this.read();
    const store = this.store();
    if (store && (await store.set(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT, token))) {
      if (d.refreshToken) { delete d.refreshToken; await this.write(d); }
      return "keychain";
    }
    await this.write({ ...d, refreshToken: token });
    return "file";
  }
  async oauthOrigin(): Promise<string | undefined> { return (await this.read()).oauthOrigin; }
  async setOauthOrigin(origin: string): Promise<void> { await this.write({ ...(await this.read()), oauthOrigin: origin }); }
  async clearRefreshToken(): Promise<void> {
    const d = await this.read();
    if (d.refreshToken || d.oauthOrigin) { delete d.refreshToken; delete d.oauthOrigin; await this.write(d); }
    await this.store()?.remove(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ACCOUNT);
  }

  async clearToken(): Promise<void> {
    const d = await this.read();
    if (d.token) { delete d.token; await this.write(d); }
    await this.store()?.remove(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    await this.store()?.remove(LEGACY_KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  }
}
