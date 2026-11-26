/**
 * Phone WebSocket check: finds out why a phone shows "Disconnected / Waiting for layout".
 *
 * Runs on the computer that runs Nookdeck:
 *   nookdeck phone-check                 (0.5.3 and later)
 *   BUN_BE_BUN=1 ~/.nookdeck/bin/nookdeck phone-check.ts      (older versions, macOS: this file on its own, no Bun install needed)
 *   $env:BUN_BE_BUN=1; & "$env:LOCALAPPDATA\Nookdeck\bin\nookdeck.exe" phone-check.ts      (older versions, Windows)
 * Options: --port N (test page, default 7431; N+1 is used too), --agent-port N (default 7420).
 * Everything printed is also written to ~/.nookdeck/logs/phone-check.log, to send to the developer.
 *
 * 1. Reports the agent version and how big the "layout" message is (the layout plus every icon it carries).
 * 2. Serves a test page. Open it in the phone's browser: it opens WebSockets that receive one message of a growing size,
 *    with permessage-deflate off, negotiated but unused (what the agent does today), and negotiated with compressed
 *    frames, and reports which sizes arrive and the close code of those that do not. Results show on the phone and here.
 *
 * Self-contained on purpose (no imports from src/): it can be sent to someone as a single file.
 */
import { networkInterfaces, homedir, platform } from "node:os";
import { join } from "node:path";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const HOME = process.env.NOOKDECK_HOME ?? join(homedir(), ".nookdeck");
let PORT = 7431;
let AGENT = 7420;
let LOG = "";
/** Prints a line and appends it to the log file (best effort). */
const log = (line = "") => {
  console.log(line);
  try { if (LOG) appendFileSync(LOG, line + "\n"); } catch {}
};
const KB = 1024;
const SIZES = [16 * KB, 256 * KB, 512 * KB, 900 * KB, 1000 * KB, 1100 * KB, 2048 * KB, 4096 * KB];

const fmt = (n: number) => (n >= 1024 * KB ? (n / 1024 / KB).toFixed(2) + " MB" : Math.round(n / KB) + " KB");

// ---------- 1. the agent and its layout message ----------

