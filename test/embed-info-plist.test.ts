import { describe, expect, test } from "bun:test";
import { agentInfoPlist, embedInfoPlist, isMacho64, USAGE } from "../scripts/embed-info-plist";
import { IDENTIFIER } from "../scripts/sign-macos";

/** A tiny Mach-O: __TEXT (one section at `textAt`), __DATA (one section), a symbol table with one symbol in each. */
function macho(textAt = 4096): Buffer {
  const b = Buffer.alloc(textAt + 256);
  const section = (at: number, sect: string, seg: string, offset: number) => { b.write(sect, at, "latin1"); b.write(seg, at + 16, "latin1"); b.writeBigUInt64LE(0x100000000n + BigInt(offset), at + 32); b.writeBigUInt64LE(16n, at + 40); b.writeUInt32LE(offset, at + 48); };
  const segment = (at: number, name: string) => { b.writeUInt32LE(0x19, at); b.writeUInt32LE(152, at + 4); b.write(name, at + 8, "latin1"); b.writeBigUInt64LE(0x100000000n, at + 24); b.writeUInt32LE(1, at + 64); };
  b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(3, 16); b.writeUInt32LE(152 * 2 + 24, 20);
  segment(32, "__TEXT"); section(32 + 72, "__text", "__TEXT", textAt);
  segment(184, "__DATA"); section(184 + 72, "__data", "__DATA", textAt + 64);
  b.writeUInt32LE(0x2, 336); b.writeUInt32LE(24, 340); b.writeUInt32LE(textAt + 128, 344); b.writeUInt32LE(2, 348);
  b[textAt + 128 + 5] = 1; b[textAt + 128 + 16 + 5] = 2;
  return b;
}

/** The sections as a loader would read them. */
function sections(b: Buffer) {
  const out: { name: string; data: string; address: bigint; offset: number }[] = [];
  for (let i = 0, at = 32; i < b.readUInt32LE(16); i++, at += b.readUInt32LE(at + 4)) {
    if (b.readUInt32LE(at) !== 0x19) continue;
    for (let s = 0; s < b.readUInt32LE(at + 64); s++) {
      const h = at + 72 + s * 80, offset = b.readUInt32LE(h + 48);
      out.push({ name: b.toString("latin1", h, h + 16).replace(/\0+$/, ""), address: b.readBigUInt64LE(h + 32), offset, data: b.toString("utf8", offset, offset + Number(b.readBigUInt64LE(h + 40))) });
    }
  }
  return out;
}

describe("the agent's Info.plist", () => {
  const plist = agentInfoPlist(IDENTIFIER, "0.5.1");

  test("it says who asks and why, for Apple events and Bluetooth", () => {
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>dev.nookdeck.agent</string>");
    for (const key of ["NSAppleEventsUsageDescription", "NSBluetoothAlwaysUsageDescription"]) {
      expect(USAGE[key]).toStartWith("Nookdeck ");
      expect(plist).toContain(`<key>${key}</key><string>${USAGE[key]}</string>`);
    }
  });

  test("it becomes __TEXT,__info_plist without moving anything, and only once", () => {
    const before = macho();
    const after = embedInfoPlist(before, Buffer.from(plist));
    expect(after.length).toBe(before.length);
    expect(after.subarray(4096, 4096 + 128).equals(before.subarray(4096, 4096 + 128))).toBe(true);
    const got = sections(after);
    expect(got.map((s) => s.name)).toEqual(["__text", "__info_plist", "__data"]);
    expect(got[1]!.data).toBe(plist);
    expect(got[1]!.address).toBe(0x100000000n + BigInt(got[1]!.offset));
    expect(got[1]!.offset + plist.length).toBeLessThanOrEqual(4096);
    expect([got[0]!.offset, got[2]!.offset]).toEqual([4096, 4160]);
    expect(after.readUInt32LE(20)).toBe(before.readUInt32LE(20) + 80);
    // the symbol of __data now names section 3, the one of __text still 1
    expect([after[4096 + 128 + 5], after[4096 + 128 + 16 + 5]]).toEqual([1, 3]);
    expect(before.readUInt32LE(20)).toBe(328); // the input is not changed
    expect(embedInfoPlist(after, Buffer.from(plist))).toBe(after);
  });

  test("it refuses a program without room, and anything that is not a thin 64-bit Mach-O", () => {
    expect(() => embedInfoPlist(macho(512), Buffer.from(plist))).toThrow("no room");
    expect(isMacho64(Buffer.from("#!/bin/sh\necho hello, this is not a program at all\n"))).toBe(false);
    expect(() => embedInfoPlist(Buffer.alloc(64), Buffer.from(plist))).toThrow("Mach-O");
  });
});
