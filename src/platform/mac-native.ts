/**
 * macOS native calls through bun:ffi (CoreGraphics, CoreAudio, the Objective-C runtime, NSAppleScript). Nothing here spawns
 * any child process. Loaded lazily and only on macOS; it runs inside the worker (mac-worker.ts), never on the agent's main thread,
 * because Apple Event and CoreAudio calls can block.
 */
import { dlopen, FFIType as T, ptr, toArrayBuffer } from "bun:ffi";
import { hotkeyPlan, mediaKeyEvent, typePlan, type KeyStep, type MediaKey } from "./mac-keys";

const FW = (n: string) => `/System/Library/Frameworks/${n}.framework/${n}`;
const OBJC = "/usr/lib/libobjc.A.dylib";

const keep: Buffer[] = [];
const cz = (s: string) => { const b = Buffer.from(s + "\0"); keep.push(b); return ptr(b); };
const cache = new Map<string, any>();
const zc = (s: string) => { let v = cache.get(s); if (v === undefined) { v = cz(s); cache.set(s, v); } return v; };

// ---------- Objective-C runtime ----------
let objc: any;
function rt() {
  if (objc) return objc;
  const sys = dlopen("/usr/lib/libSystem.B.dylib", { dlopen: { args: [T.ptr, T.i32], returns: T.ptr } }).symbols;
  for (const f of ["Foundation", "AppKit"]) sys.dlopen(zc(FW(f)), 2);
  // ids and selectors travel as u64 (BigInt): tagged pointers (small NSStrings, NSNumbers) use the top bit, which a JS double would round
  const base = dlopen(OBJC, { objc_getClass: { args: [T.ptr], returns: T.u64 }, sel_registerName: { args: [T.ptr], returns: T.u64 } }).symbols;
  // objc_msgSend has no fixed signature: one dlopen per shape (each call binds the symbol with its own types)
  const send = (args: any[], returns: any) => dlopen(OBJC, { objc_msgSend: { args, returns } }).symbols.objc_msgSend as (...a: any[]) => any;
  const I = T.u64;
  objc = {
    cls: (n: string) => base.objc_getClass(zc(n)) as bigint,
    sel: (n: string) => base.sel_registerName(zc(n)) as bigint,
    p: send([I, I], I),
    pp: send([I, I, I], I),
    pbuf: send([I, I, T.ptr], I),
    u: send([I, I], T.u64),
    event: send([I, I, T.u64, T.f64, T.f64, T.u64, T.f64, T.i64, I, T.i16, T.i64, T.i64], I),
    gcs: send([I, I, T.ptr, T.u64, T.u64], T.bool),
    i16: send([I, I], T.i16),
    i64: send([I, I], T.i64),
    ppb: send([I, I, I], T.bool),
    ppp: send([I, I, I, I], I),
    numInt: send([I, I, T.i32], I),
    numBool: send([I, I, T.bool], I),
    numDouble: send([I, I, T.f64], I),
  };
  return objc;
}
const nsString = (s: string) => {
  const o = rt();
  const buf = Buffer.from(s + "\0"); // alive for this synchronous call; NSString copies the bytes
  return o.pbuf(o.cls("NSString"), o.sel("stringWithUTF8String:"), ptr(buf)) as bigint;
};
const NSUTF8 = 4;
/** NSString -> JS string through getCString into our own buffer (UTF8String's pointer can belong to a temporary). */
const jsString = (ns: any): string => {
  if (ns === 0n) return "";
  const o = rt();
  const units = Number(o.u(ns, o.sel("length")));
  if (!units) return "";
  const buf = Buffer.alloc(units * 3 + 1);
  if (!o.gcs(ns, o.sel("getCString:maxLength:encoding:"), ptr(buf), buf.length, NSUTF8)) return "";
  return buf.toString("utf8", 0, buf.indexOf(0));
};

