// The agent is a bare program that launchd runs, so macOS holds it responsible for what it and its children (plugin
// commands such as osascript) ask for. It looks for the "why" text of a privacy prompt in the responsible program's own
// Info.plist, which a bare program carries as the section __TEXT,__info_plist. `bun build --compile` adds none, so
// this writes one into the empty space after the load commands, before the code is signed. No byte of the program moves.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Why Nookdeck asks, in the words macOS shows under its prompt. */
export const USAGE: Record<string, string> = {
  NSAppleEventsUsageDescription: "Nookdeck controls other apps on this Mac for your deck: what is playing, appearance, and the actions of your plugins.",
  NSBluetoothAlwaysUsageDescription: "Nookdeck reads the battery levels of your connected Bluetooth devices to show them on your deck.",
};

export function agentInfoPlist(identifier: string, version: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const keys: Record<string, string> = {
    CFBundleIdentifier: identifier, CFBundleName: "Nookdeck", CFBundleInfoDictionaryVersion: "6.0",
    CFBundleShortVersionString: version, CFBundleVersion: version, ...USAGE,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${Object.entries(keys).map(([k, v]) => `  <key>${k}</key><string>${esc(v)}</string>`).join("\n")}
</dict>
</plist>
`;
}

const MH_MAGIC_64 = 0xfeedfacf, LC_SEGMENT_64 = 0x19, LC_SYMTAB = 0x2;
const HEADER = 32, SEGMENT = 72, SECTION = 80, NLIST = 16;
/** codesign adds its own load command (16 bytes) after ours. */
const SPARE = 32;

export const isMacho64 = (b: Buffer): boolean => b.length > HEADER && b.readUInt32LE(0) === MH_MAGIC_64;

/**
 * A copy of a thin 64-bit Mach-O program with `plist` as __TEXT,__info_plist; the program itself when it has one already.
 * The program must be unsigned (or about to be signed again). Throws when there is no room.
 */
export function embedInfoPlist(program: Buffer, plist: Buffer): Buffer {
  if (!isMacho64(program)) throw new Error("not a thin 64-bit Mach-O program");
  const b = Buffer.from(program);
  const ncmds = b.readUInt32LE(16), sizeofcmds = b.readUInt32LE(20);
  const name = (at: number) => b.toString("latin1", at, at + 16).replace(/\0+$/, "");
  let text = -1, symtab = -1, sections = 0, textLast = 0, firstData = Infinity;
  for (let i = 0, at = HEADER; i < ncmds; i++, at += b.readUInt32LE(at + 4)) {
    const cmd = b.readUInt32LE(at);
    if (cmd === LC_SYMTAB) symtab = at;
    if (cmd !== LC_SEGMENT_64) continue;
    const n = b.readUInt32LE(at + 64);
    sections += n;
    if (name(at + 8) !== "__TEXT") continue;
    text = at;
    textLast = sections; // section numbers count through the segments, from 1
    for (let s = 0; s < n; s++) {
      const head = at + SEGMENT + s * SECTION;
      if (name(head) === "__info_plist") return program;
      const offset = b.readUInt32LE(head + 48);
      if (offset) firstData = Math.min(firstData, offset);
    }
  }
  if (text < 0 || firstData === Infinity) throw new Error("no __TEXT segment with sections");
  const end = HEADER + sizeofcmds;
  const offset = Math.floor((firstData - plist.length) / 16) * 16;
  if (offset < end + SECTION + SPARE || b.subarray(end, firstData).some((x) => x !== 0)) throw new Error("no room for the Info.plist after the load commands");
  if (sections >= 255) throw new Error("too many sections");

  const cmdsize = b.readUInt32LE(text + 4);
  const insert = text + cmdsize;
  b.copyWithin(insert + SECTION, insert, end); // the later load commands move up into the empty space
  b.fill(0, insert, insert + SECTION);
  b.write("__info_plist", insert, "latin1");
  b.write("__TEXT", insert + 16, "latin1");
  b.writeBigUInt64LE(b.readBigUInt64LE(text + 24) + BigInt(offset) - b.readBigUInt64LE(text + 40), insert + 32); // address
  b.writeBigUInt64LE(BigInt(plist.length), insert + 40);
  b.writeUInt32LE(offset, insert + 48);
  b.writeUInt32LE(4, insert + 52); // aligned to 2^4
  b.writeUInt32LE(cmdsize + SECTION, text + 4);
  b.writeUInt32LE(b.readUInt32LE(text + 64) + 1, text + 64);
  b.writeUInt32LE(sizeofcmds + SECTION, 20);
  plist.copy(b, offset);

  // symbols name their section by number, and every section after __TEXT's now has the next one
  if (symtab >= 0) {
    const at = symtab >= insert ? symtab + SECTION : symtab;
    const symoff = b.readUInt32LE(at + 8), nsyms = b.readUInt32LE(at + 12);
    for (let i = 0; i < nsyms; i++) {
      const sect = symoff + i * NLIST + 5;
      if (b[sect]! > textLast) b[sect] = b[sect]! + 1;
    }
  }
  return b;
}

export const packageVersion = (): string => JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version;
