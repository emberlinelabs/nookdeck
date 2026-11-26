package core

import (
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// The "What's new" part of the update window. Each GitHub release's body holds its own version's section ("## Nookdeck X.Y.Z" or
// "## Nookdeck X.Y.Z: title", from .github/release-notes.md via scripts/release-body.sh), then other "## " sections (Install, Files)
// that are not notes. The window lists the releases and shows the ones the update brings.

// APIBase is the GitHub API; tests point it at a local server.
var APIBase = "https://api.github.com"

// Release is a GitHub release: its tag ("v0.6.1"), body (the release notes) and page.
type Release struct {
	Tag        string `json:"tag_name"`
	Body       string `json:"body"`
	HTMLURL    string `json:"html_url"`
	Draft      bool   `json:"draft"`
	Prerelease bool   `json:"prerelease"`
}

// FetchReleases lists the 10 newest releases (GitHub lists drafts only to the owner; prereleases are dropped by NotesFromReleases).
func FetchReleases(ctx context.Context, c *http.Client) ([]Release, error) {
	var rs []Release
	err := getGitHub(ctx, c, "/repos/"+Repo+"/releases?per_page=10", 4<<20, &rs)
	return rs, err
}

// NotesFromReleases is "What's new" for an update from current to offered: the releases (no drafts, no prereleases) whose version
// is in (current, offered], newest first, at most max; more is true when others are in range. Each release's own section is shown
// (a body without one is shown whole, up to its Install / Files). page is the offered release's page.
func NotesFromReleases(rs []Release, current, offered string, max int) (secs []NoteSection, more bool, page string) {
	page = ReleasePage(offered)
	type rel struct {
		v [3]int
		r Release
	}
	var in []rel
	for _, r := range rs {
		v, ok := ParseVersion(r.Tag)
		if !ok || r.Draft || r.Prerelease || !Newer(r.Tag, current) || Newer(r.Tag, offered) {
			continue
		}
		if !Newer(r.Tag, offered) && !Newer(offered, r.Tag) && SafeLink(r.HTMLURL) {
			page = r.HTMLURL
		}
		in = append(in, rel{v, r})
	}
	sort.SliceStable(in, func(i, j int) bool { return Newer(in[i].r.Tag, in[j].r.Tag) })
	for _, x := range in {
		if len(secs) == max {
			return secs, true, page
		}
		ver := strconv.Itoa(x.v[0]) + "." + strconv.Itoa(x.v[1]) + "." + strconv.Itoa(x.v[2])
		if s, ok := ownSection(x.r.Body, current, ver); ok {
			secs = append(secs, s)
		} else if s, ok := ownSection("## Nookdeck "+ver+"\n"+x.r.Body, current, ver); ok {
			secs = append(secs, s)
		}
	}
	return secs, false, page
}

// ownSection finds version's section in a release body (bodies made before the split hold every version: the right one is taken).
func ownSection(body, current, version string) (NoteSection, bool) {
	all, _ := NotesSince(body, current, version, 1000)
	for _, s := range all {
		if s.Version == version {
			return s, true
		}
	}
	return NoteSection{}, false
}

func getGitHub(ctx context.Context, c *http.Client, path string, limit int64, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", strings.TrimRight(APIBase, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("accept", "application/vnd.github+json")
	req.Header.Set("user-agent", "nookdeck-tray")
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("api.github.com answered %d", res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, limit)).Decode(out)
}

// NeedsRecheck: GitHub already has a newer release than the version the agent offers (its update check is cached for a day), so
// the tray asks the agent to check again before it shows the window; the title and the notes then name the same version.
func NeedsRecheck(offered, latestTag string) bool { return Newer(latestTag, offered) }

// FetchLatestRelease returns the latest release (its tag is what the tray compares with the agent's offer).
func FetchLatestRelease(ctx context.Context, c *http.Client) (Release, error) {
	var r Release
	err := getGitHub(ctx, c, "/repos/"+Repo+"/releases/latest", 1<<20, &r)
	return r, err
}

// NoteSection is one version's notes, rendered to safe HTML.
type NoteSection struct {
	Version string `json:"version"`
	Title   string `json:"title,omitempty"`
	HTML    string `json:"html"`
}

var noteHeadRe = regexp.MustCompile(`^##\s+Nookdeck\s+v?(\d+\.\d+\.\d+)\s*(?::\s*(.*?))?\s*$`)

