package core

import (
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// UpdateAsk decides when the "new version" window opens: once per version per run for the background check, never again for a
// version the person skipped (remembered in a file), and always for a "Check for updates" they asked for.
type UpdateAsk struct {
	SkipFile string // e.g. ~/.nookdeck/tray-update-skip: the skipped version
	mu       sync.Mutex
	asked    map[string]bool
}

// ShouldAsk reports whether to open the window for version now, and counts it as asked.
func (a *UpdateAsk) ShouldAsk(version string, manual bool) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.asked == nil {
		a.asked = map[string]bool{}
	}
	if !manual && (a.asked[version] || a.skipped(version)) {
		return false
	}
	a.asked[version] = true
	return true
}

func (a *UpdateAsk) skipped(version string) bool {
	b, err := os.ReadFile(a.SkipFile)
	return err == nil && strings.TrimSpace(string(b)) == strings.TrimSpace(version)
}

// Skipped reports whether version is the one the person skipped.
func (a *UpdateAsk) Skipped(version string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.skipped(version)
}

// Skip remembers version so the background check does not ask for it again (a newer version asks again).
func (a *UpdateAsk) Skip(version string) error {
	if err := os.MkdirAll(filepath.Dir(a.SkipFile), 0o755); err != nil {
		return err
	}
	return os.WriteFile(a.SkipFile, []byte(version+"\n"), 0o644)
}

// UpdateDialog is what the "new version" window shows. Manual: this install cannot replace itself (Path says where it runs), so
// the window offers the download page instead of "Install and restart".
type UpdateDialog struct {
	Version string
	Current string
	Manual  bool
	Path    string
}

// UpdateChoices are the answers the window can send back.
var UpdateChoices = map[string]bool{"install": true, "later": true, "skip": true, "download": true}

// AppIcon is the app icon at the top of the update window (copied from apps/shared/icons by build.sh).
//
//go:embed assets/app-128.png
var AppIcon []byte

// UpdatePage is the HTML of the "new version" window: the question, "What's new" (fetched from update/notes), and after Install the
// progress of the download, the check and the install (polled from update/progress).
func UpdatePage(lang string, d UpdateDialog) string {
	tx := map[string]string{
		"title":   T(lang, "update.alert.title", "version", d.Version),
		"later":   T(lang, "update.alert.later"),
		"skip":    T(lang, "update.alert.skip"),
		"version": d.Version,
		"page":    ReleasePage(d.Version),
		"dl":      T(lang, "update.alert.download"),
	}
	for _, k := range []string{"notes.more", "tray.downloading", "tray.size", "tray.sizeUnknown", "tray.checking", "tray.installing", "tray.installingPassword", "tray.done", "tray.failed", "tray.cancelled", "tray.close", "tray.gone"} {
		tx[k] = T(lang, "update."+k, "version", d.Version)
	}
	// the progress view shares the macOS app's words (update.progress.*)
	for _, k := range []string{"progress.heading", "progress.downloading", "progress.checking", "progress.installing", "progress.cancel"} {
		tx[k] = T(lang, "update."+k, "version", d.Version)
	}
	tx["current"] = T(lang, "update.alert.current", "current", d.Current)
	if d.Manual {
		tx["manual"] = T(lang, "update.alert.manualBody", "current", d.Current, "path", d.Path)
		tx["main"], tx["choice"] = T(lang, "update.alert.download"), "download"
	} else {
		tx["main"], tx["choice"] = T(lang, "update.alert.install"), "install"
	}
	b, _ := json.Marshal(tx)
	b = []byte(strings.ReplaceAll(string(b), "<", `\u003c`))
	return strings.ReplaceAll(strings.ReplaceAll(updateHTML, "__LANG__", lang), "__TX__", string(b))
}