let layoutBytes = 0;
async function agentReport() {
  log(`Nookdeck phone WebSocket check (${platform()}, Bun ${Bun.version})\n`);
  try {
    const r = await fetch(`http://127.0.0.1:${AGENT}/api/doctor`, { headers: { "x-nookdeck": "1" }, signal: AbortSignal.timeout(15000) });
    const d: any = await r.json().catch(() => ({}));
    log(`Agent:   ${d.version ? "Nookdeck " + d.version : "answered " + r.status} on port ${AGENT}`);
  } catch {
    log(`Agent:   no Nookdeck agent answered on port ${AGENT} (start it, or pass --agent-port N)`);
  }
  let layout: unknown;
  try {
    layout = JSON.parse(await Bun.file(join(HOME, "layout.json")).text());
  } catch {
    log(`Layout:  cannot read ${join(HOME, "layout.json")}`);
    return;
  }
  const layoutLen = JSON.stringify(layout).length;
  try {
    const r = await fetch(`http://127.0.0.1:${AGENT}/api/layout/assets`, {
      method: "POST", headers: { "content-type": "application/json", "x-nookdeck": "1" }, body: JSON.stringify({ layout }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const text = await r.text();
    const assets = JSON.parse(text) as Record<string, unknown>;
    layoutBytes = layoutLen + text.length + 40;
    const biggest = Object.entries(assets).map(([k, v]) => [k, JSON.stringify(v).length] as const).sort((a, b) => b[1] - a[1]).slice(0, 5);
    log(`Layout:  the "layout" message is about ${fmt(layoutBytes)} (layout ${fmt(layoutLen)}, ${Object.keys(assets).length} icons ${fmt(text.length)})`);
    if (biggest.length) log(`         biggest icons: ${biggest.map(([k, n]) => `${k} ${fmt(n)}`).join(", ")}`);
  } catch (e: any) {
    layoutBytes = layoutLen;
    log(`Layout:  ${fmt(layoutLen)} without icons (the agent did not return the icons: ${e?.message ?? e})`);
  }
}

// ---------- 2. the test servers ----------

interface Result { mode: string; size: number; ok: boolean; got?: number; code?: number; reason?: string; ms?: number }
const results: Result[] = [];
let ua = "";

const pad = (n: number) => {
  const head = '{"type":"big","pad":"';
  const tail = '"}';
  return head + "x".repeat(Math.max(0, n - head.length - tail.length)) + tail;
};

type WsData = { size: number; compress: boolean };
const websocket = (deflate: boolean) => ({
  perMessageDeflate: deflate,
  open(ws: any) {
    const d = ws.data as WsData;
    ws.send(pad(d.size), d.compress);
    ws.send('{"type":"after"}', d.compress);
  },
  message() {},
  close() {},
});
const upgrade = (req: Request, server: any) => {
  const u = new URL(req.url);
  const size = Math.min(16 * 1024 * KB, Math.max(64, Number(u.searchParams.get("size")) || 1024));
  return server.upgrade(req, { data: { size, compress: u.searchParams.get("compress") === "1" } });
};

function summary() {
  log("\nResult:");
  const modes = ["deflate off", "deflate unused", "deflate on"];
  const largestOk = (m: string) => Math.max(0, ...results.filter((r) => r.mode === m && r.ok && SIZES.includes(r.size)).map((r) => r.size));
  const firstFail = (m: string) => Math.min(Infinity, ...results.filter((r) => r.mode === m && !r.ok && SIZES.includes(r.size)).map((r) => r.size));
  for (const m of modes) {
    const f = firstFail(m);
    log(`  ${m.padEnd(16)} ${f === Infinity ? "every size arrived" : `largest that arrived: ${fmt(largestOk(m))}, first failure: ${fmt(f)}`}`);
  }
  const real = results.filter((r) => r.mode === "deflate unused" && r.size === layoutBytes)[0];
  if (layoutBytes) log(`  this layout (${fmt(layoutBytes)}) as the agent sends it: ${real ? (real.ok ? "arrived" : `FAILED (close ${real.code ?? "?"})`) : "not tested"}`);
  const offOk = firstFail("deflate off") === Infinity;
  const unusedOk = firstFail("deflate unused") === Infinity;
  if (real && !real.ok) log("\n=> The phone cannot receive this layout message: that is why it shows Disconnected. Send this output to the developer.");
  else if (offOk && !unusedOk) log("\n=> Negotiating permessage-deflate breaks this browser. Send this output to the developer.");
  else if (!offOk) log(`\n=> This browser drops WebSocket messages from ${fmt(firstFail("deflate off"))}. A layout message that big will not arrive.`);
  else log("\n=> WebSockets of every size work from this phone. Check that the phone opens the right address (the computer's current IP) and is on the same network.");
  log("\nYou can close the page and press Ctrl+C here.");
}

function page(): string {
  const sizes = SIZES.concat(layoutBytes && SIZES.indexOf(layoutBytes) < 0 ? [layoutBytes] : []).sort((a, b) => a - b);
  // ES5 only: the page must run on old iPhones too (no arrow functions, template strings, let/const or fetch)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nookdeck WebSocket check</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;margin:16px;background:#0b0d10;color:#e6e6e6}h1{font-size:18px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:4px 6px;border-bottom:1px solid #222;text-align:left}
.ok{color:#4ade80}.bad{color:#f87171}#ua{color:#888;font-size:12px;word-break:break-all}</style></head><body>
<h1>Nookdeck WebSocket check</h1><div id="ua"></div><p id="st">Running...</p>
<table><thead><tr><th>Mode</th><th>Size</th><th>Result</th></tr></thead><tbody id="rows"></tbody></table>
<script>
var PORT=${PORT}, SIZES=${JSON.stringify(sizes)}, LAYOUT=${layoutBytes};
var MODES=[{name:"deflate off",port:PORT,c:0},{name:"deflate unused",port:PORT+1,c:0},{name:"deflate on",port:PORT+1,c:1}];
function post(o){var x=new XMLHttpRequest();x.open("POST","/report",true);x.setRequestHeader("content-type","application/json");x.send(JSON.stringify(o));}
function fmt(n){return n>=1048576?(n/1048576).toFixed(2)+" MB":Math.round(n/1024)+" KB";}
document.getElementById("ua").textContent=navigator.userAgent;post({ua:navigator.userAgent});
var jobs=[];for(var m=0;m<MODES.length;m++)for(var s=0;s<SIZES.length;s++)jobs.push({mode:MODES[m],size:SIZES[s]});
function row(r){var tr=document.createElement("tr");tr.innerHTML="<td>"+r.mode+(r.size===LAYOUT?" (this layout)":"")+"</td><td>"+fmt(r.size)+"</td><td class="+(r.ok?"ok":"bad")+">"+(r.ok?"ok "+r.ms+" ms":"failed, close "+(r.code===undefined?"?":r.code)+(r.reason?" "+r.reason:"")+(r.got?", got "+fmt(r.got):""))+"</td>";document.getElementById("rows").appendChild(tr);}
function run(i){
  if(i>=jobs.length){document.getElementById("st").textContent="Done. The results are also printed on the computer.";post({done:true});return;}
  var j=jobs[i],t0=Date.now(),big=0,finished=false,ws;
  document.getElementById("st").textContent="Testing "+j.mode.name+" "+fmt(j.size)+" ("+(i+1)+"/"+jobs.length+")";
  function end(r){if(finished)return;finished=true;clearTimeout(timer);try{ws.onclose=null;ws.close();}catch(e){}r.mode=j.mode.name;r.size=j.size;row(r);post({result:r});setTimeout(function(){run(i+1);},300);}
  var timer=setTimeout(function(){end({ok:false,reason:"timeout",got:big});},15000);
  try{ws=new WebSocket("ws://"+location.hostname+":"+j.mode.port+"/ws?size="+j.size+"&compress="+j.mode.c);}catch(e){end({ok:false,reason:String(e)});return;}
  ws.onmessage=function(ev){var d=String(ev.data);if(d.indexOf('{"type":"big"')===0)big=d.length;else if(d.indexOf('{"type":"after"')===0)end({ok:big===j.size,got:big,ms:Date.now()-t0,reason:big===j.size?"":"big message missing or cut"});};
  ws.onclose=function(ev){end({ok:false,code:ev.code,reason:ev.reason||"",got:big});};
}
run(0);
</script></body></html>`;
}

/** Runs the check; resolves only when the user stops it (Ctrl+C), so a caller never goes on to start the agent. */
export async function runPhoneCheck(argv: string[]): Promise<never> {
  const arg = (name: string, def: number) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isInteger(v) && v > 0 && v < 65535 ? v : def;
  };
  PORT = arg("--port", 7431);
  AGENT = arg("--agent-port", 7420);
  try {
    mkdirSync(join(HOME, "logs"), { recursive: true });
    LOG = join(HOME, "logs", "phone-check.log");
    writeFileSync(LOG, `# ${new Date().toISOString()}\n`);
  } catch { LOG = ""; }
  const plain = Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    websocket: websocket(false),
    async fetch(req, server) {
      const u = new URL(req.url);
      if (u.pathname === "/ws") return upgrade(req, server) ? undefined : new Response("upgrade failed", { status: 400 });
      if (u.pathname === "/report" && req.method === "POST") {
        const r = (await req.json().catch(() => null)) as any;
        if (r?.ua) { ua = String(r.ua); log(`\nPhone:   ${ua}`); }
        if (r?.result) {
          const x = r.result as Result;
          results.push(x);
          log(`  ${x.mode.padEnd(16)} ${fmt(x.size).padStart(8)}  ${x.ok ? "ok" : `FAILED (close ${x.code ?? "?"}${x.reason ? " " + x.reason : ""}${x.got ? ", got " + fmt(x.got) : ""})`}${x.ms ? `  ${x.ms} ms` : ""}`);
        }
        if (r?.done) summary();
        return new Response("ok");
      }
      if (u.pathname === "/") return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      return new Response("not found", { status: 404 });
    },
  });
  const deflate = Bun.serve({
    port: PORT + 1,
    hostname: "0.0.0.0",
    websocket: websocket(true),
    fetch(req, server) {
      return new URL(req.url).pathname === "/ws" && upgrade(req, server) ? undefined : new Response("not found", { status: 404 });
    },
  });

  await agentReport();
  const ips = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address);
  log(`\nOpen this on the phone (same Wi-Fi as this computer), in the browser the deck uses:`);
  for (const ip of ips) log(`  http://${ip}:${PORT}/`);
  log(`(ports ${PORT} and ${PORT + 1}; press Ctrl+C to stop)`);
  if (LOG) log(`(this output is saved in ${LOG})`);
  process.on("SIGINT", () => { plain.stop(true); deflate.stop(true); process.exit(0); });
  return new Promise<never>(() => {});
}

if (import.meta.main) await runPhoneCheck(process.argv.slice(2));
