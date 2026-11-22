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

// PortFromLauncher finds the port in the text of launch.vbs (the agent's service launcher); 7420 when it has none.
func PortFromLauncher(text string) int {
	if m := portRe.FindStringSubmatch(text); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 && n < 65536 {
			return n
		}
	}
	return 7420
}

var programRe = regexp.MustCompile(`cmd /s /c "+([^"]+?\.exe)`)

// ProgramFromLauncher is the agent program the launcher starts ("" when it cannot be read).
func ProgramFromLauncher(text string) string {
	if m := programRe.FindStringSubmatch(text); m != nil {
		return strings.TrimSpace(m[1])
	}
	return ""
}
