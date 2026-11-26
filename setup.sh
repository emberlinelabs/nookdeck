#!/usr/bin/env bash
# Nookdeck for macOS and Linux: one command to fetch, verify, install and start it.
#
# Usage
#   curl -fsSL https://raw.githubusercontent.com/howznguyen/nookdeck/main/setup.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/howznguyen/nookdeck/main/setup.sh | bash -s -- --port 7421 --no-autostart
#
# Needs no sudo (it refuses to run as root). Run it again any time to upgrade; ~/.nookdeck is never wiped.
#
# Flags                 Effect                                                   Env twin
#   -y, --yes           take every default, ask nothing
#       --version X.Y.Z install that release, not the newest                     NOOKDECK_VERSION
#       --force         reinstall even if this release is already in place       NOOKDECK_FORCE=1
#       --port N        port for the agent (default 7420)
#       --no-autostart  skip the login service (launchd on macOS, systemd on Linux)
#       --no-start      place the program only, do not launch it
#       --no-open       do not open the manage page afterwards
#       --no-path       leave PATH alone (default: ~/.local/bin symlink, else one
#                       marked line in ~/.zshrc / ~/.bash_profile, ~/.bashrc on Linux)
#       --dry-run       fetch and verify, say what would change, change nothing
#       --no-analytics  send no anonymous install count (NOOKDECK_NO_ANALYTICS=1 or DO_NOT_TRACK=1 do the same)
#   -h, --help          show this text
#
# Test hooks (not for everyday use)
#   NOOKDECK_RELEASE_BASE   folder or URL holding nookdeck-<darwin|linux>-<arch> and SHA256SUMS
#   NOOKDECK_INSTALL_HOME   install below this directory instead of $HOME
#   NOOKDECK_GITHUB_URL / NOOKDECK_API_URL   point the "newest release" lookup at a local server
#   NOOKDECK_RETRY_SECONDS  scales the pause between lookup rounds
#   NOOKDECK_LAUNCHCTL      the launchctl to call (macOS; the tests use echo)
#   NOOKDECK_SYSTEMCTL      the command that stands for `systemctl --user` (Linux; the tests use echo)
#   NOOKDECK_SYSTEMD_DIR / NOOKDECK_AUTOSTART_DIR   where the Linux unit / autostart entry live
set -euo pipefail

REPO="howznguyen/nookdeck"
STAGES=6
# macOS and Linux share this script; every difference hangs off $os
case "$(uname -s)" in
  Darwin) os=darwin; os_label=macOS; machine="this Mac"; a_os=macos; curl_hint="It ships with macOS; check your PATH." ;;
  Linux) os=linux; os_label=Linux; machine="this computer"; a_os=linux; curl_hint="Install it with your package manager (for example: sudo apt install curl)." ;;
  *) os=other; os_label="macOS and Linux"; machine="this computer"; a_os=other; curl_hint="Install curl." ;;
esac
yes=0; version="${NOOKDECK_VERSION:-}"; version="${version#v}"; port=7420
autostart=1; start=1; open_page=1; dry=0; add_path=1; force=0
if [ "${NOOKDECK_FORCE:-}" = 1 ]; then force=1; fi
tmp=""
analytics=0; a_want=1; cur_step=start; handover_done=0

# ---------------------------------------------------------------- terminal look
# Brand cyan #22d3ee: truecolor when the terminal says so, else the nearest 256-colour (45). NO_COLOR and pipes get plain text.
C_BRAND=""; C_BOLD=""; C_DIM=""; C_GOOD=""; C_WARN=""; C_BAD=""; C_OFF=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  case "${COLORTERM:-}" in
    truecolor|24bit) C_BRAND=$'\033[38;2;34;211;238m' ;;
    *) C_BRAND=$'\033[38;5;45m' ;;
  esac
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_GOOD=$'\033[32m'; C_WARN=$'\033[33m'; C_BAD=$'\033[31m'; C_OFF=$'\033[0m'
fi
G_OK="✓"; G_WARN="!"; G_BAD="✗"; G_ARROW="→"
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in C|POSIX) G_OK="ok"; G_WARN="!"; G_BAD="x"; G_ARROW="->" ;; esac

say()   { printf '  %s\n' "$*"; }
good()  { printf '  %s%s%s %s\n' "$C_GOOD" "$G_OK" "$C_OFF" "$*"; }
warn()  { printf '  %s%s%s %s\n' "$C_WARN" "$G_WARN" "$C_OFF" "$*"; }
stage() {
  case "$1" in 1) cur_step=detect ;; 2) cur_step=release ;; 3) cur_step=fetch ;; 4) cur_step=install ;; 5) cur_step=service ;; 6) cur_step=start ;; esac
  printf '\n%s[%s/%s]%s %s%s%s\n' "$C_BRAND" "$1" "$STAGES" "$C_OFF" "$C_BOLD" "$2" "$C_OFF"; }
