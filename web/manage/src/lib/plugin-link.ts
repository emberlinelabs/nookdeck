/**
 * Plugin install deeplinks, read from the page hash:
 *   #plugins?add=<registry id>             opens the Store's Add flow (sha256-pinned install-from-registry)
 *   #plugins?install=<url-encoded https>   opens "Install from a link" with the address filled in
 * Nothing here installs anything: the page only opens a dialog and the user presses its button.
 */
export type PluginLink = { kind: "add"; id: string } | { kind: "install"; source: string };
export type PluginLinkResult = { link: PluginLink } | { rejected: true } | null;

/** The same shape the agent accepts for a plugin id (PLUGIN_ID_RE in src/config.ts). */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}(\.[a-z0-9][a-z0-9_-]{0,47}){1,4}$/;
const MAX_SOURCE = 2048;

/** null: the hash is not a plugin deeplink. { rejected }: it is one, but the value is not acceptable. */
export function parsePluginLink(hash: string): PluginLinkResult {
  const m = /^#plugins\?(.*)$/.exec(hash);
  if (!m) return null;
  let params: URLSearchParams;
  try { params = new URLSearchParams(m[1]); } catch { return { rejected: true }; }
  const add = params.get("add");
  const install = params.get("install");
  if (add === null && install === null) return null;
  if (add !== null && install !== null) return { rejected: true };
  if (add !== null) {
    const id = add.trim();
    return ID_RE.test(id) ? { link: { kind: "add", id } } : { rejected: true };
  }
  const source = cleanHttpsSource(install ?? "");
  return source ? { link: { kind: "install", source } } : { rejected: true };
}

/** An https address with a host, no credentials and no control characters; otherwise null. */
export function cleanHttpsSource(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > MAX_SOURCE || /[\u0000-\u001f\u007f\s]/.test(s)) return null;
  if (!/^https:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return null;
  return s;
}

const norm = (s: string) => s.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
/** True when a link address is a Store entry's repo (so the reviewed, pinned Add flow is used instead). */
export function sameRepo(a: string, b: string): boolean { return norm(a) === norm(b); }

/** #themes (the Packs tab of the Theme page) and #themes?add=<theme pack id>, which opens that pack's details. Nothing is installed until the user presses the button. */
export function parseThemeLink(hash: string): { open: true; id?: string } | { rejected: true } | null {
  const m = /^#themes(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  if (m[1] === undefined) return { open: true };
  let params: URLSearchParams;
  try { params = new URLSearchParams(m[1]); } catch { return { rejected: true }; }
  const add = params.get("add");
  if (add === null) return { open: true };
  const id = add.trim();
  return ID_RE.test(id) ? { open: true, id } : { rejected: true };
}
