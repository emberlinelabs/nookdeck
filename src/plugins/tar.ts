// A small, strict tar.gz reader for plugin packages downloaded from GitHub (codeload). It never touches the disk: it returns the
// files of ONE subfolder as a Map. Anything unsafe in the archive is refused, not skipped.
import { gunzipSync } from "node:zlib";

export const TAR_MAX_COMPRESSED = 10 * 1024 * 1024;
export const TAR_MAX_UNPACKED = 20 * 1024 * 1024;
export const TAR_MAX_FILES = 500;
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

export class TarError extends Error {}

const dec = new TextDecoder();
const str = (b: Uint8Array, from: number, len: number): string => {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return dec.decode(b.subarray(from, end));
};
const octal = (b: Uint8Array, from: number, len: number): number => {
  if (b[from] & 0x80) throw new TarError("the archive uses an unsupported size encoding");
  const s = str(b, from, len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new TarError("the archive is damaged");
  return parseInt(s, 8);
};

/** pax extended header records: "<len> key=value\n" */
function pax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(dec.decode(data.subarray(i, sp)), 10);
    if (!(len > 0) || i + len > data.length) throw new TarError("the archive is damaged");
    const rec = dec.decode(data.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

/**
 * Reads a tar.gz and returns the regular files under `subdir` (relative to the archive's single top-level folder), keyed by path
 * relative to `subdir`. Throws TarError for: oversize (compressed, unpacked, file count), absolute or `..` paths anywhere, and
 * symlinks, hard links or device files inside the plugin folder.
 */
export function readTarGz(gz: Uint8Array, subdir = "", opts: { maxUnpacked?: number; maxFiles?: number } = {}): Map<string, Uint8Array> {
  const maxUnpacked = opts.maxUnpacked ?? TAR_MAX_UNPACKED;
  const maxFiles = opts.maxFiles ?? TAR_MAX_FILES;
  if (gz.length > TAR_MAX_COMPRESSED) throw new TarError("the package is larger than 10 MB");
  let tar: Uint8Array;
  try { tar = gunzipSync(gz, { maxOutputLength: maxUnpacked + 1024 * 1024 }); }
  catch (e: any) {
    if (e?.code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(String(e?.message))) throw new TarError("the package is larger than 20 MB unpacked");
    throw new TarError("the package is not a valid .tar.gz");
  }
  const prefix = subdir.replace(/^\/+|\/+$/g, "");
  const files = new Map<string, Uint8Array>();
  let total = 0, pos = 0, longName: string | null = null, ext: Record<string, string> = {};
  while (pos + 512 <= tar.length) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new TarError("the archive is damaged");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = pos + 512;
    if (dataStart + size > tar.length) throw new TarError("the archive is damaged");
    const data = tar.subarray(dataStart, dataStart + size);
    pos = dataStart + Math.ceil(size / 512) * 512;

    if (type === "g") continue;                               // pax global header (GitHub puts the commit here)
    if (type === "x") { ext = pax(data); continue; }
    if (type === "L") { longName = str(data, 0, data.length); continue; }
    let name = ext.path ?? longName ?? ((h[345] || 0) && str(h, 257, 6).startsWith("ustar") ? `${str(h, 345, 155)}/${str(h, 0, 100)}` : str(h, 0, 100));
    ext = {}; longName = null;

    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..") || name.includes("\\") || name.includes("\0")) {
      throw new TarError("the package contains an unsafe path");
    }
    // strip the top-level folder (owner-repo-sha/)
    const slash = name.indexOf("/");
    const rel = slash < 0 ? "" : name.slice(slash + 1);
    const inPlugin = prefix === "" ? true : rel === prefix || rel.startsWith(`${prefix}/`);
    if (!inPlugin) continue;
    const inner = prefix === "" ? rel : rel.slice(prefix.length + 1);
    if (type === "5") continue;                               // directory
    if (type === "1" || type === "2") throw new TarError("the package contains a link, which is not allowed");
    if (type === "3" || type === "4" || type === "6" || type === "7") throw new TarError("the package contains a special file, which is not allowed");
    if (type !== "0" && type !== "\0") continue;              // anything else (e.g. vendor extensions) is ignored, never extracted
    if (!inner) continue;
    if (inner.split("/").some((s) => SKIP_DIRS.has(s))) continue;
    if (files.size >= maxFiles) throw new TarError(`the plugin has more than ${maxFiles} files`);
    total += size;
    if (total > maxUnpacked) throw new TarError("the plugin is larger than 20 MB");
    files.set(inner, data.slice());
  }
  return files;
}
