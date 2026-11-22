import { definePlugin } from "@nookdeck/plugin";

export default definePlugin({
  activate(ctx) {
    ctx.widgets.provide("status", async (s) => {
      const url = String(s.url ?? "");
      const slow = Number(s.slowMs ?? 1500);
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      const t0 = Date.now();
      try {
        const res = await ctx.net.fetch(url, { method: "HEAD" });
        const ms = Date.now() - t0;
        const state = !res.ok ? "error" : ms > slow ? "warn" : "ok";
        return { render: "status", data: { state, label: `${host} · ${res.status} · ${ms} ms` } };
      } catch (e) {
        ctx.log("check failed", host, String(e));
        return { render: "status", data: { state: "error", label: `${host} · no answer` } };
      }
    }, { every: 60 });
  },
});