const updateHTML = `<!doctype html><html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nookdeck</title>
<style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1c1c1f;--mut:#6e6e78;--soft:#f1f1f4;--line:#e4e4ea;--line2:#c9c9d1;--acc:#2563eb;--acc-fg:#fff;--bad:#c42b1c;--thumb:rgba(0,0,0,.28)}
@media(prefers-color-scheme:dark){:root{--bg:#1f1f23;--fg:#f2f2f5;--mut:#a0a0ab;--soft:#2c2c32;--line:#34343b;--line2:#55555e;--acc:#4c8dff;--bad:#ff8a80;--thumb:rgba(255,255,255,.3)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,"Cantarell","Ubuntu",sans-serif;padding:22px 24px 18px;display:flex;flex-direction:column;gap:16px;-webkit-font-smoothing:antialiased}
header{display:flex;gap:14px;align-items:center}header img{width:48px;height:48px;flex:none}
h1{font-size:17px;font-weight:600;line-height:1.3;margin:0}.mut{color:var(--mut)}p{margin:0}
#manual{font-size:13px}
#notes{display:none;position:relative}
#scroll{max-height:320px;overflow:auto;padding-right:10px}#scroll::-webkit-scrollbar{width:6px}#scroll::-webkit-scrollbar-track{background:transparent}#scroll::-webkit-scrollbar-thumb{background:transparent;border-radius:3px}#scroll:hover::-webkit-scrollbar-thumb,#scroll.moving::-webkit-scrollbar-thumb{background:var(--thumb)}
#notes.fade::after{content:"";position:absolute;left:0;right:0;bottom:0;height:40px;pointer-events:none;background:linear-gradient(to bottom,transparent,var(--bg))}
#notes h2{font-size:14px;font-weight:600;margin:14px 0 2px}#notes h2:first-child{margin-top:0}
#notes h3{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:10px 0 2px}
#notes ul{margin:2px 0 6px;padding-left:1.25em}#notes ul ul{margin:2px 0}#notes li{margin:2px 0;padding-left:.15em}
#notes p{margin:4px 0}#notes a{color:var(--acc);text-decoration:none}#notes a:hover{text-decoration:underline}
#notes code{font:12.5px "Cascadia Mono",Consolas,ui-monospace,"DejaVu Sans Mono",monospace;background:var(--soft);border-radius:4px;padding:1px 4px}
#more{display:none;margin-top:8px}#more a{color:var(--acc);text-decoration:none}
#prog{display:none;flex-direction:column;gap:10px;padding-left:62px}
#steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
#steps li{display:flex;gap:10px;align-items:flex-start}#steps .tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
#steps .lb{color:var(--mut)}#steps .run .lb{color:var(--fg);font-weight:600}#steps .done .lb{color:var(--fg)}#steps .bad .lb{color:var(--bad);font-weight:600}
.mk{position:relative;flex:none;width:16px;height:16px;margin-top:2.5px;border-radius:50%;border:1.5px solid var(--line2)}
.run .mk{border-color:var(--soft);border-top-color:var(--acc);animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.done .mk{background:var(--acc);border-color:var(--acc)}.done .mk::after{content:"";position:absolute;left:4.5px;top:1.5px;width:3.5px;height:7.5px;border:solid var(--acc-fg);border-width:0 1.75px 1.75px 0;transform:rotate(45deg)}
.bad .mk{background:var(--bad);border-color:var(--bad)}.bad .mk::before,.bad .mk::after{content:"";position:absolute;left:6.25px;top:2.5px;width:1.75px;height:8px;background:#fff;transform:rotate(45deg)}.bad .mk::before{transform:rotate(-45deg)}
#sz{font-size:13px}#ind{font-size:13px}
.bar{height:6px;border-radius:3px;background:var(--soft);overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--acc);border-radius:3px;transition:width .25s}
.bar.busy i{width:30%;animation:slide 1.3s ease-in-out infinite}@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
#err{color:var(--bad);font-size:13px}#sz:empty,#err:empty,#ind:empty{display:none}
footer{margin-top:auto;display:flex;gap:8px;align-items:center}
button{font:inherit;color:inherit;border-radius:6px;padding:6px 16px;min-height:32px;cursor:pointer;background:var(--soft);border:1px solid var(--line)}
button:hover{filter:brightness(.97)}@media(prefers-color-scheme:dark){button:hover{filter:brightness(1.15)}}
button.main{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
button.text{background:none;border-color:transparent;color:var(--mut);padding-left:4px;padding-right:4px}button.text:hover{color:var(--fg);filter:none}
button:disabled{opacity:.6;cursor:default}button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.sp{flex:1}
</style></head><body>
<header><img src="update/icon.png" alt=""><div><h1 id="t"></h1><p class="mut" id="b"></p></div></header>
<p class="mut" id="manual"></p>
<div id="notes"><div id="scroll"><div id="secs"></div><p id="more"><a href="#" id="morel"></a></p></div></div>
<div id="prog"><ol id="steps">
<li id="s0"><span class="mk"></span><div class="tx"><span class="lb" id="l0"></span><div class="bar" id="bar"><i id="fill"></i></div><p class="mut" id="sz"></p></div></li>
<li id="s1"><span class="mk"></span><div class="tx"><span class="lb" id="l1"></span></div></li>
<li id="s2"><span class="mk"></span><div class="tx"><span class="lb" id="l2"></span><p class="mut" id="ind"></p></div></li>
</ol><p id="err"></p></div>
<footer id="ask"><button class="text" id="skip"></button><span class="sp"></span><button id="later"></button><button class="main" id="main"></button></footer>
<footer id="crow" style="display:none"><span class="sp"></span><button id="cancel"></button></footer>
<footer id="erow" style="display:none"><span class="sp"></span><button id="close"></button><button class="main" id="dl"></button></footer>
<script>
const TX=__TX__;const $=i=>document.getElementById(i);
const fill=(s,v)=>s.replace(/\{(\w+)\}/g,(m,k)=>k in v?v[k]:m);
$("t").textContent=TX.title;document.title=TX.title;$("b").textContent=TX.current;$("manual").textContent=TX.manual||"";
$("skip").textContent=TX.skip;$("later").textContent=TX.later;$("main").textContent=TX.main;
$("close").textContent=TX["tray.close"];$("cancel").textContent=TX["progress.cancel"];
$("l0").textContent=TX["progress.downloading"];$("l1").textContent=TX["progress.checking"];$("l2").textContent=TX["progress.installing"];$("dl").textContent=TX.dl;$("morel").textContent=TX["notes.more"];
function open(u){fetch("update/open",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:u})}).catch(()=>{});}
$("notes").addEventListener("click",e=>{const a=e.target.closest("a");if(!a)return;e.preventDefault();open(a.id==="morel"?TX.page:a.href);});
$("dl").onclick=()=>{open(TX.page);window.close();};$("close").onclick=()=>window.close();
const sc=$("scroll");let mv=0;function fade(){$("notes").classList.toggle("fade",sc.scrollHeight-sc.clientHeight-sc.scrollTop>4);}sc.addEventListener("scroll",()=>{fade();sc.classList.add("moving");clearTimeout(mv);mv=setTimeout(()=>sc.classList.remove("moving"),900);});addEventListener("resize",fade);
async function notes(){try{const r=await fetch("update/notes");if(!r.ok)return;const n=await r.json();if(!n.sections.length)return;
const box=$("secs");box.textContent="";
for(const s of n.sections){const t=document.createElement("h2");t.textContent="Nookdeck "+s.version+(s.title?": "+s.title:"");box.appendChild(t);const d=document.createElement("div");d.innerHTML=s.html;box.appendChild(d);}
$("more").style.display=n.more?"block":"none";hadNotes=true;if($("prog").style.display!=="flex"){$("notes").style.display="block";fade();}}catch(e){}}
const mb=n=>(n/1048576).toFixed(1);let timer=0;
// the progress view: three steps (download, check, install and restart), each waiting, running, done or failed
let at=0,hadNotes=false;
function show(s){$("ask").style.display="none";$("notes").style.display="none";$("manual").style.display="none";$("prog").style.display="flex";
$("t").textContent=TX["progress.heading"];
const bad=s.stage==="error";
if(s.stage==="checking")at=1;else if(s.stage==="installing")at=2;else if(s.stage==="done")at=3;else if(!bad)at=0;
for(let i=0;i<3;i++)$("s"+i).className=i<at?"done":i===at?(bad?"bad":"run"):"";
const bar=$("bar");bar.style.display=at===0&&!bad?"block":"none";bar.className="bar";$("sz").textContent="";
if(at===0&&!bad){if(s.total>0){$("fill").style.width=Math.min(100,100*s.done/s.total)+"%";$("sz").textContent=fill(TX["tray.size"],{done:mb(s.done),total:mb(s.total)});}
else{bar.className="bar busy";if(s.done>0)$("sz").textContent=fill(TX["tray.sizeUnknown"],{done:mb(s.done)});}}
$("ind").textContent=at===3?TX["tray.done"]:at===2&&s.password?TX["tray.installingPassword"]:"";
$("err").textContent=bad?(s.error==="cancelled"?TX["tray.cancelled"]:fill(TX["tray.failed"],{error:s.error||"?"})):"";
$("crow").style.display=at<=1&&!bad?"flex":"none";$("erow").style.display=bad?"flex":"none";if(bad)clearInterval(timer);}
// Cancel: the tray stops the download and removes its file; the window asks again
$("cancel").onclick=async()=>{$("cancel").disabled=true;let ok=false;try{ok=(await fetch("update/cancel",{method:"POST"})).ok;}catch(e){}
$("cancel").disabled=false;if(!ok)return;clearInterval(timer);at=0;$("prog").style.display="none";$("crow").style.display="none";
$("t").textContent=TX.title;$("manual").style.display="";$("notes").style.display=hadNotes?"block":"none";
document.querySelectorAll("#ask button").forEach(b=>b.disabled=false);$("ask").style.display="flex";$("main").focus();fade();};
async function poll(){try{const r=await fetch("update/progress");if(r.ok)show(await r.json());}catch(e){}} // the tray quits while it installs: the last state stays
function watch(){show({stage:""});poll();timer=setInterval(poll,400);}
async function pick(c){document.querySelectorAll("#ask button").forEach(b=>b.disabled=true);let ok=false;try{const r=await fetch("update/choice",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({choice:c})});ok=r.ok;}catch(e){}
if(c==="install"&&ok){watch();return;}window.close();}
$("skip").onclick=()=>pick("skip");$("later").onclick=()=>pick("later");$("main").onclick=()=>pick(TX.choice);$("main").focus();
// heartbeat: the tray counts this window as open; when the tray is gone (killed, or quit for the installer) the window closes itself:
// after 3 missed pings (about 6 s), or 60 s while it says "Installing" (the installer starts a new tray, which needs no window)
let miss=0,missAt=0;setInterval(async()=>{try{const r=await fetch("update/alive?v="+encodeURIComponent(TX.version));if(r.ok){miss=0;missAt=0;return;}}catch(e){}
miss++;if(!missAt)missAt=Date.now();const inst=$("prog").style.display==="flex"&&$("erow").style.display==="none";if((!inst&&miss>=3)||(inst&&Date.now()-missAt>60000))gone();},2000);
// a window the browser will not let a script close (opened in a normal tab) says so instead of offering buttons that do nothing
function gone(){window.close();setTimeout(()=>{clearInterval(timer);document.body.textContent="";const h=document.createElement("p");h.className="mut";h.style.margin="auto";h.textContent=TX["tray.gone"];document.body.appendChild(h);},500);}
fetch("update/alive?v="+encodeURIComponent(TX.version)).catch(()=>{});
(async()=>{try{const r=await fetch("update/progress");if(r.ok){const s=await r.json();if(s.stage&&s.stage!=="done"){watch();return;}}}catch(e){}notes();})();
</script></body></html>`
