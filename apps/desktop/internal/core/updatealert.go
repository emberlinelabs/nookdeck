package core

import (
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

// UpdatePage is the HTML of the "new version" window.
func UpdatePage(lang string, d UpdateDialog) string {
	tx := map[string]string{
		"title": T(lang, "update.alert.title", "version", d.Version),
		"later": T(lang, "update.alert.later"),
		"skip":  T(lang, "update.alert.skip"),
	}
	if d.Manual {
		tx["body"] = T(lang, "update.alert.manualBody", "current", d.Current, "path", d.Path)
		tx["main"], tx["choice"] = T(lang, "update.alert.download"), "download"
	} else {
		tx["body"] = T(lang, "update.alert.body", "current", d.Current)
		tx["main"], tx["choice"] = T(lang, "update.alert.install"), "install"
	}
	b, _ := json.Marshal(tx)
	b = []byte(strings.ReplaceAll(string(b), "<", `<`))
	return strings.ReplaceAll(strings.ReplaceAll(updateHTML, "__LANG__", lang), "__TX__", string(b))
}

const updateHTML = `<!doctype html><html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nookdeck</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--mut:#6b6b76;--card:#f3f3f6;--acc:#2f6bff}
@media(prefers-color-scheme:dark){:root{--bg:#17171b;--fg:#f1f1f4;--mut:#9a9aa6;--card:#232329}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,"Segoe UI","Cantarell","Ubuntu",sans-serif;padding:22px 24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:19px;margin:0}p{margin:0;color:var(--mut)}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}button{font:inherit;color:inherit;background:var(--card);border:1px solid transparent;border-radius:8px;padding:8px 14px;cursor:pointer}
button:hover{border-color:var(--acc)}button.main{background:var(--acc);color:#fff}button:disabled{opacity:.6;cursor:default}#skip{margin-right:auto}
</style></head><body>
<h1 id="t"></h1><p id="b"></p>
<div class="row"><button id="skip"></button><button id="later"></button><button class="main" id="main"></button></div>
<script>
const TX=__TX__;const $=i=>document.getElementById(i);
$("t").textContent=TX.title;document.title=TX.title;$("b").textContent=TX.body;
$("skip").textContent=TX.skip;$("later").textContent=TX.later;$("main").textContent=TX.main;
async function pick(c){document.querySelectorAll("button").forEach(b=>b.disabled=true);try{await fetch("update/choice",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({choice:c})});}catch(e){}window.close();}
$("skip").onclick=()=>pick("skip");$("later").onclick=()=>pick("later");$("main").onclick=()=>pick(TX.choice);$("main").focus();
</script></body></html>`
