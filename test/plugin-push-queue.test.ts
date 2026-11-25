import { describe, expect, test } from "bun:test";
import type { PushUpdate, WidgetUpdate } from "../src/plugins/api";
import { createPushQueue } from "../src/plugins/push-queue";

const text = (body: string): WidgetUpdate => ({ render: "text", data: { body } });
const never = () => new Promise<WidgetUpdate>(() => {});

function setup(timeoutMs = 40) {
  const sent: string[] = [], logs: string[] = [];
  let tilesFail = false;
  const push = createPushQueue({
    timeoutMs,
    tiles: async () => { if (tilesFail) throw new Error("agent gone"); return [{ key: "a", size: { w: 2, h: 2 } }, { key: "b", size: { w: 4, h: 4 } }]; },
    send: (id, u, key) => { sent.push(`${id}${key ? `.${key}` : ""} ${(u.data as any).body}`); },
    log: (m) => { logs.push(m); },
  });
  const until = async (ok: () => boolean) => { const end = Date.now() + 3000; while (!ok() && Date.now() < end) await Bun.sleep(5); expect(ok()).toBe(true); };
  return { push, sent, logs, until, failTiles: (v: boolean) => { tilesFail = v; } };
}

describe("widgets.push queue", () => {
  test("a function that never resolves is skipped and logged; later pushes of the widget still arrive", async () => {
    const q = setup();
    q.push("w", never);
    q.push("w", text("after"));
    expect(q.sent).toEqual([]);
    await q.until(() => q.sent.includes("w after"));
    expect(q.sent).toEqual(["w after"]);
    expect(q.logs).toEqual([
      'widgets.push("w") failed for a 2x2 tile: no result after 0.04 s',
      'widgets.push("w") failed for a 4x4 tile: no result after 0.04 s',
    ]);
    q.push("w", text("idle again")); // nothing under way: sent at once
    expect(q.sent.at(-1)).toBe("w idle again");
  });

  test("only the tile that hangs is skipped, and its late result is ignored", async () => {
    const q = setup();
    let late!: (u: WidgetUpdate) => void;
    q.push("w", (tile) => (tile.w === 2 ? new Promise<WidgetUpdate>((r) => { late = r; }) : text("big")));
    await q.until(() => q.sent.includes("w.b big"));
    late(text("too late"));
    await Bun.sleep(10);
    expect(q.sent).toEqual(["w.b big"]);
  });

  test("a widget keeps only the newest waiting push; other widgets are not held up", async () => {
    const q = setup();
    const called: number[] = [];
    q.push("w", never);
    for (let i = 0; i < 500; i++) q.push("w", () => { called.push(i); return text(`n${i}`); });
    q.push("other", text("free"));
    expect(q.sent).toEqual(["other free"]);
    await q.until(() => q.sent.length === 3);
    await Bun.sleep(20);
    expect(q.sent).toEqual(["other free", "w.a n499", "w.b n499"]);
    expect(called).toEqual([499, 499]);
  });

  test("a throw, a rejection and a failed tile list do not stop the queue", async () => {
    const q = setup();
    const bad: PushUpdate = (tile) => { if (tile.w === 2) throw new Error("sync"); return Promise.reject(new Error("async")); };
    q.push("w", bad);
    q.push("w", text("one"));
    await q.until(() => q.sent.includes("w one"));
    expect(q.logs.map((l) => l.split(": ")[1])).toEqual(["sync", "async"]);
    q.failTiles(true);
    q.push("w", () => text("unused"));
    q.push("w", text("two"));
    await q.until(() => q.sent.includes("w two"));
    expect(q.logs.at(-1)).toBe('widgets.push("w") failed: agent gone');
  });
});
