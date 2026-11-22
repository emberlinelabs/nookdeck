import { definePlugin } from "@nookdeck/plugin";

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const KEEP = 120; // points kept for the chart

export default definePlugin({
  activate(ctx) {
    // One request per repository per refresh, shared by both widgets.
    const stars = async (repo: string): Promise<number> => {
      if (!REPO_RE.test(repo)) throw new Error("Repository must look like owner/name");
      const token = ctx.settings.get().token;
      const res = await ctx.net.fetch(`https://api.github.com/repos/${repo}`, {
        headers: { Accept: "application/vnd.github+json", ...(typeof token === "string" && token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { stargazers_count?: number };
      return Number(body.stargazers_count ?? 0);
    };

    ctx.widgets.provide("stars", async (s) => {
      const repo = String(s.repo ?? "");
      const value = await stars(repo);
      // The history is written by the "history" widget; the stat only reads it, so the "spark" style has a trend to draw.
      const old = ((await ctx.storage.get(`history:${repo}`)) as number[] | undefined) ?? [];
      const points = [...old, value].slice(-60);
      return { render: "stat", data: { value, label: repo, ...(points.length > 1 ? { points } : {}) } };
    }, { every: 300 });

    ctx.widgets.provide("history", async (s) => {
      const repo = String(s.repo ?? "");
      const now = await stars(repo);
      const key = `history:${repo}`;
      const old = ((await ctx.storage.get(key)) as number[] | undefined) ?? [];
      const points = [...old, now].slice(-KEEP);
      await ctx.storage.set(key, points);
      return { render: "chart", data: { points, label: repo, unit: "stars" } };
    }, { every: 900 });
  },
});
