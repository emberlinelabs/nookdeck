package core

import (
	"regexp"
	"strconv"
	"strings"
)

var versionRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// ParseVersion reads "nookdeck 0.3.0 (a60afdf-dirty)" or "v0.3.0" into [3]int. ok is false when there is no version in s.
func ParseVersion(s string) (v [3]int, ok bool) {
	m := versionRe.FindStringSubmatch(s)
	if m == nil {
		return v, false
	}
	for i := 0; i < 3; i++ {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

// Newer reports whether version a is newer than b (both free text from --version or a tag). Unparseable counts as older.
func Newer(a, b string) bool {
	va, oka := ParseVersion(a)
	vb, okb := ParseVersion(b)
	if !oka {
		return false
	}
	if !okb {
		return true
	}
	for i := 0; i < 3; i++ {
		if va[i] != vb[i] {
			return va[i] > vb[i]
		}
	}
	return false
}

var portRe = regexp.MustCompile(`--port\W+(\d{2,5})`)

// PortFromLauncher finds the port in the text of the agent's launcher (launch.vbs, the systemd unit or autostart.sh); 7420 when it
// has none.
func PortFromLauncher(text string) int {
	if m := portRe.FindStringSubmatch(text); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return 7420
}

var programRe = regexp.MustCompile(`cmd /s /c "+([^"]+?\.exe)`)

// ProgramFromLauncher is the agent program the launcher starts ("" when it cannot be read): launch.vbs, a systemd unit, or the
// autostart script.
func ProgramFromLauncher(text string) string {
	if p := programFromUnit(text); p != "" {
		return p
	}
	if p := programFromAutostart(text); p != "" {
		return p
	}
	if m := programRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}

var execStartRe = regexp.MustCompile(`(?m)^ExecStart="((?:[^"\\]|\\.)*)"`)

// programFromUnit reads the program of a systemd unit written by `nookdeck service install` (every word double-quoted, with
// \" \\ escaped, % as %% and $ as $$).
func programFromUnit(text string) string {
	m := execStartRe.FindStringSubmatch(text)
	if m == nil {
		return ""
	}
	var b strings.Builder
	s := m[1]
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
		}
		b.WriteByte(s[i])
	}
	return strings.NewReplacer("%%", "%", "$$", "$").Replace(b.String())
}

// shWords splits a line of single-quoted shell words ('a' 'it'\''s'), stopping at the first word that is not quoted.
func shWords(s string) []string {
	var out []string
	for {
		s = strings.TrimLeft(s, " \t")
		if !strings.HasPrefix(s, "'") {
			return out
		}
		var w strings.Builder
		for strings.HasPrefix(s, "'") {
			end := strings.IndexByte(s[1:], '\'')
			if end < 0 {
				return out
			}
			w.WriteString(s[1 : 1+end])
			s = s[2+end:]
			if strings.HasPrefix(s, `\'`) {
				w.WriteByte('\'')
				s = s[2:]
				continue
			}
			break
		}
		out = append(out, w.String())
	}
}

// programFromAutostart reads the program of ~/.nookdeck/autostart.sh: `exec env 'K=V'... '<program>' '--port' ...`.
func programFromAutostart(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "exec env ") {
			continue
		}
		for _, w := range shWords(line[len("exec env "):]) {
			if !strings.Contains(w, "=") {
				return w
			}
		}
	}
	return ""
}
