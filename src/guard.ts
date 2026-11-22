import { hostname, networkInterfaces } from "node:os";

/** Header the management page (and every other localhost client) must send on state-changing requests. */
export const CSRF_HEADER = "x-nookdeck";
/** Pre-rename clients (0.1.x management page, scripts) send this one; both are accepted. */
export const LEGACY_CSRF_HEADER = "x-phonedesk";
export const CSRF_VALUE = "1";

const LOCAL_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** Splits a Host header or origin authority into lowercase name and numeric port (default 80). */
function parseAuthority(a: string): { name: string; port: number } | null {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(a.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : 80 };
}

/** Host header must be one of `names` on our port. Anything else is a DNS-rebinding attempt. */
export function hostAllowed(host: string | null | undefined, port: number, names: Iterable<string>): boolean {
  if (!host) return false;
  const h = parseAuthority(host);
  return !!h && h.port === port && new Set([...names].map((n) => n.toLowerCase())).has(h.name);
}

/** An Origin, when present, must be http://<allowed name>:<our port>. "null" and other schemes fail. */
export function originAllowed(origin: string | null | undefined, port: number, names: Iterable<string>): boolean {
  if (origin === null || origin === undefined) return true;
  const m = /^http:\/\/([^/]+)$/i.exec(origin);
  return !!m && hostAllowed(m[1], port, names);
}

export const localNames = () => LOCAL_NAMES;

/** Names a phone may use to reach us: localhost, our interface addresses, <LocalHostName>.local and <hostname>.local. */
export function phoneNames(extra: string[] = [], exact: string[] = []): string[] {
  const out = new Set<string>(LOCAL_NAMES);
  for (const addrs of Object.values(networkInterfaces())) for (const a of addrs ?? []) if (a.family === "IPv4") out.add(a.address);
  const h = hostname().split(".")[0];
  if (h) { out.add(`${h}.local`); out.add(hostname().toLowerCase()); }
  for (const e of extra) if (e) out.add(`${e}.local`);
  for (const e of exact) if (e) out.add(e.toLowerCase()); // e.g. the Tailscale MagicDNS name
  return [...out];
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface LocalCheck { port: number; method: string; headers: Headers; /** upload routes carry their own content type */ upload?: boolean; /** the hook CLI: secret header instead of CSRF header */ hook?: boolean }

/** Returns an error message when a localhost-only request is not from our own management page / tools. */
export function localRequestError(c: LocalCheck): string | null {
  if (!hostAllowed(c.headers.get("host"), c.port, LOCAL_NAMES)) return "forbidden: bad Host";
  if (!originAllowed(c.headers.get("origin"), c.port, LOCAL_NAMES)) return "forbidden: cross-site Origin";
  if (c.hook || !MUTATING.has(c.method)) return null;
  if (c.headers.get(CSRF_HEADER) !== CSRF_VALUE && c.headers.get(LEGACY_CSRF_HEADER) !== CSRF_VALUE) return `forbidden: missing ${CSRF_HEADER}: ${CSRF_VALUE} header`;
  if (!c.upload && !/^application\/json\s*(;|$)/i.test(c.headers.get("content-type") ?? "")) return "forbidden: content-type must be application/json";
  return null;
}
