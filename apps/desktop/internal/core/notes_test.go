package core

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The real shape of .github/release-notes.md (the latest release's body): version sections newest first, then Install and Files.
const notesBody = "## Nookdeck 0.6.1\r\n\r\nUpgrading: run the install command below again, or `nookdeck update`, or use **Install and restart** in the app.\r\n\r\n" +
	"### Fixed\r\n\r\n- **Windows: high CPU from PowerShell** ([#15](https://github.com/howznguyen/nookdeck/issues/15)). The tray app asked every 5 seconds.\r\n\r\n" +
	"### New\r\n\r\n- **Theme previews before you install.**\r\n\r\n" +
	"## Nookdeck 0.6.0: Linux, and updates in one click\r\n\r\nUpgrading: run the install command below again.\r\n\r\n### New\r\n\r\n" +
	"- **Linux (experimental).** Ubuntu 22.04 and 24.04:\r\n  - Install the `.deb` (`sudo apt install ./nookdeck_*_amd64.deb`).\r\n  - The install command works too.\r\n- **The app tells you when an update is out**\r\n\r\n" +
	"## Nookdeck 0.5.3\r\n\r\n### Fixed\r\n\r\n- Something.\r\n\r\n" +
	"## Install\r\n\r\n```sh\r\ncurl -fsSL https://nookdeck.app/install.sh | sh\r\n```\r\n\r\n## Files\r\n\r\n- Nookdeck-Setup.exe\r\n"

func TestNotesSince(t *testing.T) {
	secs, more := NotesSince(notesBody, "0.6.0", "0.6.1", 3)
	if len(secs) != 1 || more || secs[0].Version != "0.6.1" || secs[0].Title != "" {
		t.Fatalf("from 0.6.0: %+v more=%v", secs, more)
	}
	h := secs[0].HTML
	for _, s := range []string{"<h3>Fixed</h3>", "<ul><li><strong>Windows: high CPU from PowerShell</strong> (<a href=\"https://github.com/howznguyen/nookdeck/issues/15\">#15</a>).", "<h3>New</h3>"} {
		if !strings.Contains(h, s) {
			t.Errorf("missing %q in %s", s, h)
		}
	}
	if strings.Contains(h, "Upgrading") || strings.Contains(h, "0.6.0") {
		t.Errorf("the Upgrading line and the next section are left out: %s", h)
	}

	// an older install sees every newer section, with ": title" headings; Install and Files are never notes
	secs, more = NotesSince(notesBody, "nookdeck 0.5.2 (abc)", "v0.6.1", 3)
	if len(secs) != 3 || more || secs[1].Version != "0.6.0" || secs[1].Title != "Linux, and updates in one click" || secs[2].Version != "0.5.3" {
		t.Fatalf("from 0.5.2: %+v", secs)
	}
	if strings.Contains(secs[2].HTML, "curl") || strings.Contains(secs[2].HTML, "Setup.exe") {
		t.Errorf("Install / Files leaked into 0.5.3: %s", secs[2].HTML)
	}
	// nested list
	if !strings.Contains(secs[1].HTML, "Ubuntu 22.04 and 24.04:<ul><li>Install the <code>.deb</code> (<code>sudo apt install ./nookdeck_*_amd64.deb</code>).</li><li>The install command works too.</li></ul></li><li><strong>The app tells you") {
		t.Errorf("nested list: %s", secs[1].HTML)
	}
	// at most max, then "more"
	secs, more = NotesSince(notesBody, "0.5.0", "0.6.1", 2)
	if len(secs) != 2 || !more || secs[0].Version != "0.6.1" {
		t.Errorf("max 2: %d more=%v", len(secs), more)
	}
	// the owner's PC: agent 0.5.3, its cached check offers 0.6.0, GitHub's latest is already 0.6.1. The window installs 0.6.0, so
	// it shows 0.6.0 only (not 0.6.1, which it does not install)
	secs, more = NotesSince(notesBody, "0.5.3", "0.6.0", 3)
	if len(secs) != 1 || more || secs[0].Version != "0.6.0" || secs[0].Title != "Linux, and updates in one click" {
		t.Errorf("0.5.3 -> 0.6.0: %+v more=%v", secs, more)
	}
	if !NeedsRecheck("0.6.0", "v0.6.1") || NeedsRecheck("0.6.1", "v0.6.1") || NeedsRecheck("0.6.1", "v0.6.0") || NeedsRecheck("0.6.1", "") {
		t.Error("NeedsRecheck: only when GitHub's tag is newer than the offer")
	}
	// up to date, or nothing usable
	if secs, more := NotesSince(notesBody, "0.6.1", "0.6.1", 3); len(secs) != 0 || more {
		t.Error("up to date")
	}
	if secs, _ := NotesSince("random text\n## Install\n", "0.1.0", "9.9.9", 3); len(secs) != 0 {
		t.Error("no version sections")
	}
}

func TestRenderNotesEscapes(t *testing.T) {
	h := RenderNotes("### <b>Head</b>\n\n<script>alert(1)</script> & \"quotes\"\n\n- [bad](javascript:alert(1)) [http](http://x.example) [ok](https://x.example/?a=1&b=\"2\")\n- **bold <i>x</i>** `<code>` **unclosed")
	for _, bad := range []string{"<script", "<b>", "<i>", `href="javascript`, `href="http:`, "<code><code>"} {
		if strings.Contains(h, bad) {
			t.Errorf("%q in %s", bad, h)
		}
	}
	for _, good := range []string{"<h3>&lt;b&gt;Head&lt;/b&gt;</h3>", "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#34;quotes&#34;</p>",
		"[bad](javascript:alert(1))", "[http](http://x.example)", `<a href="https://x.example/?a=1&amp;b=&#34;2&#34;">ok</a>`,
		"<strong>bold &lt;i&gt;x&lt;/i&gt;</strong> <code>&lt;code&gt;</code> **unclosed"} {
		if !strings.Contains(h, good) {
			t.Errorf("missing %q in %s", good, h)
		}
	}
	if !SafeLink("https://github.com/x") || SafeLink("http://github.com") || SafeLink("javascript:alert(1)") || SafeLink("https:///x") || SafeLink("file:///etc/passwd") {
		t.Error("SafeLink")
	}
}

// The releases list as GitHub returns it after the split: each body holds its own section, then Install and Files. Out of order on
// purpose, with a draft, a prerelease, a body made before the split (every version in it) and one with no heading at all.
func splitReleases() []Release {
	own := func(head, rest string) string {
		return head + "\n\nUpgrading: run the install command again.\n\n" + rest + "\n\n## Install\n\ncurl x | sh\n\n## Files\n\n- a.exe\n"
	}
	return []Release{
		{Tag: "v0.6.0", HTMLURL: "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.0", Body: own("## Nookdeck 0.6.0: Linux, and updates in one click", "### New\n\n- **Linux (experimental).**")},
		{Tag: "v0.6.2", Draft: true, Body: own("## Nookdeck 0.6.2", "- draft")},
		{Tag: "v0.6.1", HTMLURL: "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.1", Body: own("## Nookdeck 0.6.1", "### Fixed\n\n- **Windows: high CPU** ([#15](https://github.com/howznguyen/nookdeck/issues/15)).")},
		{Tag: "v0.7.0-beta.1", Prerelease: true, Body: own("## Nookdeck 0.7.0", "- beta")},
		{Tag: "v0.5.3", HTMLURL: "https://github.com/howznguyen/nookdeck/releases/tag/v0.5.3", Body: notesBody}, // before the split: 0.6.1, 0.6.0 and 0.5.3 in one body
		{Tag: "v0.5.2", Body: "Plain text, no heading.\n\n- one fix\n\n## Install\n\ncurl x | sh\n"},
	}
}

func TestNotesFromReleases(t *testing.T) {
	rs := splitReleases()
	vers := func(secs []NoteSection) string {
		var v []string
		for _, s := range secs {
			v = append(v, s.Version)
		}
		return strings.Join(v, ",")
	}
	// the owner's PC: 0.5.3, offered 0.6.0 (GitHub already has 0.6.1): only 0.6.0, its page
	secs, more, page := NotesFromReleases(rs, "0.5.3", "0.6.0", 3)
	if vers(secs) != "0.6.0" || more || page != "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.0" || secs[0].Title != "Linux, and updates in one click" {
		t.Fatalf("0.5.3 -> 0.6.0: %s more=%v %s", vers(secs), more, page)
	}
	if h := secs[0].HTML; strings.Contains(h, "Upgrading") || strings.Contains(h, "curl") || strings.Contains(h, "a.exe") || !strings.Contains(h, "<strong>Linux (experimental).</strong>") {
		t.Errorf("own section only: %s", h)
	}
	// newest first whatever the list order; no drafts, no prereleases; a pre-split body gives only its own version
	secs, more, _ = NotesFromReleases(rs, "0.5.1", "0.7.0", 3)
	if vers(secs) != "0.6.1,0.6.0,0.5.3" || !more { // 0.5.2 is in range too
		t.Errorf("0.5.1 -> 0.7.0: %s more=%v", vers(secs), more)
	}
	if strings.Contains(secs[2].HTML, "high CPU") || !strings.Contains(secs[2].HTML, "Something.") {
		t.Errorf("0.5.3 from its pre-split body: %s", secs[2].HTML)
	}
	// max, then more; a body with no heading is shown whole up to Install
	secs, more, page = NotesFromReleases(rs, "0.5.1", "0.6.1", 2)
	if vers(secs) != "0.6.1,0.6.0" || !more || page != "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.1" {
		t.Errorf("max 2: %s more=%v %s", vers(secs), more, page)
	}
	secs, _, page = NotesFromReleases(rs, "0.5.1", "0.5.2", 3)
	if vers(secs) != "0.5.2" || !strings.Contains(secs[0].HTML, "<li>one fix</li>") || strings.Contains(secs[0].HTML, "curl") {
		t.Errorf("no heading: %+v", secs)
	}
	if page != "https://github.com/howznguyen/nookdeck/releases/tag/v0.5.2" {
		t.Errorf("no html_url: the page is built from the version: %s", page)
	}
	// up to date, or nothing listed
	if secs, more, _ := NotesFromReleases(rs, "0.6.1", "0.6.1", 3); len(secs) != 0 || more {
		t.Error("up to date")
	}
	if secs, _, _ := NotesFromReleases(nil, "0.1.0", "0.6.1", 3); len(secs) != 0 {
		t.Error("empty list")
	}
}

func TestFetchReleases(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("user-agent") == "" || r.Header.Get("accept") != "application/vnd.github+json" {
			http.Error(w, "headers", 400)
			return
		}
		switch {
		case r.URL.Path == "/repos/"+Repo+"/releases" && r.URL.Query().Get("per_page") == "10":
			json.NewEncoder(w).Encode(splitReleases())
		case r.URL.Path == "/repos/"+Repo+"/releases/latest":
			json.NewEncoder(w).Encode(splitReleases()[2])
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	old := APIBase
	APIBase = ts.URL
	defer func() { APIBase = old }()
	rs, err := FetchReleases(context.Background(), ts.Client())
	if err != nil || len(rs) != 6 || rs[1].Tag != "v0.6.2" || !rs[1].Draft || !rs[3].Prerelease || rs[0].HTMLURL == "" {
		t.Fatalf("list %v %+v", err, rs)
	}
	if r, err := FetchLatestRelease(context.Background(), ts.Client()); err != nil || r.Tag != "v0.6.1" {
		t.Errorf("latest release %v %q", err, r.Tag)
	}
	APIBase = ts.URL + "/nope"
	if _, err := FetchReleases(context.Background(), ts.Client()); err == nil {
		t.Error("a 404 is an error")
	}
}

func TestUpdateWindowNotesAndProgress(t *testing.T) {
	ps, err := StartPairServer(fakeAgent(t), "en")
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	calls := 0
	fail := true
	ps.Notes = func(context.Context) ([]Release, error) {
		calls++
		if fail {
			return nil, errors.New("offline")
		}
		return splitReleases(), nil
	}
	var mu sync.Mutex
	var opened []string
	ps.OnOpenURL = func(u string) { mu.Lock(); opened = append(opened, u); mu.Unlock() }
	get := func(path string) (int, string) {
		res, err := http.Get(ps.URL() + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	post := func(path, body string) int {
		res, err := http.Post(ps.URL()+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c, _ := get("update/notes"); c != 404 {
		t.Errorf("no window yet: %d", c)
	}
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Current: "0.6.0"})
	if c, _ := get("update/notes"); c != 502 {
		t.Errorf("offline: %d", c)
	}
	fail = false
	c, b := get("update/notes")
	var n notesReply
	json.Unmarshal([]byte(b), &n)
	if c != 200 || len(n.Sections) != 1 || n.Sections[0].Version != "0.6.1" || n.More || n.Page != "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.1" {
		t.Fatalf("notes %d %s", c, b)
	}
	get("update/notes")
	if calls != 2 {
		t.Errorf("the notes are fetched once per version after a success: %d calls", calls)
	}
	// an offer older than GitHub's latest (the agent's cached check): the notes and the link are for the offered version
	ps.ShowUpdate(UpdateDialog{Version: "0.6.0", Current: "0.5.3"})
	_, b = get("update/notes")
	n = notesReply{}
	json.Unmarshal([]byte(b), &n)
	if len(n.Sections) != 1 || n.Sections[0].Version != "0.6.0" || n.Page != "https://github.com/howznguyen/nookdeck/releases/tag/v0.6.0" {
		t.Errorf("offered 0.6.0: %s", b)
	}
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Current: "0.6.0"})

	// progress: empty, then what the tray sets; it outlives the answer
	if _, b := get("update/progress"); !strings.Contains(b, `"stage":""`) {
		t.Errorf("idle %s", b)
	}
	if post("update/choice", `{"choice":"install"}`) != 204 {
		t.Fatal("install")
	}
	ps.UpdateProgress("0.6.1")("downloading", 5<<20, 20<<20)
	if _, b := get("update/progress"); !strings.Contains(b, `"stage":"downloading","version":"0.6.1","done":5242880,"total":20971520`) {
		t.Errorf("downloading %s", b)
	}
	// a window opened while it runs keeps the progress; one opened after a failure starts clean
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Current: "0.6.0"})
	if _, b := get("update/progress"); !strings.Contains(b, "downloading") {
		t.Error("a running update is kept")
	}
	ps.SetUpdateState(UpdateState{Stage: "error", Error: "checksum mismatch"})
	if _, b := get("update/progress"); !strings.Contains(b, `"error":"checksum mismatch"`) {
		t.Errorf("error %s", b)
	}
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Current: "0.6.0"})
	if _, b := get("update/progress"); !strings.Contains(b, `"stage":""`) {
		t.Errorf("a failed run is not shown again: %s", b)
	}

	// the window's heartbeat: open for its version only, for 5 s after the last ping
	if ps.WindowOpen("0.6.1") {
		t.Error("no window has pinged yet")
	}
	if c, _ := get("update/alive?v=0.6.1"); c != 204 {
		t.Errorf("alive %d", c)
	}
	if c, _ := get("update/alive"); c != 400 {
		t.Error("alive needs the version")
	}
	if !ps.WindowOpen("0.6.1") || ps.WindowOpen("0.6.2") {
		t.Error("WindowOpen")
	}
	ps.upMu.Lock()
	ps.alive["0.6.1"] = time.Now().Add(-6 * time.Second)
	ps.upMu.Unlock()
	if ps.WindowOpen("0.6.1") {
		t.Error("a window that stopped pinging is closed")
	}

	// links: https only, POST only
	if post("update/open", `{"url":"https://github.com/howznguyen/nookdeck/issues/15"}`) != 204 {
		t.Error("https link")
	}
	for _, bad := range []string{`{"url":"javascript:alert(1)"}`, `{"url":"file:///etc/passwd"}`, `{"url":"http://x"}`, `nope`} {
		if post("update/open", bad) != 400 {
			t.Errorf("refused: %s", bad)
		}
	}
	if c, _ := get("update/open"); c != 400 {
		t.Error("GET open")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(opened, ",") != "https://github.com/howznguyen/nookdeck/issues/15" {
		t.Errorf("opened %v", opened)
	}
}