# ---------------------------------------------------------------- anonymous install count (opt out: --no-analytics, NOOKDECK_NO_ANALYTICS=1, DO_NOT_TRACK=1)
# Sends the kind of machine (os, os version, arch) and what happened, to nookdeck.app. Never a host name, user name, path, IP, PIN or token.
# Fire and forget: 3 seconds at most, in the background, every error swallowed.
a_clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_ .,:+()/-' | cut -c1-64; }
track() { # track NAME [key=value ...]
  [ "$analytics" = 1 ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local body kv k v ev="$1"
  body="{\"name\":\"$(a_clean "$1")\",\"os\":\"$a_os\",\"os_version\":\"$(a_clean "$a_osver")\",\"arch\":\"$(a_clean "$a_arch")\",\"installer\":\"${a_installer:-setup.sh}\""
  shift
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    [ -n "$k" ] && [ -n "$v" ] || continue
    body="$body,\"$(a_clean "$k")\":\"$(a_clean "$v")\""
  done
  body="$body}"
  case "$ev" in
    install_started) ( curl -sS -m 3 -X POST -H 'content-type: application/json' --data "$body" "$analytics_url" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true ;;
    # the last event waits (2 s at most): a closing terminal or ssh session would kill a background curl
    *) curl -sS -m 2 -X POST -H 'content-type: application/json' --data "$body" "$analytics_url" >/dev/null 2>&1 || true ;;
  esac
  return 0
}
reason_code() { # a short code for a failure message: never the message itself (it may hold a path)
  case "$1" in
    *"could not fetch"*|*"could not reach"*|*"latest release"*|*"GitHub"*) echo network ;;
    *checksum*|*SHA256SUMS*|*"no entry"*) echo checksum ;;
    *"does not run"*) echo not_runnable ;;
    *"is taken by"*) echo port_taken ;;
    *cancelled*) echo cancelled ;;
    *"macOS-only"*|*"macOS and Linux only"*) echo unsupported_os ;;
    *root*) echo root ;;
    *) echo error ;;
  esac
}
fail() { # fail "what failed" ["why / what to try"]
  track install_failed "step=$cur_step" "reason=$(reason_code "$1")"
  printf '\n%s%s %s%s\n' "$C_BAD" "$G_BAD" "$1" "$C_OFF" >&2
  if [ -n "${2:-}" ]; then printf '  %s\n' "$2" >&2; fi
  printf '\n  Need help? https://github.com/%s/issues\n' "$REPO" >&2
  exit 1
}
banner() {
  printf '\n%s  ╭──────╮%s\n%s  │ ◉  ▭ │%s  %sNookdeck%s\n%s  ╰──────╯%s  %sinstaller for %s%s\n' \
    "$C_BRAND" "$C_OFF" "$C_BRAND" "$C_OFF" "$C_BOLD" "$C_OFF" "$C_BRAND" "$C_OFF" "$C_DIM" "$os_label" "$C_OFF"
}
have() { command -v "$1" >/dev/null 2>&1; }
cleanup() { if [ -n "$tmp" ] && [ -d "$tmp" ]; then rm -rf "$tmp"; fi; }
trap cleanup EXIT
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------- flags
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) yes=1 ;;
    --dry-run) dry=1 ;;
    --no-autostart) autostart=0 ;;
    --no-start) start=0 ;;
    --no-open) open_page=0 ;;
    --no-path) add_path=0 ;;
    --force) force=1 ;;
    --no-analytics) a_want=0 ;;
    --version) shift; [ $# -gt 0 ] || fail "--version needs a value" "Example: --version 0.1.1"; version="${1#v}" ;;
    --version=*) version="${1#--version=}"; version="${version#v}" ;;
    --port) shift; [ $# -gt 0 ] || fail "--port needs a value" "Example: --port 7421"; port="$1" ;;
    --port=*) port="${1#--port=}" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unrecognised flag: $1" "Run with --help to see the flags." ;;
  esac
  shift
done
case "$port" in ''|*[!0-9]*) fail "--port must be a number" ;; esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then fail "--port must be between 1 and 65535"; fi
if [ "$(id -u)" = 0 ] && [ -z "${NOOKDECK_INSTALL_HOME:-}" ]; then fail "refusing to run as root" "Run it as your own user, without sudo."; fi

# Anonymous install count: on unless opted out; never for a dry run, a local test (RELEASE_BASE / INSTALL_HOME) or the test suite.
# NOOKDECK_ANALYTICS_URL points it elsewhere (the tests use it to see the payload) and then overrides the test skips.
analytics_url="${NOOKDECK_ANALYTICS_URL:-https://nookdeck.app/api/event}"
for v in "${NOOKDECK_NO_ANALYTICS:-}" "${DO_NOT_TRACK:-}"; do case "$v" in 1|true|TRUE|yes) a_want=0 ;; esac; done
if [ "$a_want" = 1 ] && [ "$dry" = 0 ]; then
  if [ -n "${NOOKDECK_ANALYTICS_URL:-}" ] || { [ -z "${NOOKDECK_RELEASE_BASE:-}" ] && [ -z "${NOOKDECK_INSTALL_HOME:-}" ] && [ -z "${NOOKDECK_TEST_SANDBOX:-}" ]; }; then analytics=1; fi
fi
if [ "$analytics" = 1 ]; then
  if [ "$os" = linux ]; then a_osver="$(sed -n 's/^VERSION_ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null | head -n1 || true)"
  else a_osver="$(sw_vers -productVersion 2>/dev/null || true)"; fi
  case "$(uname -m)" in arm64|aarch64) a_arch=arm64 ;; *) a_arch=x64 ;; esac
fi

# Prompts read from /dev/tty, so they still work when this file is piped in by curl.
tty_ok=0
if (: </dev/tty) 2>/dev/null; then tty_ok=1; fi

ask() { # ask "question" y|n  -> status 0 for yes
  local q="$1" def="$2" hint reply
  if [ "$def" = y ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ "$yes" = 1 ] || [ "$tty_ok" = 0 ]; then
    if [ "$def" = y ]; then say "$q $hint $G_ARROW yes (default)"; return 0; fi
    say "$q $hint $G_ARROW no (default)"; return 1
  fi
  while :; do
    printf '  %s %s ' "$q" "$hint" >/dev/tty
    IFS= read -r reply </dev/tty || reply=""
    case "$reply" in
      "") if [ "$def" = y ]; then return 0; else return 1; fi ;;
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo]) return 1 ;;
    esac
  done
}

