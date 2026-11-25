/**
 * `ctx.widgets.push` inside the plugin host. Pushes of a widget arrive in order. A function push takes time (the tiles are asked for,
 * the function runs per tile), so a widget has at most one push under way and one waiting: a newer push replaces the waiting one. A
 * function that does not finish in time costs its tile this update, never the widget its later ones.
 */
import { CALL_TIMEOUT_MS, type PushUpdate, type WidgetTile, type WidgetUpdate } from "./api";

export interface PushQueueDeps {
  tiles(id: string): Promise<WidgetTile[]>;
  /** With `key`, for that tile alone. */
  send(id: string, update: WidgetUpdate, key?: string): void;
  log(message: string): void;
  /** How long the push function may take for one tile. */
  timeoutMs?: number;
}

const why = (e: any): string => String(e?.message ?? e).slice(0, 200);

function within<T>(ms: number, work: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no result after ${ms / 1000} s`)), ms);
    new Promise<T>((r) => r(work())).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createPushQueue(deps: PushQueueDeps): (id: string, u: PushUpdate) => void {
  const ms = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  /** A widget is here while a push of it is under way; `next` is the one waiting for it. */
  const busy = new Map<string, { next?: PushUpdate }>();

  async function deliver(id: string, u: PushUpdate): Promise<void> {
    if (typeof u !== "function") return deps.send(id, u);
    for (const t of await deps.tiles(id)) {
      try { deps.send(id, await within(ms, () => u({ w: t.size.w, h: t.size.h })), t.key); }
      catch (e) { deps.log(`widgets.push("${id}") failed for a ${t.size.w}x${t.size.h} tile: ${why(e)}`); }
    }
  }

  async function drain(id: string, first: PushUpdate, slot: { next?: PushUpdate }): Promise<void> {
    for (let u: PushUpdate | undefined = first; u !== undefined; u = slot.next, slot.next = undefined) {
      try { await deliver(id, u); }
      catch (e) { deps.log(`widgets.push("${id}") failed: ${why(e)}`); }
    }
    busy.delete(id);
  }

  return (id, u) => {
    const slot = busy.get(id);
    if (slot) { slot.next = u; return; }
    if (typeof u !== "function") return deps.send(id, u);
    const fresh: { next?: PushUpdate } = {};
    busy.set(id, fresh);
    void drain(id, u, fresh);
  };
}