func TestUpdatePageProgressStrings(t *testing.T) {
	for _, l := range []string{"en", "vi", "zh", "fr", "pt"} {
		p := UpdatePage(l, UpdateDialog{Version: "0.6.1", Current: "0.6.0"})
		for _, k := range []string{"update.notes.title", "update.tray.installing", "update.tray.size", "update.tray.gone", "update.progress.heading", "update.progress.downloading", "update.progress.checking", "update.progress.installing", "update.progress.cancel", "__TX__", "__LANG__"} {
			if strings.Contains(p, k) {
				t.Errorf("%s: %q left (missing string)", l, k)
			}
		}
		if !strings.Contains(p, "releases/tag/v0.6.1") {
			t.Errorf("%s: release page", l)
		}
	}
	p := UpdatePage("en", UpdateDialog{Version: "0.6.1"})
	for _, want := range []string{"{done} of {total} MB", `"progress.heading":"Installing Nookdeck 0.6.1"`, `"progress.downloading":"Downloading"`, `"progress.checking":"Checking"`, `"progress.installing":"Installing and restarting"`, `"progress.cancel":"Cancel"`} {
		if !strings.Contains(p, want) {
			t.Errorf("en progress texts: no %s", want)
		}
	}
}

// Cancel while downloading: the download's context is cancelled, the window's question comes back (Install works again); an
// install, or nothing running, cannot be cancelled.
func TestUpdateCancel(t *testing.T) {
	ps, err := StartPairServer(fakeAgent(t), "en")
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	var mu sync.Mutex
	var choices []string
	ps.OnUpdateChoice = func(v, c string) { mu.Lock(); choices = append(choices, c); mu.Unlock() }
	post := func(path, body string) int {
		res, err := http.Post(ps.URL()+path, "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Current: "0.6.0"})
	if post("update/cancel", "") != 409 {
		t.Error("nothing to cancel yet")
	}
	if post("update/choice", `{"choice":"install"}`) != 204 {
		t.Fatal("install")
	}
	dl, stop := ps.DownloadContext(context.Background())
	defer stop()
	ps.SetUpdateState(UpdateState{Stage: "downloading", Version: "0.6.1", Done: 1, Total: 10})
	if res, err := http.Get(ps.URL() + "update/cancel"); err != nil || res.StatusCode != 405 {
		t.Error("cancel is a POST")
	}
	if post("update/cancel", "") != 204 {
		t.Fatal("cancel")
	}
	if !errors.Is(dl.Err(), context.Canceled) {
		t.Error("the download goes on")
	}
	ps.upMu.Lock()
	active := ps.state.Active()
	ps.upMu.Unlock()
	if active {
		t.Error("the progress stays")
	}
	if post("update/choice", `{"choice":"install"}`) != 204 {
		t.Error("the question is not back")
	}
	// an install cannot be cancelled
	_, stop2 := ps.DownloadContext(context.Background())
	stop2()
	ps.SetUpdateState(UpdateState{Stage: "installing", Version: "0.6.1"})
	if post("update/cancel", "") != 409 {
		t.Error("an install was cancelled")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(choices, ",") != "install,install" {
		t.Errorf("choices %v", choices)
	}
}

// The tray's own update is very silent end to end: nothing but the update window shows (owner request for 0.7.0).
func TestSilentUpdateInstaller(t *testing.T) {
	if strings.Join(SetupUpdateArgs, " ") != "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCANCEL" {
		t.Errorf("switches %v", SetupUpdateArgs)
	}
	b, err := os.ReadFile("../../installer/nookdeck.iss")
	if err != nil {
		t.Fatal(err)
	}
	iss := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, want := range []string{
		"CloseApplications=no", // the tray is stopped by PrepareToInstall, no Restart Manager dialog
		`Parameters: "--setup{code:QuietArg}"; StatusMsg: "Setting up the Nookdeck agent..."; Flags: runhidden waituntilterminated`,
		"if WizardSilent then Result := ' --quiet' else Result := '';",
		`Filename: "{app}\Nookdeck.exe"; Parameters: "--updated"; Flags: nowait; Check: WizardSilent`, // the tray comes back
		"Flags: postinstall nowait skipifsilent",
	} {
		if !strings.Contains(iss, want) {
			t.Errorf("nookdeck.iss lacks %q", want)
		}
	}
}
