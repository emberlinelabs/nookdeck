import "./_fetch";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NOOKDECK_HOME ??= mkdtempSync(join(tmpdir(), "pd-i18n-"));
const I = await import("../src/i18n");
const { defaultLayout } = await import("../src/config");
const { startServer } = await import("../src/server");
const { wmo } = await import("../src/weather");
const { windowLabel } = await import("../src/ai/types");
const { classifyRisk } = await import("../src/risk");

afterAll(() => I.setLanguage("en"));

describe("t()", () => {
  test("English is the default and the key is the text; placeholders fill in", () => {
    I.setLanguage(undefined);
    expect(I.getLanguage()).toBe("en");
    expect(I.t("button {id} not found", { id: "p/x" })).toBe("button p/x not found");
    expect(I.t("a text nobody translated")).toBe("a text nobody translated");
    expect(I.t("kept {missing}", {})).toBe("kept {missing}");
  });
  test("Vietnamese is the extra language; unknown languages fall back to English; missing keys fall back to English", () => {
    I.setLanguage("vi");
    expect(I.t("button {id} not found", { id: "p/x" })).toBe("không thấy nút p/x");
    expect(I.t("a text nobody translated")).toBe("a text nobody translated");
    expect(wmo(0).text).toBe("Trời quang");
    expect(windowLabel(300)).toBe("5 giờ");
    expect(classifyRisk("Bash", { command: "sudo ls" }).reason).toBe("dùng sudo");
    I.setLanguage("fr");
    expect(I.getLanguage()).toBe("en");
    expect(wmo(0).text).toBe("Clear sky");
    expect(windowLabel(300)).toBe("5 hours");
  });
  test("every Vietnamese entry keeps the placeholders of its English key", () => {
    const src = require("node:fs").readFileSync(join(import.meta.dir, "..", "src", "i18n.ts"), "utf8") as string;
    const body = src.slice(src.indexOf("const vi"), src.indexOf("export function translate"));
    const keys = [...body.matchAll(/"((?:[^"\\]|\\.)+)":\s*"((?:[^"\\]|\\.)*)"/g)];
    expect(keys.length).toBeGreaterThan(100);
    for (const [, k, v] of keys) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
      if (/^[a-z_]+\./.test(k!) || k!.includes("{brightness_pct")) continue; // literal braces in a service example
      expect(ph(v!)).toBe(ph(k!));
    }
  });
});

describe("defaults are English", () => {
  test("the default layout has English page and tile names", () => {
    const l = defaultLayout();
    expect(l.pages.map((p) => p.name)).toEqual(["Overview", "AI", "Keys", "Tools"]);
    const labels = l.pages.flatMap((p) => p.items.map((i: any) => i.label).filter(Boolean));
    expect(labels).toContain("Play / Pause");
    expect(JSON.stringify(l)).not.toMatch(/[àáảãạăâèéẻêìíòóỏôơùúủưỳýđ]/i);
  });
});

describe("the language follows layout theme.language", () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let tok: string;
  const original = defaultLayout();
  beforeAll(async () => {
    const q = (id: string) => ({ id, name: id, windows: [], updatedAt: 1 });
    app = await startServer({
      port: 0, pin: "818181", hostName: async () => "my-mac", hookSecret: "s", webhookKeyFile: join(mkdtempSync(join(tmpdir(), "pd-i18n-k-")), "k"), layoutHistoryDir: mkdtempSync(join(tmpdir(), "pd-i18n-h-")),
      askSettingsFile: join(mkdtempSync(join(tmpdir(), "pd-i18n-a-")), "ask.json"),
      deps: { runAction: async () => {}, startStats: () => () => {}, setVolume: async () => {}, readVolume: async () => null, readMedia: async () => null, fetchArtwork: async () => undefined, topProcesses: async () => [] } as any,
      aiSources: { claude: async () => q("claude"), codex: async () => q("codex"), antigravity: async () => q("antigravity"), sessions: async () => [] } as any,
    } as any);
    base = `http://localhost:${app.port}`;
    tok = ((await (await fetch(`${base}/api/pair`, { method: "POST", body: JSON.stringify({ pin: "818181" }) })).json()) as any).token;
  });
  afterAll(async () => {
    await fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify(original) });
    app.stop();
  });

  const answerMissing = () => new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${app.port}/ws?token=${tok}`);
    const t = setTimeout(() => reject(new Error("timeout")), 4000);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "hello") ws.send(JSON.stringify({ type: "question-answer", reqId: "r1", id: "nope", answers: {} }));
      if (m.type === "result" && m.reqId === "r1") { clearTimeout(t); ws.close(); resolve(m.error); }
    };
  });

  test("English by default, Vietnamese after saving theme.language = vi, English again after removing it", async () => {
    expect(await answerMissing()).toBe("question already answered or expired");
    const put = (theme: any) => fetch(`${base}/api/layout`, { method: "PUT", body: JSON.stringify({ ...original, theme }) });
    expect((await put({ ...original.theme, language: "vi" })).status).toBe(200);
    expect(await answerMissing()).toBe("câu hỏi đã được trả lời hoặc hết hạn");
    expect((await put(original.theme)).status).toBe(200);
    expect(await answerMissing()).toBe("question already answered or expired");
  });
});