# ---------------------------------------------------------------- hashing and downloading
hash_file() {
  if have shasum; then shasum -a 256 "$1" | cut -d' ' -f1 | tr 'A-F' 'a-f'
  elif have sha256sum; then sha256sum "$1" | cut -d' ' -f1 | tr 'A-F' 'a-f'
  else fail "cannot check the download" "Neither shasum nor sha256sum is installed."; fi
}
sum_for() { # sum_for NAME SUMS-FILE -> lowercase sha256 listed for NAME (empty if absent)
  awk -v n="$1" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }' "$2"
}
sum_listed() { [ -n "$(sum_for "$1" "$2")" ]; }
sum_check() { # sum_check FILE SUMS-FILE
  local name want got
  name="$(basename "$1")"
  want="$(sum_for "$name" "$2")"
  [ -n "$want" ] || fail "$name has no entry in SHA256SUMS" "Refusing to install a file that cannot be verified."
  got="$(hash_file "$1")"
  [ "$got" = "$want" ] || fail "checksum mismatch for $name" "Expected $want but got $got. Nothing was installed."
  good "$name checksum ok ${C_DIM}(${got:0:16}…)${C_OFF}"
}

base_is_custom=0
http_get() { # http_get URL-OR-PATH DEST   (https only, unless the base was set by a test hook)
  local src="$1" dest="$2"
  case "$src" in
    http://*|https://*)
      have curl || fail "curl is missing" "$curl_hint"
      if [ "$base_is_custom" = 1 ]; then
        curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --proto '=http,https' -A nookdeck-setup -o "$dest" "$src" || return 1
      else
        curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors --proto '=https' --proto-redir '=https' -A nookdeck-setup -o "$dest" "$src" || return 1
      fi ;;
    *) [ -f "$src" ] || return 1; cp "$src" "$dest" ;;
  esac
}

size_hint() { # " (63 MB)" for a URL or file; nothing when unknown
  local src="$1" bytes=""
  case "$src" in
    http://*|https://*) if have curl; then bytes="$(curl -fsSLI --max-time 15 -A nookdeck-setup "$src" 2>/dev/null | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }')"; fi ;;
    *) if [ -f "$src" ]; then bytes="$(wc -c <"$src" | tr -d ' ')"; fi ;;
  esac
  case "$bytes" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$bytes" -gt 0 ]; then printf ' (%s MB)' "$(( (bytes + 1048575) / 1048576 ))"; fi
  return 0
}

# Big files: a progress bar on a terminal; if nothing arrives for 60 s the attempt is dropped and resumed (5 tries).
http_get_big() { # http_get_big URL-OR-PATH DEST
  local src="$1" dest="$2" tries=0 bar=-sS proto rc stall="${NOOKDECK_STALL_SECONDS:-60}"
  case "$src" in
    http://*|https://*) ;;
    *) http_get "$src" "$dest"; return ;;
  esac
  have curl || fail "curl is missing" "$curl_hint"
  if [ -t 2 ]; then bar=--progress-bar; fi
  if [ "$base_is_custom" = 1 ]; then proto=(--proto '=http,https'); else proto=(--proto '=https' --proto-redir '=https'); fi
  while [ "$tries" -lt 5 ]; do
    rc=0
    curl -fL "$bar" "${proto[@]}" -A nookdeck-setup --retry 3 --retry-delay 2 --speed-limit 1024 --speed-time "$stall" -C - -o "$dest" "$src" || rc=$?
    if [ "$rc" = 0 ]; then return 0; fi
    tries=$((tries + 1))
    if [ "$rc" = 28 ]; then warn "no data for ${stall} s (slow or blocked route to GitHub); resuming from where it stopped ($tries/5)"
    else warn "transfer interrupted (curl exit $rc); resuming from where it stopped ($tries/5)"; fi
    if [ "$rc" = 22 ]; then return 1; fi # an HTTP error such as 404: the same URL will not improve
    sleep 2
  done
  say "Tip: try later, another network or a VPN, or fetch $src by hand and point NOOKDECK_RELEASE_BASE at that folder."
  return 1
}

# ---------------------------------------------------------------- where everything lives
home_dir="${NOOKDECK_INSTALL_HOME:-$HOME}"
data_dir="$home_dir/.nookdeck"
bin_dir="$data_dir/bin"
bin="$bin_dir/nookdeck"
log_dir="$data_dir/logs"
pidfile="$data_dir/agent.pid"
agents_dir="${NOOKDECK_LAUNCH_AGENTS_DIR:-$home_dir/Library/LaunchAgents}"
plist="$agents_dir/dev.nookdeck.agent.plist"
# Linux: the login service is a systemd user unit, or an XDG autostart entry where there is no systemd user session.
# $plist names the service file on both systems, so the "is it ours" checks below are the same.
if [ -n "${NOOKDECK_INSTALL_HOME:-}" ]; then config_dir="$home_dir/.config"; else config_dir="${XDG_CONFIG_HOME:-$home_dir/.config}"; fi
autostart_file="${NOOKDECK_AUTOSTART_DIR:-$config_dir/autostart}/nookdeck.desktop"
# the unit is nookdeck.service; a dev sandbox label (NOOKDECK_SERVICE_LABEL, as the program reads it) names its own
unit_name=nookdeck.service
case "${NOOKDECK_SERVICE_LABEL:-}" in ''|dev.nookdeck.agent) ;; *) if printf '%s' "$NOOKDECK_SERVICE_LABEL" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$'; then unit_name="$NOOKDECK_SERVICE_LABEL.service"; fi ;; esac
if [ "$os" = linux ]; then plist="${NOOKDECK_SYSTEMD_DIR:-$config_dir/systemd/user}/$unit_name"; fi
# the same contract as the program's own service code: the command line that stands for `systemctl --user`
read -r -a systemctl_user <<<"${NOOKDECK_SYSTEMCTL:-systemctl --user}"
marker="$bin_dir/.release"
# A relocated install (tests) keeps every file the program touches inside it.
child_env=(NOOKDECK_HOME="$data_dir" PHONEDESK_HOME="$data_dir") # the second one is for a 0.1.x program, which only knows the old name
if [ -n "${NOOKDECK_INSTALL_HOME:-}" ]; then
  child_env+=(NOOKDECK_LAUNCH_AGENTS_DIR="$agents_dir" NOOKDECK_CLAUDE_DIR="${NOOKDECK_CLAUDE_DIR:-$home_dir/.claude}" NOOKDECK_CODEX_DIR="${NOOKDECK_CODEX_DIR:-$home_dir/.codex}")
  if [ "$os" = linux ]; then child_env+=(XDG_CONFIG_HOME="$config_dir"); fi
