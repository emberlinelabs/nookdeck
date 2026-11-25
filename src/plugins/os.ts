/** The manifest's `os` (spec release 0.5, D3): which computers a plugin works on. Missing = every one. No imports on purpose. */
export const PLUGIN_OSES = ["darwin", "win32", "linux"] as const;
export type PluginOs = (typeof PLUGIN_OSES)[number];
export const OS_NAMES: Record<PluginOs, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The list in a fixed order and without repeats, or undefined when `v` is not a non-empty list of known systems. */
export function cleanOs(v: unknown): PluginOs[] | undefined {
  if (!Array.isArray(v) || !v.length || !v.every((x) => (PLUGIN_OSES as readonly unknown[]).includes(x))) return undefined;
  return PLUGIN_OSES.filter((x) => v.includes(x));
}

/** Why a plugin cannot run on `platform`, or undefined when it can. */
export function osReason(os: readonly PluginOs[] | undefined, platform: string): string | undefined {
  if (!os || (os as readonly string[]).includes(platform)) return undefined;
  const names = os.map((x) => OS_NAMES[x]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `This plugin works on ${list} only`;
}
