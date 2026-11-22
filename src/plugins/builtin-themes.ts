/** Theme packs that ship inside the binary (offline, the default, not removable): themes/builtin/<name>/, embedded with static imports. */
import nookdeckPack from "../../themes/builtin/nookdeck/nookdeck.json";
import classicPack from "../../themes/builtin/nookdeck-classic/nookdeck.json";
import nookdeckCss from "../../themes/builtin/nookdeck/theme.css" with { type: "text" };
import type { Files } from "./store";

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

/** One entry per built-in pack: its files (manifest, and any text file such as theme.css). */
export const BUILTIN_THEMES: Files[] = [
  new Map<string, Uint8Array>([["nookdeck.json", enc(classicPack)]]),
  new Map<string, Uint8Array>([["nookdeck.json", enc(nookdeckPack)], ["theme.css", new TextEncoder().encode(nookdeckCss)]]),
];