// NotesSince returns the sections of the versions the update brings: newer than current and not newer than offered (the version the
// window installs; GitHub may already have a newer one). Newest first as in the body, at most max of them; more is true when there
// were others. Each section loses its "Upgrading: ..." line (the window has its own buttons).
func NotesSince(body, current, offered string, max int) (secs []NoteSection, more bool) {
	type raw struct {
		version, title string
		lines          []string
	}
	var all []raw
	var cur *raw
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "## ") || line == "##" {
			cur = nil
			if m := noteHeadRe.FindStringSubmatch(line); m != nil {
				all = append(all, raw{version: m[1], title: m[2]})
				cur = &all[len(all)-1]
			}
			continue
		}
		if cur != nil && !strings.HasPrefix(strings.TrimSpace(line), "Upgrading:") {
			cur.lines = append(cur.lines, line)
		}
	}
	for _, r := range all {
		if !Newer(r.version, current) || Newer(r.version, offered) {
			continue
		}
		if len(secs) == max {
			more = true
			break
		}
		secs = append(secs, NoteSection{Version: r.version, Title: r.title, HTML: RenderNotes(strings.Join(r.lines, "\n"))})
	}
	return secs, more
}

var listRe = regexp.MustCompile(`^(\s*)[-*]\s+(.*)$`)

// RenderNotes turns the small markdown of the release notes into HTML: ### headings, nested "-" lists, paragraphs, **bold**,
// `code` and [links](https://...). Everything else is shown as text: all text is HTML-escaped, and a link that is not https stays
// plain text.
func RenderNotes(md string) string {
	var b strings.Builder
	var depth []int // indent of each open <ul>
	inP := false
	closeP := func() {
		if inP {
			b.WriteString("</p>")
			inP = false
		}
	}
	closeLists := func(to int) {
		for len(depth) > to {
			b.WriteString("</li></ul>")
			depth = depth[:len(depth)-1]
		}
	}
	for _, line := range strings.Split(md, "\n") {
		t := strings.TrimSpace(line)
		switch {
		case t == "":
			closeP()
			closeLists(0)
		case strings.HasPrefix(t, "#"):
			closeP()
			closeLists(0)
			b.WriteString("<h3>" + inline(strings.TrimSpace(strings.TrimLeft(t, "#"))) + "</h3>")
		default:
			if m := listRe.FindStringSubmatch(strings.ReplaceAll(line, "\t", "  ")); m != nil {
				closeP()
				ind := len(m[1])
				for len(depth) > 0 && ind < depth[len(depth)-1] {
					b.WriteString("</li></ul>")
					depth = depth[:len(depth)-1]
				}
				if len(depth) == 0 || ind > depth[len(depth)-1] {
					b.WriteString("<ul><li>")
					depth = append(depth, ind)
				} else {
					b.WriteString("</li><li>")
				}
				b.WriteString(inline(m[2]))
				continue
			}
			if len(depth) > 0 { // a wrapped line of a list item
				b.WriteString(" " + inline(t))
				continue
			}
			if inP {
				b.WriteString(" ")
			} else {
				b.WriteString("<p>")
				inP = true
			}
			b.WriteString(inline(t))
		}
	}
	closeP()
	closeLists(0)
	return b.String()
}

var inlineRe = regexp.MustCompile("`([^`]+)`|\\*\\*(.+?)\\*\\*|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)")

// SafeLink reports whether u may be opened from the notes: an absolute https URL.
func SafeLink(u string) bool {
	p, err := url.Parse(u)
	return err == nil && p.Scheme == "https" && p.Host != ""
}

func inline(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range inlineRe.FindAllStringSubmatchIndex(s, -1) {
		b.WriteString(html.EscapeString(s[last:m[0]]))
		last = m[1]
		switch {
		case m[2] >= 0:
			b.WriteString("<code>" + html.EscapeString(s[m[2]:m[3]]) + "</code>")
		case m[4] >= 0:
			b.WriteString("<strong>" + inline(s[m[4]:m[5]]) + "</strong>")
		default:
			text, href := s[m[6]:m[7]], s[m[8]:m[9]]
			if SafeLink(href) {
				b.WriteString(`<a href="` + html.EscapeString(href) + `">` + inline(text) + "</a>")
			} else {
				b.WriteString(html.EscapeString(s[m[0]:m[1]]))
			}
		}
	}
	b.WriteString(html.EscapeString(s[last:]))
	return b.String()
}
