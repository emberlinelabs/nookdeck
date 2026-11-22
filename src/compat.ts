/**
 * Compatibility with the old name (PhoneDesk). Imported first by config.ts and index.ts: every PHONEDESK_* variable that
 * is set while its NOOKDECK_* twin is not becomes the twin, so the rest of the code only ever reads NOOKDECK_*.
 */
export const LEGACY_PREFIX = "PHONEDESK_";
export const PREFIX = "NOOKDECK_";

export function applyLegacyEnv(env: Record<string, string | undefined> = process.env): string[] {
  const used: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith(LEGACY_PREFIX) || v === undefined) continue;
    const next = PREFIX + k.slice(LEGACY_PREFIX.length);
    if (env[next] === undefined) { env[next] = v; used.push(k); }
  }
  return used;
}

applyLegacyEnv();