/** Runs `fn` inside an NSAutoreleasePool so Foundation objects made by the call are freed. */
function pooled<R>(fn: () => R): R {
  const o = rt();
  const pool = o.p(o.p(o.cls("NSAutoreleasePool"), o.sel("alloc")), o.sel("init")) as bigint;
  try { return fn(); } finally { o.p(pool, o.sel("drain")); }
}

// ---------- CoreGraphics: key and media events ----------
let cg: any;
function cgl() {
  if (cg) return cg;
  cg = dlopen(FW("ApplicationServices"), {
    CGEventCreateKeyboardEvent: { args: [T.ptr, T.u16, T.bool], returns: T.ptr },
    CGEventSetFlags: { args: [T.ptr, T.u64], returns: T.void },
    CGEventKeyboardSetUnicodeString: { args: [T.ptr, T.u64, T.ptr], returns: T.void },
    CGEventPost: { args: [T.u32, T.ptr], returns: T.void },
  }).symbols;
  cg.release = dlopen(FW("CoreFoundation"), { CFRelease: { args: [T.ptr], returns: T.void } }).symbols.CFRelease;
  return cg;
}

const HID_TAP = 0;

/** Builds one CGEvent for a step; the caller posts and releases it. */
function keyEvent(step: KeyStep): any {
  const g = cgl();
  const ev = g.CGEventCreateKeyboardEvent(null, step.keyCode, step.down);
  if (!ev) throw new Error("could not create a key event");
  g.CGEventSetFlags(ev, BigInt(step.flags));
  if (step.unicode !== undefined) {
    const units = new Uint16Array(step.unicode.length);
    for (let i = 0; i < units.length; i++) units[i] = step.unicode.charCodeAt(i);
    g.CGEventKeyboardSetUnicodeString(ev, BigInt(units.length), ptr(units));
  }
  return ev;
}

/** Posts a plan; with `dryRun` the events are built and released without being posted. Returns how many events were built. */
export function postKeySteps(steps: KeyStep[], dryRun = false, gapMs = 4): number {
  const g = cgl();
  let n = 0;
  for (const s of steps) {
    const ev = keyEvent(s);
    try { if (!dryRun) g.CGEventPost(HID_TAP, ev); n++; } finally { g.release(ev); }
    if (!dryRun && gapMs > 0) Bun.sleepSync(gapMs);
  }
  return n;
}

export const hotkey = (keys: string, dryRun = false) => postKeySteps(hotkeyPlan(keys), dryRun);
export const typeText = (text: string, dryRun = false) => postKeySteps(typePlan(text), dryRun, 8);

/** A media key as the keyboard sends it: NSSystemDefined event, down then up. With `dryRun` the events are built and read back, not posted. */
export function mediaKey(command: MediaKey, dryRun = false): { data1: number; subtype: number }[] {
  const o = rt();
  const g = cgl();
  return pooled(() => {
    const out: { data1: number; subtype: number }[] = [];
    for (const down of [true, false]) {
      const e = mediaKeyEvent(command, down);
      const ev = o.event(o.cls("NSEvent"), o.sel("otherEventWithType:location:modifierFlags:timestamp:windowNumber:context:subtype:data1:data2:"), e.type, 0, 0, e.flags, 0, 0, 0n, e.subtype, e.data1, e.data2);
      if (!ev) throw new Error("could not create a media key event");
      out.push({ data1: Number(o.i64(ev, o.sel("data1"))), subtype: Number(o.i16(ev, o.sel("subtype"))) });
      if (!dryRun) g.CGEventPost(HID_TAP, Number(o.p(ev, o.sel("CGEvent"))));
    }
    return out;
  });
}

// ---------- CoreAudio: output volume and mute ----------
let ca: any;
function audio() {
  return (ca ??= dlopen(FW("CoreAudio"), {
    AudioObjectGetPropertyData: { args: [T.u32, T.ptr, T.u32, T.ptr, T.ptr, T.ptr], returns: T.i32 },
    AudioObjectSetPropertyData: { args: [T.u32, T.ptr, T.u32, T.ptr, T.u32, T.ptr], returns: T.i32 },
    AudioObjectHasProperty: { args: [T.u32, T.ptr], returns: T.bool },
  }).symbols);
}
const fcc = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
const addr = (selector: string, scope: string) => new Uint32Array([fcc(selector), fcc(scope), 0]);

