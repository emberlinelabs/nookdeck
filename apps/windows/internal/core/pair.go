package core

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

// PairServer serves the pairing window's page on 127.0.0.1 (a random port and a random path token, so no other site or local
// page can read the PIN). The page shows the QR, the PIN and an address picker, and fetches everything from the agent through here.
type PairServer struct {
	client *Client
	lang   string
	token  string
	ln     net.Listener
	srv    *http.Server
}

// StartPairServer listens and returns the server; URL() is what the window opens.
func StartPairServer(c *Client, lang string) (*PairServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	b := make([]byte, 16)
	rand.Read(b)
	p := &PairServer{client: c, lang: lang, token: hex.EncodeToString(b), ln: ln}
	p.srv = &http.Server{Handler: p.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go p.srv.Serve(ln)
	return p, nil
}

func (p *PairServer) URL() string { return "http://" + p.ln.Addr().String() + "/" + p.token + "/" }
func (p *PairServer) Close()      { p.srv.Close() }

func (p *PairServer) Handler() http.Handler {
	mux := http.NewServeMux()
	prefix := "/" + p.token + "/"
	mux.HandleFunc(prefix, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != prefix {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("content-type", "text/html; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		w.Write([]byte(PairPage(p.lang)))
	})
	mux.HandleFunc(prefix+"pairing", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
		defer cancel()
		var pr Pairing
		var err error
		if r.Method == "POST" {
			pr, err = p.client.NewPIN(ctx)
		} else {
			pr, err = p.client.Pairing(ctx)
		}
		w.Header().Set("content-type", "application/json")
		w.Header().Set("cache-control", "no-store")
		if err != nil {
			w.WriteHeader(502)
			json.NewEncoder(w).Encode(map[string]string{"error": "unreachable"})
			return
		}
		json.NewEncoder(w).Encode(pr)
	})
	mux.HandleFunc(prefix+"qr.png", func(w http.ResponseWriter, r *http.Request) {
		u := r.URL.Query().Get("u")
		// only pairing links (http://host:port/?pin=...), not an open QR generator
		pu, err := url.Parse(u)
		if err != nil || pu.Scheme != "http" || len(u) > 300 || !strings.Contains(u, "?pin=") {
			http.Error(w, "bad link", 400)
			return
		}
		png, err := qrcode.Encode(u, qrcode.Medium, 320)
		if err != nil {
			http.Error(w, "qr failed", 500)
			return
		}
		w.Header().Set("content-type", "image/png")
		w.Header().Set("cache-control", "no-store")
		w.Write(png)
	})
	// a request that did not come to 127.0.0.1 (DNS rebinding) gets nothing
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.Host)
		if host != "127.0.0.1" && host != "localhost" {
			http.Error(w, "forbidden", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// PairPage is the HTML of the pairing window, with the texts of lang filled in.
func PairPage(lang string) string {
	tx := map[string]string{}
	for _, k := range []string{"pair.title", "pair.scan", "pair.qrLabel", "pair.pin", "pair.newPin", "pair.via", "pair.copyLink", "pair.copied", "pair.loading", "pair.error", "common.close"} {
		tx[k] = T(lang, k)
	}
	b, _ := json.Marshal(tx)
	b = []byte(strings.ReplaceAll(string(b), "<", `<`))
	return strings.ReplaceAll(strings.ReplaceAll(pairHTML, "__LANG__", lang), "__TX__", string(b))
}

const pairHTML = `<!doctype html><html lang="__LANG__"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nookdeck</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--mut:#6b6b76;--card:#f3f3f6;--acc:#2f6bff}
@media(prefers-color-scheme:dark){:root{--bg:#17171b;--fg:#f1f1f4;--mut:#9a9aa6;--card:#232329}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 "Segoe UI",system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:20px 24px;gap:14px}
h1{font-size:18px;margin:0}p{margin:0;color:var(--mut);text-align:center}
#qr{width:260px;height:260px;border-radius:12px;background:#fff;padding:8px;display:block}
.pin{font:600 34px/1 ui-monospace,Consolas,monospace;letter-spacing:.2em;margin-left:.2em}
label{font-size:13px;color:var(--mut);align-self:stretch}select,button{font:inherit;color:inherit;background:var(--card);border:1px solid transparent;border-radius:8px;padding:8px 10px}
select{width:100%;margin-top:4px}button{cursor:pointer}button:hover{border-color:var(--acc)}.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
#err{color:#d33;display:none}
</style></head><body>
<h1 id="t"></h1><p id="scan"></p>
<img id="qr" alt="" width="260" height="260"><div class="pin" id="pin">······</div>
<div style="align-self:stretch"><label for="addr" id="via"></label><select id="addr"></select></div>
<div class="row"><button id="copy"></button><button id="renew"></button></div>
<p id="err"></p>
<script>
const TX=__TX__;const $=i=>document.getElementById(i);
$("t").textContent=TX["pair.title"];document.title=TX["pair.title"];$("scan").textContent=TX["pair.scan"];$("qr").alt=TX["pair.qrLabel"];
$("via").textContent=TX["pair.via"];$("copy").textContent=TX["pair.copyLink"];$("renew").textContent=TX["pair.newPin"];
let data=null,picked=null;
function show(){if(!data)return;const a=data.addresses.find(x=>x.id===picked)||data.addresses.find(x=>x.id===data.defaultAddress)||data.addresses[0];
 $("pin").textContent=data.pin;if(!a)return;picked=a.id;$("qr").src="qr.png?u="+encodeURIComponent(a.url);}
function fill(){const s=$("addr");const cur=picked;s.innerHTML="";for(const a of data.addresses){const o=document.createElement("option");o.value=a.id;o.textContent=a.label+(a.note?" ("+a.note+")":"");s.appendChild(o);}
 if(!picked||!data.addresses.some(x=>x.id===picked))picked=data.defaultAddress||(data.addresses[0]||{}).id;s.value=picked;}
async function load(method){try{const r=await fetch("pairing",{method:method||"GET"});if(!r.ok)throw 0;const d=await r.json();const same=data&&JSON.stringify(d.addresses.map(a=>a.id))===JSON.stringify(data.addresses.map(a=>a.id));
 const pinChanged=!data||data.pin!==d.pin;data=d;if(!same)fill();$("err").style.display="none";if(pinChanged||!same)show();}catch(e){$("err").textContent=TX["pair.error"];$("err").style.display="block";}}
$("addr").onchange=e=>{picked=e.target.value;show();};
$("renew").onclick=()=>load("POST");
$("copy").onclick=async()=>{const a=data&&data.addresses.find(x=>x.id===picked);if(!a)return;try{await navigator.clipboard.writeText(a.url);}catch(e){}const b=$("copy");const o=b.textContent;b.textContent=TX["pair.copied"];setTimeout(()=>b.textContent=o,1500);};
load();setInterval(()=>{if(!document.hidden)load();},5000);
</script></body></html>`
