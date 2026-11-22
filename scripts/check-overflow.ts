// Scans the phone deck for tile content that overflows or is clipped, at 8 screen sizes x 2 orientations x every page.
// Needs a running agent and Chrome (playwright-core). It pairs a temporary device and deletes it at the end.
//   PD_BASE=http://127.0.0.1:7420 bun scripts/check-overflow.ts <dir for screenshots>
// "pd-dg__c" hits are the rolling-digit animation, not a real overflow.
import { chromium } from "playwright-core";
const B = process.env.PD_BASE || "http://127.0.0.1:7420";
const OUT = process.argv[2]!; // dir for screenshots of failing tiles
const SIZES: [string, number, number][] = [["5s", 568, 320], ["se2", 667, 375], ["iphone", 844, 390], ["promax", 932, 430], ["android-s", 640, 360], ["android", 915, 412], ["ipad-mini", 1133, 744], ["ipad", 1180, 820]];
const pin = (await (await fetch(B + "/api/pairing")).json()).pin;
const r = await (await fetch(B + "/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin, name: "pd-overflow-probe" }) })).json();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const all: any[] = [];
try {
  for (const [name, W, H] of SIZES) for (const orient of ["land", "port"]) {
    const [w, h] = orient === "land" ? [W, H] : [H, W];
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.addInitScript(([t, d]) => { localStorage.setItem("pd.token", t); localStorage.setItem("pd.deviceId", d); }, [r.token, r.deviceId]);
    const page = await ctx.newPage(); await page.goto(B + "/"); await page.waitForSelector(".pd-tile"); await page.waitForTimeout(1500);
    const n = await page.evaluate(() => document.querySelectorAll(".pd-page").length);
    for (let k = 0; k < n; k++) {
      await page.evaluate((k) => { const p = document.querySelector(".pd-pager") as HTMLElement; if (p.scrollWidth > p.clientWidth) p.scrollLeft = p.clientWidth * k; else p.scrollTop = p.clientHeight * k; }, k);
      await page.waitForTimeout(700);
      const found = await page.evaluate((k) => {
        const pg = document.querySelectorAll(".pd-page")[k] as HTMLElement; const pname = document.querySelector(".pd-pagename")?.textContent || String(k);
        const res: any[] = [];
        pg.querySelectorAll(".pd-tile").forEach((tile, ti) => {
          const T = tile.getBoundingClientRect(); if (T.width < 2) return;
          const label = (tile.getAttribute("data-id") || tile.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
          const issues: string[] = [];
          tile.querySelectorAll("*").forEach((el) => {
            const e = el as HTMLElement; const cs = getComputedStyle(e);
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return;
            const R = e.getBoundingClientRect(); if (R.width < 1 || R.height < 1) return;
            const leaf = e.children.length === 0 || e.tagName === "svg" || e.tagName === "IMG";
            if (!leaf) { // text clipped inside its own box without ellipsis
              if (e.childNodes.length && [...e.childNodes].some((c) => c.nodeType === 3 && c.textContent!.trim()) && cs.overflow === "hidden" && cs.textOverflow !== "ellipsis" && (e.scrollHeight > e.clientHeight + 2)) issues.push("vclip:" + e.className + " '" + e.textContent!.trim().slice(0, 25) + "'");
              return;
            }
            const out = Math.max(T.left - R.left, R.right - T.right, T.top - R.top, R.bottom - T.bottom);
            if (out > 2 && !(e.closest("svg") && e.tagName !== "svg")) issues.push(`out${Math.round(out)}px:${e.tagName.toLowerCase()}.${(typeof e.className === "string" ? e.className : "").split(" ")[0]} '${(e.textContent || "").trim().slice(0, 25)}'`);
            if (e.textContent && e.textContent.trim() && cs.textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 2 && cs.overflow !== "visible") issues.push("hclip:" + e.className + " '" + e.textContent.trim().slice(0, 25) + "'");
          });
          if (issues.length) res.push({ page: pname, tile: ti, label, w: Math.round(T.width), h: Math.round(T.height), issues: [...new Set(issues)].slice(0, 4) });
        });
        return res;
      }, k);
      for (const f of found) { all.push({ size: `${name} ${orient} ${w}x${h}`, ...f }); }
      if (found.length) await page.screenshot({ path: `${OUT}/${name}-${orient}-p${k}.png` });
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  await fetch(B + "/api/devices/" + r.deviceId, { method: "DELETE", headers: { "x-nookdeck": "1", "content-type": "application/json" } });
}
for (const f of all) console.log(`${f.size} | ${f.page} | #${f.tile} ${f.w}x${f.h} "${f.label}" | ${f.issues.join(" ; ")}`);
console.log("TOTAL", all.length);