function outputDevice(): number {
  const a = audio();
  const dev = new Uint32Array(1), size = new Uint32Array([4]);
  const rc = a.AudioObjectGetPropertyData(1, ptr(addr("dOut", "glob")), 0, null, ptr(size), ptr(dev));
  if (rc !== 0 || !dev[0]) throw new Error("no output device");
  return dev[0]!;
}

/** Output volume 0-100 and mute of the default output device; null when it has no software volume. */
export function readVolume(): { level: number; muted: boolean } | null {
  const a = audio();
  const dev = outputDevice();
  const vol = addr("vmvc", "outp");
  if (!a.AudioObjectHasProperty(dev, ptr(vol))) return null;
  const f = new Float32Array(1), size = new Uint32Array([4]);
  if (a.AudioObjectGetPropertyData(dev, ptr(vol), 0, null, ptr(size), ptr(f)) !== 0) return null;
  const mute = addr("mute", "outp");
  const m = new Uint32Array(1);
  size[0] = 4;
  const muted = a.AudioObjectHasProperty(dev, ptr(mute)) && a.AudioObjectGetPropertyData(dev, ptr(mute), 0, null, ptr(size), ptr(m)) === 0 && m[0] !== 0;
  return { level: Math.max(0, Math.min(100, Math.round(f[0]! * 100))), muted };
}

export function setVolume(level: number): void {
  const a = audio();
  const dev = outputDevice();
  const vol = addr("vmvc", "outp");
  if (!a.AudioObjectHasProperty(dev, ptr(vol))) throw new Error("the output device has no software volume");
  const f = new Float32Array([Math.max(0, Math.min(100, level)) / 100]);
  if (a.AudioObjectSetPropertyData(dev, ptr(vol), 0, null, 4, ptr(f)) !== 0) throw new Error("could not set the volume");
}

export function setMuted(muted: boolean): void {
  const a = audio();
  const dev = outputDevice();
  const mute = addr("mute", "outp");
  if (!a.AudioObjectHasProperty(dev, ptr(mute))) throw new Error("the output device cannot be muted");
  const m = new Uint32Array([muted ? 1 : 0]);
  if (a.AudioObjectSetPropertyData(dev, ptr(mute), 0, null, 4, ptr(m)) !== 0) throw new Error("could not change mute");
}

/** volume up/down by 6 points (clamped) or toggle mute, like the media keys' own steps. */
export function volumeStep(command: "up" | "down" | "mute"): void {
  const cur = readVolume();
  if (!cur) throw new Error("the output device has no software volume");
  if (command === "mute") return setMuted(!cur.muted);
  setVolume(cur.level + (command === "up" ? 6 : -6));
}

// ---------- NSWorkspace: which apps run ----------
export function isRunning(bundleId: string): boolean {
  const o = rt();
  return pooled(() => {
    const arr = o.pp(o.cls("NSRunningApplication"), o.sel("runningApplicationsWithBundleIdentifier:"), nsString(bundleId));
    return arr !== 0n && Number(o.u(arr, o.sel("count"))) > 0;
  });
}

// ---------- NSAppleScript in this process (no child process) ----------
const compiled = new Map<string, any>();

/**
 * Runs AppleScript source in-process and returns its text result. Compiled scripts are cached by source, so a poll costs one
 * Apple Event round trip. Apple Events can block (an app that is launching), which is why this only ever runs in the worker.
 */
