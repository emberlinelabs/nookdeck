import { useEffect, useState } from "react";
import { api } from "@/api";
import { asPlatform } from "@/lib/platform";
import type { About } from "@/types";

/** Fetched once; null while loading or when the agent has no /api/about. */
export function useAbout(): About | null {
  const [about, setAbout] = useState<About | null>(null);
  useEffect(() => {
    let live = true;
    api.getAbout().then((a) => live && setAbout(a), () => undefined);
    return () => { live = false; };
  }, []);
  return about;
}

const OS: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
export const osName = (a: About): string | undefined => {
  const p = asPlatform(a.platform);
  return [p ? OS[p] : a.platform, a.arch].filter(Boolean).join(" ") || undefined;
};
/** One line for bug reports: "Nookdeck 0.1.0 (abc1234) · macOS arm64". */
export const aboutLine = (a: About): string => {
  const os = osName(a);
  return `Nookdeck ${a.version}${a.commit ? ` (${a.commit})` : ""}${os ? ` · ${os}` : ""}`;
};