fi
run_bin() { env "${child_env[@]}" "$@"; }

# state carried between phases
legacy_asset=0
asset=""; base=""; tag=""; new_version=""; old_version=""; raw_sha=""
up_to_date=0; already_running=0; svc_before=0
bin_state="already set"; path_state="skipped"; svc_state="skipped"; path_how=""; path_rc_files=""

ver_of() { printf '%s' "$1" | sed -nE 's/^(nookdeck|phonedesk) ([^ ]*).*/\2/p'; }

# What the agent on a port says about itself ("nookdeck 0.1.1 (abc1234)"), empty when silent.
agent_line() {
  local j v c d
  j="$(curl -fsS --max-time 2 "http://127.0.0.1:$1/api/about" 2>/dev/null)" || return 0
  v="$(printf '%s' "$j" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  c="$(printf '%s' "$j" | sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  d="$(printf '%s' "$j" | sed -n 's/.*"dirty"[[:space:]]*:[[:space:]]*\(true\).*/-dirty/p')"
  [ -n "$v" ] || return 0
  if [ -n "$c" ]; then printf 'nookdeck %s (%s%s)' "$v" "$c" "$d"; else printf 'nookdeck %s' "$v"; fi
}

# Who listens on a TCP port: "pid<TAB>command", empty when free (or lsof is missing).
# A valid signature made with a certificate (or Apple's): never touched, re-signing would replace it with a cdhash-only one.
stable_signature() {
  codesign --verify --strict "$1" >/dev/null 2>&1 || return 1
  codesign -d -r- "$1" 2>&1 | grep -Eq 'certificate (leaf|root)|anchor apple'
}

port_owner() {
  local pid
  if have lsof; then
    pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1)"
  elif have ss; then
    # Linux without lsof: ss names the pid only for our own processes
    local line; line="$(ss -Hltnp "sport = :$1" 2>/dev/null | head -n 1)"
    [ -n "$line" ] || return 0
    pid="$(printf '%s' "$line" | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p')"
    if [ -z "$pid" ]; then printf 'unknown\t%s\n' "a program of another user"; return 0; fi
  else return 0; fi
  [ -n "$pid" ] || return 0
  printf '%s\t%s\n' "$pid" "$(ps -p "$pid" -o command= 2>/dev/null | cut -c1-120)"
}

# ================================================================ phase 1: detect_platform
detect_platform() {
  stage 1 "Checking $machine"
  [ "$os" != other ] || fail "this installer is for macOS and Linux only" "You are on $(uname -s). On Windows, use setup.ps1 (see the README)."
  local arch want
  arch="$(uname -m)"
  if [ "$os" = linux ]; then
    case "$arch" in
      x86_64|amd64) want=x64 ;;
      aarch64|arm64) want=arm64 ;;
      *) fail "unsupported processor: $arch" "Nookdeck for Linux is built for x86_64 and arm64." ;;
    esac
    asset="nookdeck-linux-$want"
    good "Linux on $arch ${C_DIM}→ $asset${C_OFF}"
    return 0
  fi
  case "$arch" in
    arm64) want=arm64 ;;
    x86_64)
      want=x64
      # a shell under Rosetta on Apple silicon still wants the native build
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then want=arm64; fi ;;
    *) fail "unsupported processor: $arch" ;;
  esac
  asset="nookdeck-darwin-$want"
  good "macOS on $arch ${C_DIM}→ $asset${C_OFF}"
}

