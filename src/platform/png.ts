/**
 * A small pure PNG codec for Linux, where there is no sips or Windows helper: decode (every colour type, bit depths
 * 1-16, Adam7 interlacing), an area-average shrink, and an RGBA encoder. zlib comes from node:zlib (Bun has it).
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface Rgba { w: number; h: number; data: Uint8Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_SIDE = 8192;

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && SIG.every((v, i) => b[i] === v);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** RGBA pixels of a PNG, or null when it is not one this decoder reads. */
export function decodePng(bytes: Uint8Array): Rgba | null {
  if (!isPng(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= bytes.length;) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    const body = bytes.subarray(p + 8, p + 8 + len);
    if (body.length !== len) return null;
    if (type === "IHDR") {
      w = dv.getUint32(p + 8); h = dv.getUint32(p + 12);
      depth = bytes[p + 16]!; ctype = bytes[p + 17]!; interlace = bytes[p + 20]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels || !w || !h || w > MAX_SIDE || h > MAX_SIDE || ![1, 2, 4, 8, 16].includes(depth)) return null;
  if (ctype === 3 && !palette) return null;
  let raw: Uint8Array;
  try { raw = new Uint8Array(inflateSync(Buffer.concat(idat))); } catch { return null; }

  const bpp = Math.max(1, (channels * depth) >> 3); // bytes per pixel for the filter, at least 1
  const out = new Uint8Array(w * h * 4);
  const maxV = (1 << Math.min(depth, 8)) - 1;
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let pos = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((w - x0!) / dx!), ph = Math.ceil((h - y0!) / dy!);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * channels * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      if (pos + 1 + stride > raw.length) return null;
      const f = raw[pos]!;
      const line = raw.slice(pos + 1, pos + 1 + stride);
      pos += 1 + stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
        const v = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : -1;
        if (v < 0) return null;
        line[i] = (line[i]! + v) & 255;
      }
      prev = line;
      const sample = (x: number, ch: number): number => {
        if (depth === 16) return line[(x * channels + ch) * 2]!; // high byte
        if (depth === 8) return line[x * channels + ch]!;
        const bit = (x * channels + ch) * depth;
        return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & maxV;
      };
      const sample16 = (x: number, ch: number): number => (line[(x * channels + ch) * 2]! << 8) | line[(x * channels + ch) * 2 + 1]!;
      for (let x = 0; x < pw; x++) {
        const o = ((y0! + y * dy!) * w + (x0! + x * dx!)) * 4;
        let r: number, g: number, bl: number, al = 255;
        if (ctype === 3) {
          const i = sample(x, 0);
          r = palette![i * 3] ?? 0; g = palette![i * 3 + 1] ?? 0; bl = palette![i * 3 + 2] ?? 0;
          al = trns && i < trns.length ? trns[i]! : 255;
        } else if (ctype === 0 || ctype === 4) {
          const v = sample(x, 0);
          r = g = bl = depth < 8 ? Math.round((v * 255) / maxV) : v;
          if (ctype === 4) al = sample(x, 1);
          else if (trns && trns.length >= 2) {
            const key = (trns[0]! << 8) | trns[1]!;
            if ((depth === 16 ? sample16(x, 0) : sample(x, 0)) === key) al = 0;
          }
        } else {
          r = sample(x, 0); g = sample(x, 1); bl = sample(x, 2);
          if (ctype === 6) al = sample(x, 3);
          else if (trns && trns.length >= 6) {
            const k = (i: number) => (trns![i * 2]! << 8) | trns![i * 2 + 1]!;
            const s = depth === 16 ? [sample16(x, 0), sample16(x, 1), sample16(x, 2)] : [r, g, bl];
            if (s[0] === k(0) && s[1] === k(1) && s[2] === k(2)) al = 0;
          }
        }
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = al;
      }
    }
  }
  return { w, h, data: out };
}

/** Shrinks to fit `max` px (never enlarges), averaging each source area with alpha weighting. */
export function shrinkRgba(img: Rgba, max: number): Rgba {
  const scale = Math.min(1, max / Math.max(img.w, img.h));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(img.w * scale)), h = Math.max(1, Math.round(img.h * scale));
  const out = new Uint8Array(w * h * 4);
  const sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) {
    const ya = y * sy, yb = ya + sy;
    for (let x = 0; x < w; x++) {
      const xa = x * sx, xb = xa + sx;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let iy = Math.floor(ya); iy < Math.ceil(yb); iy++) {
        const wy = Math.min(yb, iy + 1) - Math.max(ya, iy);
        for (let ix = Math.floor(xa); ix < Math.ceil(xb); ix++) {
          const wgt = wy * (Math.min(xb, ix + 1) - Math.max(xa, ix));
          const i = (iy * img.w + ix) * 4;
          const al = img.data[i + 3]! * wgt;
          r += img.data[i]! * al; g += img.data[i + 1]! * al; b += img.data[i + 2]! * al; a += al; area += wgt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / area);
    }
  }
  return { w, h, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC[(c ^ p[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  const t = new TextEncoder().encode(type);
  out.set(t, 4);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32([t, body]));
  return out;
}

/** An 8-bit RGBA PNG. */
export function encodePng(img: Rgba): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.w); dv.setUint32(4, img.h);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = new Uint8Array(img.h * (img.w * 4 + 1));
  for (let y = 0; y < img.h; y++) raw.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), y * (img.w * 4 + 1) + 1);
  const parts = [new Uint8Array(SIG), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A PNG shrunk to at most `max` px; the input itself when it already fits; null when it cannot be read. */
export function shrinkPng(bytes: Uint8Array, max: number): Uint8Array | null {
  const img = decodePng(bytes);
  if (!img) return null;
  return img.w <= max && img.h <= max ? bytes : encodePng(shrinkRgba(img, max));
}
