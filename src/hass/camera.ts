/**
 * Home Assistant camera stills for the phone (spec release 0.5, D7). The agent asks HA's camera_proxy with its own token and
 * passes only the picture on: the phone never sees a Home Assistant token or address.
 */
export const CAMERA_ENTITY_RE = /^camera\.[a-z0-9_]+$/;
export const CAMERA_MAX_BYTES = 8 * 1024 * 1024;
export const CAMERA_TIMEOUT_MS = 10_000;
/** Several phones (or a tile and the large view) asking at once get one picture from HA. */
export const CAMERA_REUSE_MS = 1000;

export interface CameraImage { bytes: Uint8Array; type: string }

export class CameraError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

/** One still from `<base>/api/camera_proxy/<id>`. Redirects are refused so the token cannot follow one elsewhere. */
export async function fetchCamera(f: typeof fetch, base: string, token: string, entityId: string, timeoutMs = CAMERA_TIMEOUT_MS): Promise<CameraImage> {
  let res: Response;
  try { res = await f(`${base}/api/camera_proxy/${entityId}`, { headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw new CameraError("Home Assistant did not send the picture"); }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!res.ok || !/^image\/(jpeg|png|gif|webp)$/.test(type)) {
    await res.body?.cancel().catch(() => {});
    throw new CameraError(res.status === 404 ? "Home Assistant has no such camera" : "Home Assistant did not send the picture", res.status === 404 ? 404 : 502);
  }
  // read with a ceiling: a stream that never ends must not fill the memory
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > CAMERA_MAX_BYTES) { await reader.cancel().catch(() => {}); throw new CameraError("the camera picture is too large"); }
      chunks.push(value);
    }
  } catch (e) { throw e instanceof CameraError ? e : new CameraError("Home Assistant did not send the picture"); }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), type };
}

/** One request per camera at a time, and its picture is reused for a second. */
export function cameraCache(load: (id: string) => Promise<CameraImage>, now: () => number = Date.now) {
  const held = new Map<string, { at: number; image: Promise<CameraImage> }>();
  return (id: string): Promise<CameraImage> => {
    const hit = held.get(id);
    if (hit && (hit.at === 0 || now() - hit.at < CAMERA_REUSE_MS)) return hit.image;
    const entry = { at: 0, image: load(id) };
    held.set(id, entry);
    entry.image.then(() => { entry.at = now(); }, () => { if (held.get(id) === entry) held.delete(id); });
    return entry.image;
  };
}