# ================================================================ phase 2: resolve_release
latest_tag() { # prints the newest release tag; retries the redirect, then the API; fails with what went wrong
  local gh="${NOOKDECK_GITHUB_URL:-https://github.com}" api="${NOOKDECK_API_URL:-https://api.github.com}"
  local gap="${NOOKDECK_RETRY_SECONDS:-2}" t="" why="" round scheme
  gh="${gh%/}"; api="${api%/}"
  scheme=(--proto '=https' --proto-redir '=https')
  if [ -n "${NOOKDECK_GITHUB_URL:-}${NOOKDECK_API_URL:-}" ]; then scheme=(--proto '=http,https'); fi
  for round in 1 2 3 4; do
    t="$(curl -fsSLI --retry 2 --retry-delay "$gap" --connect-timeout 15 "${scheme[@]}" -o /dev/null -w '%{url_effective}' "$gh/$REPO/releases/latest" 2>"$tmp/lookup.err" | sed -n 's#.*/tag/##p')" || t=""
    if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
    t="$(curl -fsSL --retry 2 --retry-delay "$gap" --connect-timeout 15 "${scheme[@]}" -H 'Accept: application/vnd.github+json' "$api/repos/$REPO/releases/latest" 2>>"$tmp/lookup.err" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)" || t=""
    if [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
    why="$(tr '\n' ' ' <"$tmp/lookup.err" | sed 's/  */ /g')"
    if [ "$round" -lt 4 ]; then warn "GitHub did not answer (${why:-no response}); retrying…" >&2; sleep $((round * gap)); fi
  done
  printf '%s' "$why" >"$tmp/lookup.why"
  return 1
}

resolve_release() {
  stage 2 "Finding the release"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/nookdeck-setup.XXXXXX")"
  if [ -n "${NOOKDECK_RELEASE_BASE:-}" ]; then
    base="${NOOKDECK_RELEASE_BASE%/}"; base_is_custom=1
    good "using NOOKDECK_RELEASE_BASE ${C_DIM}($base)${C_OFF}"
    return 0
  fi
  local gh="${NOOKDECK_GITHUB_URL:-https://github.com}"
  gh="${gh%/}"
  if [ -n "${NOOKDECK_GITHUB_URL:-}" ]; then base_is_custom=1; fi
  if [ -n "$version" ]; then
    tag="v$version"
  else
    have curl || fail "curl is missing" "$curl_hint"
    # GitHub answers 5xx now and then; latest_tag retries and falls back to the API.
    tag="$(latest_tag)" || fail "couldn't look up the latest release of $REPO" "$(cat "$tmp/lookup.why" 2>/dev/null) - check your connection and run it again, or pin a release with --version 0.1.1 (or NOOKDECK_VERSION=0.1.1)."
  fi
  base="$gh/$REPO/releases/download/$tag"
  good "using release $tag"
}

# ================================================================ phase 3: fetch_binary
# A previous install leaves $marker holding the sha256 of the release file it came from and of the file on disk (the latter
# differs because it is re-signed locally). Same release sum + untouched file + it still runs = nothing to download.
probe_installed() {
  local want rel_raw rel_inst
  old_version=""
  if [ -x "$bin" ]; then old_version="$(run_bin "$bin" --version 2>/dev/null | head -n1 || true)"; fi
  want="$(sum_for "$asset" "$tmp/SHA256SUMS")"
  up_to_date=0
  if [ "$force" = 0 ] && [ -n "$old_version" ] && [ -n "$want" ] && [ -f "$marker" ]; then
    rel_raw="$(sed -n 's/^raw=\([0-9a-f]*\).*/\1/p' "$marker")"
    rel_inst="$(sed -n 's/.* installed=\([0-9a-f]*\).*/\1/p' "$marker")"
    if [ "$rel_raw" = "$want" ] && [ -n "$rel_inst" ] && [ "$(hash_file "$bin")" = "$rel_inst" ]; then up_to_date=1; fi
  fi
  return 0
}

fetch_binary() {
  stage 3 "Getting the program"
  http_get "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not fetch $base/SHA256SUMS" "Check the release exists and that you are online."
  # The latest release may still be a 0.1.x one (main is pushed before the new release has finished building): it lists
  # phonedesk-* only. Take the nookdeck-* name when it is there, else the old one, and install it as the nookdeck program.
  if ! sum_listed "$asset" "$tmp/SHA256SUMS" && sum_listed "phonedesk-${asset#nookdeck-}" "$tmp/SHA256SUMS"; then
    asset="phonedesk-${asset#nookdeck-}"; legacy_asset=1
    warn "this release is from before the rename ($asset); installing it as nookdeck. Run \`nookdeck update\` once Nookdeck 0.2 is out."
  fi
  probe_installed
  if [ "$up_to_date" = 1 ]; then
    new_version="$old_version"
    good "Nookdeck $(ver_of "$old_version") is up to date ${C_DIM}(checksum verified), skipping the download${C_OFF}"
    return 0
  fi
  # Releases carry a gzip of each binary (about a third of the size); older ones only the plain file.
  local got=0
  if sum_listed "$asset.gz" "$tmp/SHA256SUMS"; then
    say "Fetching $asset.gz$(size_hint "$base/$asset.gz")"
    if http_get_big "$base/$asset.gz" "$tmp/$asset.gz"; then
      sum_check "$tmp/$asset.gz" "$tmp/SHA256SUMS"
      have gzip || fail "gzip is missing" "It is needed to unpack the download."
      gzip -dc "$tmp/$asset.gz" >"$tmp/$asset" || fail "could not unpack $asset.gz"
      rm -f "$tmp/$asset.gz"
      got=1
    else
      warn "the compressed download failed; falling back to the uncompressed binary"
      rm -f "$tmp/$asset.gz"
    fi
  fi
  if [ "$got" = 0 ]; then
    say "Fetching $asset$(size_hint "$base/$asset")"
    http_get_big "$base/$asset" "$tmp/$asset" || fail "could not fetch $base/$asset" "Check your connection, then run the command again."
  fi
}

# ================================================================ phase 3b: verify_binary
verify_binary() {
  if [ "$up_to_date" = 1 ]; then return 0; fi
  sum_check "$tmp/$asset" "$tmp/SHA256SUMS" # always the binary itself, however it arrived
  raw_sha="$(hash_file "$tmp/$asset")"
  chmod 755 "$tmp/$asset"
  if [ "$os" = darwin ] && have xattr; then xattr -d com.apple.quarantine "$tmp/$asset" 2>/dev/null || true; fi
  # A release signed with a certificate keeps that signature: its designated requirement is the same for every release, which is
  # what keeps the Accessibility grant across updates. Only a program without a valid certificate signature is signed ad hoc.
  if [ "$os" = darwin ] && have codesign; then
    if stable_signature "$tmp/$asset"; then good "signed by the release identity ${C_DIM}(kept as it is)${C_OFF}"
    elif codesign --force -s - "$tmp/$asset" >/dev/null 2>&1; then good "signed ad hoc for this Mac"
    else warn "codesign failed; the program may refuse to start"; fi
  fi
  new_version="$("$tmp/$asset" --version 2>/dev/null | head -n1)" || new_version=""
  [ -n "$new_version" ] || fail "the downloaded program does not run on $machine" "It printed no version."
  if [ "$legacy_asset" = 1 ]; then new_version="nookdeck ${new_version#phonedesk }"; fi
  good "$new_version"
}

# PhoneDesk 0.1.x became Nookdeck: an existing ~/.phonedesk is handed to the program's own migration (copies the data and leaves a link,
# replaces the launchd job, re-points the Claude/Codex hooks, installs the phonedesk alias). It keeps the old folder and is safe to repeat.
legacy_handover() {
  local old="$home_dir/.phonedesk"
  [ -d "$old" ] && [ ! -L "$old" ] && [ ! -e "$data_dir" ] || return 0
  if [ "$legacy_asset" = 1 ]; then
    # a 0.1.x program has no `migrate`: copy the data here (the old folder stays) and tell it to use the new place
    handover_done=1
    say "found an existing PhoneDesk install ($old): copying its data to $data_dir"
    cp -Rp "$old" "$data_dir" || { rm -rf "$data_dir"; warn "could not copy $old; your PhoneDesk data is untouched"; return 0; }
    return 0
  fi
  handover_done=1
  say "found an existing PhoneDesk install ($old): moving it to Nookdeck"
  # the old agent must let go of its files first
  if [ -f "$old/agent.pid" ]; then
    local op; op="$(cat "$old/agent.pid" 2>/dev/null || true)"
    case "$op" in ''|*[!0-9]*) ;; *) kill "$op" 2>/dev/null || true; sleep 1 ;; esac
  fi
  # the old login job goes now (it would restart the old agent); the new one is registered below by wire_service with the new program
  local oldplist="$agents_dir/dev.phonedesk.agent.plist" oldport
  if [ -f "$oldplist" ]; then
    oldport="$(sed -n '/<string>--port<\/string>/{n;s/.*<string>\([0-9][0-9]*\)<\/string>.*/\1/p;}' "$oldplist" | head -n1)"
    "${NOOKDECK_LAUNCHCTL:-launchctl}" bootout "gui/$(id -u)/dev.phonedesk.agent" >/dev/null 2>&1 || true
    mv -f "$oldplist" "$oldplist.nookdeck-old"
    good "stopped the old PhoneDesk login service ${C_DIM}(its plist is kept as dev.phonedesk.agent.plist.nookdeck-old)${C_OFF}"
    if [ -n "$oldport" ] && [ "$port" = 7420 ] && [ "$oldport" != 7420 ]; then port="$oldport"; say "keeping the port of your old install: $port"; fi
  fi
  if run_bin "$tmp/$asset" migrate --no-service --port "$port"; then good "your PhoneDesk data, login service and hooks were moved to Nookdeck"
  else warn "the migration reported a problem; your PhoneDesk data is untouched in $old"; fi
}