export function runScript(source: string): string {
  const o = rt();
  return pooled(() => {
    let script = compiled.get(source);
    if (!script) {
      script = o.pp(o.p(o.cls("NSAppleScript"), o.sel("alloc")), o.sel("initWithSource:"), nsString(source));
      if (script === 0n) throw new Error("could not create the script");
      compiled.set(source, script);
      if (compiled.size > 16) compiled.delete(compiled.keys().next().value!);
    }
    const errSlot = new BigUint64Array(1);
    const desc = o.pbuf(script, o.sel("executeAndReturnError:"), ptr(errSlot));
    if (desc === 0n) {
      const dict = errSlot[0]!;
      const msg = dict ? jsString(o.pp(dict, o.sel("objectForKey:"), nsString("NSAppleScriptErrorMessage"))) : "";
      throw new Error(msg || "AppleScript failed");
    }
    return jsString(o.p(desc, o.sel("stringValue")));
  });
}

// ---------- IOKit: GPU utilisation (no ioreg process) ----------
let iok: any;
function iokit() {
  return (iok ??= Object.assign(dlopen(FW("IOKit"), {
    IOServiceMatching: { args: [T.ptr], returns: T.ptr },
    IOServiceGetMatchingServices: { args: [T.u32, T.ptr, T.ptr], returns: T.i32 }, // consumes the matching dictionary
    IOIteratorNext: { args: [T.u32], returns: T.u32 },
    IOObjectRelease: { args: [T.u32], returns: T.i32 },
    // keys travel as u64 ids (an NSString is toll-free bridged to CFString); the result is a +1 CF object, handed back as an id
    IORegistryEntryCreateCFProperty: { args: [T.u32, T.u64, T.ptr, T.u32], returns: T.u64 },
  }).symbols, { cfRelease: dlopen(FW("CoreFoundation"), { CFRelease: { args: [T.u64], returns: T.void } }).symbols.CFRelease as (id: bigint) => void }));
}

/** GPU figures from the IOAccelerator registry entries (every Mac GPU driver publishes PerformanceStatistics); the busiest one wins. */
export function readGpu(): { util: number; memUsed?: number; memTotal?: number; name?: string } | null {
  return pooled(() => {
    const k = iokit();
    const o = rt();
    const iter = new Uint32Array(1);
    if (k.IOServiceGetMatchingServices(0, k.IOServiceMatching(zc("IOAccelerator")), ptr(iter)) !== 0 || !iter[0]) return null;
    const num = (dict: bigint, key: string): number | undefined => {
      const v = o.pp(dict, o.sel("objectForKey:"), nsString(key)) as bigint;
      return v === 0n ? undefined : Number(o.i64(v, o.sel("longLongValue")));
    };
    const isString = (v: bigint) => v !== 0n && !!o.ppb(v, o.sel("isKindOfClass:"), o.cls("NSString"));
    const prop = (entry: number, key: string): bigint => k.IORegistryEntryCreateCFProperty(entry, nsString(key), null, 0) as bigint;
    let best: { util: number; memUsed?: number; memTotal?: number; name?: string } | null = null;
    try {
      for (let e = k.IOIteratorNext(iter[0]); e; e = k.IOIteratorNext(iter[0])) {
        try {
          const stats = prop(e, "PerformanceStatistics");
          if (stats === 0n) continue;
          try {
            const util = num(stats, "Device Utilization %");
            if (util === undefined) continue;
            const g: { util: number; memUsed?: number; memTotal?: number; name?: string } = { util };
            const used = num(stats, "In use system memory") ?? num(stats, "vramUsedBytes");
            if (used !== undefined) g.memUsed = used;
            const free = num(stats, "vramFreeBytes");
            if (g.memUsed !== undefined && free !== undefined) g.memTotal = g.memUsed + free;
            const model = prop(e, "model");
            if (isString(model)) g.name = jsString(model);
            if (model !== 0n) k.cfRelease(model);
            if (!best || g.util > best.util) best = g;
          } finally { k.cfRelease(stats); }
        } finally { k.IOObjectRelease(e); }
      }
    } finally { k.IOObjectRelease(iter[0]); }
    return best;
  });
}

