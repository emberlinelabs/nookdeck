/**
 * The layout message carries every icon the phone cannot draw by itself. With many app icons, uploads or an icon pack it can pass 1 MB,
 * and Safari on iOS 15/16 (its NSURLSession WebSocket) drops a message that big and closes the socket: the deck then loops on
 * "Disconnected / Waiting for layout". Big asset maps therefore go out in parts before the layout.
 */
export const ASSETS_PART_MAX = 256 * 1024;

/** Splits an assets map into maps of at most `max` serialized bytes each (an entry bigger than `max` goes alone). Pure. */
export function splitAssets(assets: Record<string, unknown>, max = ASSETS_PART_MAX): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> = {};
  let size = 0;
  for (const [k, v] of Object.entries(assets)) {
    const n = JSON.stringify(k).length + JSON.stringify(v).length + 2;
    if (size > 0 && size + n > max) { parts.push(cur); cur = {}; size = 0; }
    cur[k] = v;
    size += n;
  }
  if (size > 0) parts.push(cur);
  return parts;
}

/**
 * The serialized messages that deliver a layout, in order. Small asset maps stay inline ({type:"layout", layout, assets}, the
 * protocol every deck understands); bigger ones become {type:"assets", assets} parts followed by {type:"layout", layout, assetParts: n}.
 */
export function layoutFrames(layout: unknown, assets: Record<string, unknown>, max = ASSETS_PART_MAX): string[] {
  const inline = JSON.stringify(assets);
  if (inline.length <= max) return [JSON.stringify({ type: "layout", layout, assets })];
  const parts = splitAssets(assets, max);
  return [...parts.map((p) => JSON.stringify({ type: "assets", assets: p })), JSON.stringify({ type: "layout", layout, assetParts: parts.length })];
}

/** Close codes worth a log line: not a normal close, a going-away, a missing status, an abnormal drop (phone asleep) or our own 4xxx. */
export function unusualClose(code: number): boolean {
  return ![1000, 1001, 1005, 1006].includes(code) && !(code >= 4000 && code < 5000);
}
