// Package core is the part of the Windows tray app that has no Windows or UI code: the agent client, language, version and
// pairing logic, the update check and the install/adopt steps. It is tested on any OS; cmd/nookdeck-tray wires it to Windows.
package core

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
)

// strings.json is copied here from apps/shared by build.sh: one file for the macOS and the Windows app.
//
//go:embed assets/strings.json
var stringsJSON []byte

var table map[string]map[string]string

func load() {
	if table != nil {
		return
	}
	table = map[string]map[string]string{}
	var raw map[string]json.RawMessage
	if json.Unmarshal(stringsJSON, &raw) != nil {
		return
	}
	for k, v := range raw {
		if strings.HasPrefix(k, "_") {
			continue
		}
		m := map[string]string{}
		if json.Unmarshal(v, &m) == nil {
			table[k] = m
		}
	}
}

// Lang maps a locale name (vi-VN, zh-Hans-CN, en_US, "") to one of en, vi, zh.
func Lang(locale string) string {
	l := strings.ToLower(locale)
	switch {
	case strings.HasPrefix(l, "vi"):
		return "vi"
	case strings.HasPrefix(l, "zh"):
		return "zh"
	}
	return "en"
}

// T returns the text for key in lang (English when missing; the key itself as a last resort), with {name} placeholders filled.
func T(lang, key string, vars ...string) string {
	load()
	s, ok := table[lang][key]
	if !ok {
		s, ok = table["en"][key]
	}
	if !ok {
		return key
	}
	for i := 0; i+1 < len(vars); i += 2 {
		s = strings.ReplaceAll(s, "{"+vars[i]+"}", vars[i+1])
	}
	return s
}

// Phones is the "N phones connected" line (none / one / other).
func Phones(lang string, n int) string {
	switch n {
	case 0:
		return T(lang, "menu.phones.none")
	case 1:
		return T(lang, "menu.phones.one")
	}
	return T(lang, "menu.phones.other", "count", strconv.Itoa(n))
}

// Keys lists the keys of a language (tests check that vi and zh are complete).
func Keys(lang string) []string {
	load()
	out := make([]string, 0, len(table[lang]))
	for k := range table[lang] {
		out = append(out, k)
	}
	return out
}