# ================================================================ phase 4: place_binary
place_binary() {
  stage 4 "Installing"
  say "program   $bin"
  say "your data stays in $data_dir"
  if [ "$up_to_date" = 0 ] && [ -n "$old_version" ]; then say "upgrading from $old_version"; fi
  if [ "$dry" = 1 ]; then
    warn "dry run: nothing was installed, started or changed"
    if [ "$autostart" = 1 ] && [ "$os" = linux ]; then say "would register the systemd user service nookdeck.service (starts at login)"
    elif [ "$autostart" = 1 ]; then say "would register the launchd service dev.nookdeck.agent (starts at login)"; fi
    say "would start Nookdeck on port $port and open http://localhost:$port/manage/"
    exit 0
  fi
  if [ -f "$plist" ] || { [ "$os" = linux ] && [ -f "$autostart_file" ]; }; then svc_before=1; fi
  if [ "$up_to_date" = 1 ]; then bin_state="already set"; return 0; fi
  ask "Install Nookdeck to $bin?" y || fail "cancelled" "Nothing was installed."
  if [ -n "$old_version" ]; then bin_state="updated ($(ver_of "$old_version") -> $(ver_of "$new_version"))"; else bin_state=installed; fi
  legacy_handover
  # let go of the old file: stop the login service first, then an agent we started by hand
  if [ -x "$bin" ]; then run_bin "$bin" service uninstall >/dev/null 2>&1 || true; fi
  if [ -f "$pidfile" ]; then
    local old_pid
    old_pid="$(cat "$pidfile" 2>/dev/null || true)"
    case "$old_pid" in ''|*[!0-9]*) ;; *) kill "$old_pid" 2>/dev/null || true; sleep 1 ;; esac
    rm -f "$pidfile"
  fi
  mkdir -p "$bin_dir" "$log_dir"
  chmod 700 "$data_dir" 2>/dev/null || true
  cp "$tmp/$asset" "$bin_dir/.nookdeck.new"
  chmod 755 "$bin_dir/.nookdeck.new"
  mv -f "$bin_dir/.nookdeck.new" "$bin" # same volume: the swap is atomic
  printf 'raw=%s installed=%s\n' "$raw_sha" "$(hash_file "$bin")" >"$marker"
  good "installed $new_version"
}

