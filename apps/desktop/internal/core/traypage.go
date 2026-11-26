package core

import (
	"encoding/json"
	"strings"
)

// TrayPage is the "turn the tray on" window (spec linux-support L9, AC-12): shown at start when the desktop has no tray
// (no StatusNotifierWatcher, e.g. Debian GNOME without the AppIndicator extension). It says how to turn the tray on, gives the
// manage page and pairing buttons so the app is usable without a tray, and notices when the tray appears.
func TrayPage(lang, command, manageURL string) string {
	tx := map[string]string{"cmd": command, "manage": manageURL}
	for _, k := range []string{"trayHelp.title", "trayHelp.body", "trayHelp.steps", "trayHelp.command", "trayHelp.copy", "trayHelp.later", "trayHelp.on", "menu.openManage", "menu.pair", "pair.copied"} {
		tx[k] = T(lang, k)
	}
	b, _ := json.Marshal(tx)
	b = []byte(strings.ReplaceAll(string(b), "<", `<`))
	return strings.ReplaceAll(strings.ReplaceAll(trayHTML, "__LANG__", lang), "__TX__", string(b))
}

const trayHTML = `<!doctype html><html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nookdeck</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--mut:#6b6b76;--card:#f3f3f6;--acc:#2f6bff;--ok:#1f8a4c}
@media(prefers-color-scheme:dark){:root{--bg:#17171b;--fg:#f1f1f4;--mut:#9a9aa6;--card:#232329;--ok:#4cc38a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,"Cantarell","Ubuntu",sans-serif;padding:22px 24px;display:flex;flex-direction:column;gap:14px}
h1{font-size:19px;margin:0}p{margin:0}.mut{color:var(--mut)}
.cmd{display:flex;gap:8px;align-items:stretch}code{flex:1;font:13px/1.4 ui-monospace,"DejaVu Sans Mono",monospace;background:var(--card);border-radius:8px;padding:9px 10px;overflow-wrap:anywhere}
button,a.btn{font:inherit;color:inherit;background:var(--card);border:1px solid transparent;border-radius:8px;padding:8px 12px;cursor:pointer;text-decoration:none;text-align:center}
button:hover,a.btn:hover{border-color:var(--acc)}a.btn.main{background:var(--acc);color:#fff}.row{display:flex;gap:8px;flex-wrap:wrap}.row>*{flex:1}
#on{display:none;color:var(--ok);font-weight:600}
</style></head><body>
<h1 id="t"></h1>
<p id="on"></p>
<p id="body"></p>
<p id="steps"></p>
<div><p class="mut" id="cmdl" style="font-size:13px;margin-bottom:4px"></p><div class="cmd"><code id="cmd"></code><button id="copy"></button></div></div>
<p class="mut" id="later"></p>
<div class="row"><a class="btn main" id="pair" href="./"></a><a class="btn" id="manage"></a></div>
<script>
const TX=__TX__;const $=i=>document.getElementById(i);
$("t").textContent=TX["trayHelp.title"];document.title=TX["trayHelp.title"];$("body").textContent=TX["trayHelp.body"];$("steps").textContent=TX["trayHelp.steps"];
$("cmdl").textContent=TX["trayHelp.command"];$("cmd").textContent=TX.cmd;$("copy").textContent=TX["trayHelp.copy"];$("later").textContent=TX["trayHelp.later"];
$("pair").textContent=TX["menu.pair"];$("manage").textContent=TX["menu.openManage"];$("manage").href=TX.manage;$("on").textContent=TX["trayHelp.on"];
$("copy").onclick=async()=>{try{await navigator.clipboard.writeText(TX.cmd);}catch(e){}const b=$("copy");const o=b.textContent;b.textContent=TX["pair.copied"];setTimeout(()=>b.textContent=o,1500);};
async function poll(){try{const r=await fetch("tray/status");if(r.ok){const d=await r.json();$("on").style.display=d.trayOn?"block":"none";}}catch(e){}}
poll();setInterval(poll,5000);
</script></body></html>`
