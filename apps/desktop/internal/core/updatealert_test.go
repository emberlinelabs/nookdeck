package core

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUpdateAsk(t *testing.T) {
	a := &UpdateAsk{SkipFile: filepath.Join(t.TempDir(), "sub", "tray-update-skip")}
	if !a.ShouldAsk("0.6.0", false) {
		t.Fatal("first background check asks")
	}
	if a.ShouldAsk("0.6.0", false) {
		t.Error("the same version is asked once per run")
	}
	if !a.ShouldAsk("0.6.0", true) {
		t.Error("Check for updates always asks")
	}
	if !a.ShouldAsk("0.6.1", false) {
		t.Error("a newer version asks again")
	}
	if err := a.Skip("0.7.0"); err != nil {
		t.Fatal(err)
	}
	// a new run (new UpdateAsk, same file): the skipped version is not asked by the background check
	b := &UpdateAsk{SkipFile: a.SkipFile}
	if !b.Skipped("0.7.0") || b.ShouldAsk("0.7.0", false) {
		t.Error("skipped version asked again")
	}
	if !b.ShouldAsk("0.7.0", true) {
		t.Error("a manual check asks even for the skipped version")
	}
	if !b.ShouldAsk("0.7.1", false) || b.Skipped("0.7.1") {
		t.Error("only the skipped version is skipped")
	}
	// no file, unreadable dir: nothing skipped, still asks
	c := &UpdateAsk{SkipFile: filepath.Join(t.TempDir(), "none")}
	if c.Skipped("0.7.0") || !c.ShouldAsk("0.7.0", false) {
		t.Error("no skip file")
	}
}

func TestUpdatePage(t *testing.T) {
	d := UpdateDialog{Version: "0.6.0", Current: "0.5.3"}
	p := UpdatePage("en", d)
	for _, s := range []string{"Nookdeck 0.6.0 is available", "You have 0.5.3", "Install and restart", "Later", "Skip this version", `"choice":"install"`} {
		if !strings.Contains(p, s) {
			t.Errorf("missing %q", s)
		}
	}
	m := UpdatePage("en", UpdateDialog{Version: "0.6.0", Current: "0.5.3", Manual: true, Path: "/opt/<x>"})
	if !strings.Contains(m, "Open the download page") || !strings.Contains(m, `"choice":"download"`) || strings.Contains(m, "Install and restart") || strings.Contains(m, "/opt/<x>") {
		t.Errorf("manual page: %.300s", m)
	}
	for _, l := range []string{"vi", "zh", "fr", "pt"} {
		if UpdatePage(l, d) == p {
			t.Errorf("%s not translated", l)
		}
	}
}

func TestUpdateWindowRoutes(t *testing.T) {
	ps, err := StartPairServer(fakeAgent(t), "en")
	if err != nil {
		t.Fatal(err)
	}
	defer ps.Close()
	var mu sync.Mutex
	var got []string
	ps.OnUpdateChoice = func(v, c string) { mu.Lock(); got = append(got, v+":"+c); mu.Unlock() }
	post := func(body string) int {
		res, err := http.Post(ps.URL()+"update/choice", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if res, _ := http.Get(ps.URL() + "update"); res.StatusCode != 404 {
		t.Errorf("nothing shown yet: %d", res.StatusCode)
	}
	if post(`{"choice":"install"}`) != 404 {
		t.Error("an answer without a window")
	}
	u := ps.ShowUpdate(UpdateDialog{Version: "0.6.0", Current: "0.5.3"})
	res, _ := http.Get(u)
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(b), "0.6.0") {
		t.Fatalf("window %d", res.StatusCode)
	}
	if post(`{"choice":"rm -rf"}`) != 400 || post(`nope`) != 400 {
		t.Error("bad choices are refused")
	}
	if post(`{"choice":"skip"}`) != 204 || post(`{"choice":"install"}`) != 404 {
		t.Error("one answer per window")
	}
	// a window that cannot install itself refuses "install"
	ps.ShowUpdate(UpdateDialog{Version: "0.6.1", Manual: true})
	if post(`{"choice":"install"}`) != 400 || post(`{"choice":"download"}`) != 204 {
		t.Error("manual window")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(got, ",") != "0.6.0:skip,0.6.1:download" {
		t.Errorf("choices %v", got)
	}
}