# ================================================================ phase 4b: link_cli
RC_LINE='export PATH="$HOME/.nookdeck/bin:$PATH" # nookdeck'
link_cli() {
  if [ "$add_path" = 0 ]; then return 0; fi
  local lb="$home_dir/.local/bin" cur f shell_name files=()
  case ":$PATH:" in
    *":$lb:"*)
      if [ -d "$lb" ] && { [ ! -e "$lb/nookdeck" ] || [ -L "$lb/nookdeck" ]; }; then
        cur="$(readlink "$lb/nookdeck" 2>/dev/null || true)"
        if [ "$cur" = "$bin" ]; then say "nookdeck is already on PATH ($lb/nookdeck)"; path_state=already
        else ln -sf "$bin" "$lb/nookdeck"; good "nookdeck is on PATH ${C_DIM}($lb/nookdeck $G_ARROW $bin)${C_OFF}"; path_state=installed; fi
        path_how=symlink; return 0
      fi ;;
  esac
  shell_name="$(basename "${SHELL:-/bin/zsh}")"
  if [ -f "$home_dir/.zshrc" ]; then files+=("$home_dir/.zshrc"); fi
  # bash on Linux: terminal windows start non-login shells, which read ~/.bashrc (macOS Terminal reads ~/.bash_profile)
  local bash_rc="$home_dir/.bash_profile"
  if [ "$os" = linux ]; then bash_rc="$home_dir/.bashrc"; fi
  if [ -f "$bash_rc" ]; then files+=("$bash_rc"); fi
  if [ "${#files[@]}" = 0 ]; then
    if [ "$shell_name" = bash ]; then files+=("$bash_rc"); else files+=("$home_dir/.zshrc"); fi
  fi
  path_state=already
  for f in "${files[@]}"; do
    if grep -F '# nookdeck' "$f" 2>/dev/null | grep -qF '.nookdeck/bin'; then
      say "nookdeck is already on PATH ($f has the line)"
    else
      if [ -s "$f" ] && [ "$(tail -c1 "$f" | wc -l | tr -d ' ')" = 0 ]; then printf '\n' >>"$f"; fi
      printf '%s\n' "$RC_LINE" >>"$f"
      good "added one PATH line to $f"; path_state=installed
    fi
    path_rc_files="$path_rc_files $f"
  done
  path_how=rc
}

# ================================================================ phase 5: wire_service
# The launchd plist is ours when its checksum matches what we recorded in $marker.
service_current() {
  [ -f "$plist" ] || return 1
  [ "$(sed -n 's/^svc=//p' "$marker" 2>/dev/null)" = "$(hash_file "$plist")" ] || return 1
  if [ "$os" = linux ]; then
    # ExecStart= carries --port only when it is not 7420, each word quoted or not: "--port" "7421"
    if [ "$port" = 7420 ]; then ! grep -qE -- '--port"?([ =]|$)' "$plist"
    else grep -qE -- "--port\"?[ =]\"?$port\"?( |\$)" "$plist"; fi || return 1
    "${systemctl_user[@]}" is-active --quiet "$unit_name" >/dev/null 2>&1
    return
  fi
  if [ "$port" = 7420 ]; then ! grep -qF '<string>--port</string>' "$plist"
  else grep -F -A1 '<string>--port</string>' "$plist" | grep -qF "<string>$port</string>"; fi || return 1
  "${NOOKDECK_LAUNCHCTL:-launchctl}" print "gui/$(id -u)/dev.nookdeck.agent" >/dev/null 2>&1
}
remember_service() {
  [ -f "$plist" ] && [ -f "$marker" ] || return 0
  { grep -v '^svc=' "$marker" || true; printf 'svc=%s\n' "$(hash_file "$plist")"; } >"$marker.tmp" && mv -f "$marker.tmp" "$marker"
}
note_service() { if [ "$svc_before" = 1 ]; then svc_state=updated; else svc_state=installed; fi; remember_service; }

preflight_port() { # something else on the port would answer the health check below: stop and say who
  local owner pid cmd
  already_running=0
  owner="$(port_owner "$port")"
  [ -n "$owner" ] || return 0
  if [ "$up_to_date" = 1 ] && [ "$(agent_line "$port")" = "$new_version" ]; then
    already_running=1; say "agent already running on port $port"; return 0
  fi
  pid="${owner%%$'\t'*}"; cmd="${owner#*$'\t'}"
  # our own program (an older copy, or one a login job started): restart it instead of failing
  case "$cmd" in
    "$bin"*)
      say "stopping the Nookdeck agent that holds port $port (pid $pid), it is started again below"
      if [ "$os" = linux ]; then "${systemctl_user[@]}" stop "$unit_name" >/dev/null 2>&1 || true
      else "${NOOKDECK_LAUNCHCTL:-launchctl}" bootout "gui/$(id -u)/dev.nookdeck.agent" >/dev/null 2>&1 || true; fi
      kill "$pid" 2>/dev/null || true
      local i; for i in 1 2 3 4 5 6 7 8 9 10; do [ -z "$(port_owner "$port")" ] && return 0; sleep 0.5; done
      kill -9 "$pid" 2>/dev/null || true; sleep 1
      [ -z "$(port_owner "$port")" ] && return 0 ;;
  esac
  fail "port $port is taken by process $pid ($cmd)" "Free it with: kill $pid   - or install on another port with --port 7421. The program is in place at $bin; nothing was started."
}

wire_service() {
  stage 5 "Background service"
  link_cli
  local keep=0
  if [ "$autostart" = 1 ] && [ "$up_to_date" = 1 ] && service_current; then keep=1; fi
  if [ "$autostart" = 1 ] && [ "$keep" = 0 ]; then
    ask "Start Nookdeck automatically when you log in?" y || autostart=0
  fi
  if [ "$start" = 1 ]; then preflight_port; fi
  if [ "$autostart" = 1 ] && [ "$keep" = 1 ]; then
    svc_state="already set"; good "service already registered (same program, port $port), leaving it alone"
  elif [ "$autostart" = 1 ]; then
    if [ "$start" = 1 ]; then
      if run_bin "$bin" service install --port "$port"; then
        good "login service registered; it restarts after a crash ${C_DIM}(logs: $log_dir)${C_OFF}"; note_service
      else
        warn "could not register the service; starting without it"; autostart=0
      fi
    elif run_bin "$bin" service install --port "$port" >/dev/null 2>&1; then note_service
    else warn "could not register the service"; fi
  else
    say "no login service (skipped)"
  fi
  # make sure Claude/Codex hooks that already exist point at this binary
  run_bin "$bin" hooks repoint --port "$port" >/dev/null 2>&1 || true
}

