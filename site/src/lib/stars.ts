// Build-time only: the star count is baked into the HTML, so visitors never call GitHub.
let cached: Promise<number | null> | undefined;

export function getStars(): Promise<number | null> {
  cached ??= (async () => {
    try {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const res = await fetch('https://api.github.com/repos/howznguyen/nookdeck', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nookdeck-site-build', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const n = (await res.json()).stargazers_count;
      return typeof n === 'number' && n >= 0 ? n : null;
    } catch {
      return null;
    }
  })();
  return cached;
}

/** 45 -> "45", 999 -> "999", 1234 -> "1.2k", 12500 -> "12.5k". */
export function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = Math.floor(n / 100) / 10;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}