// ---------- ImageIO: any cover (TIFF, PNG, JPEG) -> JPEG of at most `maxPx` ----------
let iio: any;
function imageio() {
  return (iio ??= {
    ...dlopen(FW("ImageIO"), {
      CGImageSourceCreateWithData: { args: [T.u64, T.u64], returns: T.u64 },
      CGImageSourceCreateThumbnailAtIndex: { args: [T.u64, T.u64, T.u64], returns: T.u64 },
      CGImageDestinationCreateWithData: { args: [T.u64, T.u64, T.u64, T.u64], returns: T.u64 },
      CGImageDestinationAddImage: { args: [T.u64, T.u64, T.u64], returns: T.void },
      CGImageDestinationFinalize: { args: [T.u64], returns: T.bool },
    }).symbols,
    ...dlopen(FW("CoreFoundation"), {
      CFDataCreate: { args: [T.ptr, T.ptr, T.i64], returns: T.u64 },
      CFDataCreateMutable: { args: [T.ptr, T.i64], returns: T.u64 },
      CFDataGetLength: { args: [T.u64], returns: T.i64 },
      CFDataGetBytePtr: { args: [T.u64], returns: T.ptr },
      CFRelease: { args: [T.u64], returns: T.void },
    }).symbols,
  });
}

/** Builds an NSDictionary (toll-free CFDictionary) from string keys and already-made objects. */
function nsDict(entries: [string, bigint][]): bigint {
  const o = rt();
  const d = o.p(o.cls("NSMutableDictionary"), o.sel("new")) as bigint;
  for (const [k, v] of entries) o.ppp(d, o.sel("setObject:forKey:"), v, nsString(k));
  return d; // owned by the caller's pool only through `new`+autorelease below
}

/**
 * Decodes base64 image data and re-encodes it as a JPEG no larger than maxPx on its longest side (ImageIO, no child process).
 * Returns the JPEG as base64, or null when the data is not an image.
 */
export function toJpegBase64(b64: string, maxPx = 300, quality = 0.82): string | null {
  const input = Buffer.from(b64, "base64");
  if (input.length < 8) return null;
  return pooled(() => {
    const o = rt();
    const io = imageio();
    const data = io.CFDataCreate(null, ptr(input), input.length) as bigint;
    if (data === 0n) return null;
    const created: bigint[] = [data];
    try {
      const src = io.CGImageSourceCreateWithData(data, 0n) as bigint;
      if (src === 0n) return null;
      created.push(src);
      const opts = nsDict([
        ["kCGImageSourceCreateThumbnailFromImageAlways", o.numBool(o.cls("NSNumber"), o.sel("numberWithBool:"), true)],
        ["kCGImageSourceCreateThumbnailWithTransform", o.numBool(o.cls("NSNumber"), o.sel("numberWithBool:"), true)],
        ["kCGImageSourceThumbnailMaxPixelSize", o.numInt(o.cls("NSNumber"), o.sel("numberWithInt:"), maxPx)],
      ]);
      const image = io.CGImageSourceCreateThumbnailAtIndex(src, 0n, opts) as bigint;
      o.p(opts, o.sel("release"));
      if (image === 0n) return null;
      created.push(image);
      const out = io.CFDataCreateMutable(null, 0) as bigint;
      created.push(out);
      const dest = io.CGImageDestinationCreateWithData(out, nsString("public.jpeg"), 1n, 0n) as bigint;
      if (dest === 0n) return null;
      created.push(dest);
      const props = nsDict([["kCGImageDestinationLossyCompressionQuality", o.numDouble(o.cls("NSNumber"), o.sel("numberWithDouble:"), quality)]]);
      io.CGImageDestinationAddImage(dest, image, props);
      o.p(props, o.sel("release"));
      if (!io.CGImageDestinationFinalize(dest)) return null;
      const len = Number(io.CFDataGetLength(out));
      if (len <= 0) return null;
      return Buffer.from(toArrayBuffer(io.CFDataGetBytePtr(out), 0, len)).toString("base64");
    } finally {
      for (const c of created.reverse()) io.CFRelease(c);
    }
  });
}