# ================================================================ phase 6: launch
launch() {
  stage 6 "Starting Nookdeck"
  if [ "$start" = 0 ]; then say "not started (--no-start). Start it with: $bin"; return 0; fi
  if [ "$autostart" = 0 ] && [ "$already_running" = 0 ]; then
    # exec keeps a single process, so the pid saved here is the agent's own and a later upgrade can stop it
    ( cd "$data_dir" && exec env "${child_env[@]}" nohup "$bin" --port "$port" >>"$log_dir/agent.out.log" 2>>"$log_dir/agent.err.log" </dev/null ) &
    echo $! >"$pidfile"
  fi
  pairing=""
  local n
  for n in $(seq 1 40); do
    if pairing="$(curl -fsS --max-time 2 "http://127.0.0.1:$port/api/pairing" 2>/dev/null)"; then break; fi
    pairing=""; sleep 0.5
  done
  [ -n "$pairing" ] || fail "Nookdeck did not answer on port $port" "See $log_dir/agent.err.log"
  # the answer could come from ANOTHER process on that port: it must be the build installed a moment ago
  local seen=""
  for n in $(seq 1 20); do
    seen="$(agent_line "$port")"
    if [ "$seen" = "$new_version" ]; then break; fi
    sleep 0.5
  done
  if [ "$seen" != "$new_version" ]; then
    fail "the agent on port $port is not the one just installed" "It reports \"${seen:-nothing}\" but we installed \"$new_version\". Another Nookdeck probably owns the port: stop it, or use --port. Last log lines ($log_dir/agent.err.log):
$(tail -n 8 "$log_dir/agent.err.log" 2>/dev/null | sed 's/^/      /' || true)"
  fi
  good "agent is up on port $port"
}

# ================================================================ summary
pairing=""
summary() {
  local pin url url_local
  printf '\n%s  ── Nookdeck ─────────────────────────%s\n' "$C_BRAND" "$C_OFF"
  printf '  %-9s %s\n' Program "$bin_state" PATH "${path_state/already/already set}" Service "$svc_state"
  if [ "$start" = 1 ] && [ -n "$pairing" ]; then
    pin="$(printf '%s' "$pairing" | sed -n 's/.*"pin"[[:space:]]*:[[:space:]]*"\{0,1\}\([0-9]*\)"\{0,1\}.*/\1/p')"
    url="$(printf '%s' "$pairing" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    url_local="$(printf '%s' "$pairing" | sed -n 's/.*"urlLocal"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    local lines="" tag u lbl label_shown=0
    # one Phone line per address a phone could use, the default first (nookdeck pair --plain prints: mark, url, label)
    lines="$("$bin" pair --plain --port "$port" 2>/dev/null | grep -v '^PIN' || true)"
    if [ -n "$lines" ]; then
      while IFS=$'\t' read -r tag u lbl; do
        [ -n "$u" ] || continue
        if [ "$label_shown" = 0 ]; then printf '  %-9s %s%s\n' Phone "$u" "  ${lbl:+($lbl) }${C_DIM}(default)${C_OFF}"; label_shown=1
        else printf '  %-9s %s%s\n' "" "$u" "${lbl:+  ($lbl)}"; fi
      done <<<"$lines"
      printf '  %-9s %s\n' PIN "${pin:-see the logs}" Manage "http://localhost:$port/manage/"
    else
      printf '  %-9s %s\n' Phone "${url:-http://<$( [ "$os" = linux ] && echo this-computer || echo this-mac )>:$port}" PIN "${pin:-see the logs}" Manage "http://localhost:$port/manage/"
    fi
    printf '%s  ───────────────────────────────────────%s\n' "$C_BRAND" "$C_OFF"
    if [ -t 1 ] && [ -n "$pin" ] && [ -n "$url" ]; then printf '\n'; "$bin" qr "$url" 2>/dev/null || true; fi
    say "On a phone on the same Wi-Fi, open the Phone address and type the PIN (or scan the code)."
    # macOS: open. Linux: xdg-open, and only in a desktop session (never `open`, which is openvt on some distributions)
    local opener=""
    if [ "$os" = darwin ] && have open; then opener=open
    elif [ "$os" = linux ] && have xdg-open && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then opener=xdg-open; fi
    if [ "$open_page" = 1 ] && [ -n "$opener" ] && [ -z "${NOOKDECK_INSTALL_HOME:-}" ] && ! { [ "$up_to_date" = 1 ] && [ "$already_running" = 1 ]; }; then
      if ask "Open the manage page now?" y; then "$opener" "http://localhost:$port/manage/" >/dev/null 2>&1 || true; fi
    fi
  else
    printf '%s  ───────────────────────────────────────%s\n' "$C_BRAND" "$C_OFF"
  fi
  if [ "$add_path" = 1 ] && [ "$path_how" = rc ] && [ "$path_state" = installed ]; then
    local rc="${path_rc_files# }"; rc="${rc%% *}"
    say "New terminal windows will find nookdeck; try: nookdeck doctor"
    say "This window: source ${rc/#$home_dir/~}   (or: export PATH=\"\$HOME/.nookdeck/bin:\$PATH\")"
  elif [ "$add_path" = 1 ] && [ -n "$path_how" ]; then
    say "Try: nookdeck doctor   (nookdeck is on your PATH)"
  else
    say "Try: $bin doctor"
  fi
  say "To upgrade, run the same command again. To remove: uninstall.sh (see the README)."
}

# ================================================================ main
banner
if [ "$analytics" = 1 ]; then say "${C_DIM}Sends an anonymous install count to nookdeck.app (opt out: NOOKDECK_NO_ANALYTICS=1)${C_OFF}"; fi
detect_platform
track install_started
resolve_release
fetch_binary
verify_binary
place_binary
wire_service
launch
summary
if [ "$handover_done" = 1 ]; then a_mode=migrated; elif [ -n "$old_version" ]; then a_mode=upgrade; else a_mode=fresh; fi
track install_finished "mode=$a_mode" "version=$(ver_of "$new_version")" "from_version=$(ver_of "$old_version")"
