#!/usr/bin/env bash
# Take Nookdeck off a Mac: service, hooks, PATH entries and the program. Your data stays unless you say --purge.
#
# Usage
#   curl -fsSL https://raw.githubusercontent.com/howznguyen/nookdeck/main/uninstall.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/howznguyen/nookdeck/main/uninstall.sh | bash -s -- --purge
#
# What goes
#   - the launchd login service and any agent started by hand
#   - the hooks Nookdeck added to Claude Code and Codex (only our entries; <file>.nookdeck.bak is written first)
#   - the ~/.local/bin symlink and the "# nookdeck" PATH line in ~/.zshrc / ~/.bash_profile
#   - the program in ~/.nookdeck/bin
# What stays: ~/.nookdeck (layout, paired phones, settings) - unless --purge.
#
# Flags
#   --purge       also delete ~/.nookdeck and the Home Assistant token Nookdeck keeps in the Keychain
#   -y, --yes     ask nothing
#   --dry-run     list what would go, change nothing
#   --no-analytics  send no anonymous "uninstalled" count (NOOKDECK_NO_ANALYTICS=1 or DO_NOT_TRACK=1 do the same)
#   -h, --help    show this text
#
# Test hook: NOOKDECK_INSTALL_HOME works below this directory instead of $HOME.
set -euo pipefail

REPO="howznguyen/nookdeck"
purge=0; yes=0; dry=0; a_want=1; analytics=0

C_BRAND=""; C_BOLD=""; C_GOOD=""; C_WARN=""; C_BAD=""; C_OFF=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
  case "${COLORTERM:-}" in
    truecolor|24bit) C_BRAND=$'\033[38;2;34;211;238m' ;;
    *) C_BRAND=$'\033[38;5;45m' ;;
  esac
  C_BOLD=$'\033[1m'; C_GOOD=$'\033[32m'; C_WARN=$'\033[33m'; C_BAD=$'\033[31m'; C_OFF=$'\033[0m'
fi
G_OK="✓"; G_WARN="!"; G_BAD="✗"; G_ARROW="→"
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in C|POSIX) G_OK="ok"; G_BAD="x"; G_ARROW="->" ;; esac

say()   { printf '  %s\n' "$*"; }
good()  { printf '  %s%s%s %s\n' "$C_GOOD" "$G_OK" "$C_OFF" "$*"; }
warn()  { printf '  %s%s%s %s\n' "$C_WARN" "$G_WARN" "$C_OFF" "$*"; }
stage() { printf '\n%s[%s/%s]%s %s%s%s\n' "$C_BRAND" "$1" 4 "$C_OFF" "$C_BOLD" "$2" "$C_OFF"; }
fail() {
  printf '\n%s%s %s%s\n' "$C_BAD" "$G_BAD" "$1" "$C_OFF" >&2
  if [ -n "${2:-}" ]; then printf '  %s\n' "$2" >&2; fi
  printf '\n  Need help? https://github.com/%s/issues\n' "$REPO" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

# Anonymous count (opt out: --no-analytics, NOOKDECK_NO_ANALYTICS=1, DO_NOT_TRACK=1): os, os version, arch and the fact that it was uninstalled.
# Never a host name, user name, path, IP or token. Fire and forget: 3 seconds at most, in the background, errors swallowed.
a_clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9_ .,:+()/-' | cut -c1-64; }
track() { # track NAME
  [ "$analytics" = 1 ] || return 0
  have curl || return 0
  local body
  body="{\"name\":\"$(a_clean "$1")\",\"os\":\"macos\",\"os_version\":\"$(a_clean "$a_osver")\",\"arch\":\"$(a_clean "$a_arch")\",\"installer\":\"uninstall.sh\"}"
  case "$1" in
    __never__) ( curl -sS -m 3 -X POST -H 'content-type: application/json' --data "$body" "$analytics_url" >/dev/null 2>&1 & ) >/dev/null 2>&1 || true ;;
    # the last event waits (2 s at most): a closing terminal or ssh session would kill a background curl
    *) curl -sS -m 2 -X POST -H 'content-type: application/json' --data "$body" "$analytics_url" >/dev/null 2>&1 || true ;;
  esac
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) purge=1 ;;
    -y|--yes) yes=1 ;;
    --dry-run) dry=1 ;;
    --no-analytics) a_want=0 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unrecognised flag: $1" "Run with --help to see the flags." ;;
  esac
  shift
done

analytics_url="${NOOKDECK_ANALYTICS_URL:-https://nookdeck.app/api/event}"
for v in "${NOOKDECK_NO_ANALYTICS:-}" "${DO_NOT_TRACK:-}"; do case "$v" in 1|true|TRUE|yes) a_want=0 ;; esac; done
if [ "$a_want" = 1 ] && [ "$dry" = 0 ]; then
  if [ -n "${NOOKDECK_ANALYTICS_URL:-}" ] || { [ -z "${NOOKDECK_INSTALL_HOME:-}" ] && [ -z "${NOOKDECK_TEST_SANDBOX:-}" ]; }; then analytics=1; fi
fi
if [ "$analytics" = 1 ]; then
  a_osver="$(sw_vers -productVersion 2>/dev/null || true)"
  case "$(uname -m)" in arm64|aarch64) a_arch=arm64 ;; *) a_arch=x64 ;; esac
  say "Sends an anonymous uninstall count to nookdeck.app (opt out: NOOKDECK_NO_ANALYTICS=1)"
fi

tty_ok=0
if (: </dev/tty) 2>/dev/null; then tty_ok=1; fi
ask() { # ask "question" y|n -> status 0 for yes
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

home_dir="${NOOKDECK_INSTALL_HOME:-$HOME}"
data_dir="$home_dir/.nookdeck"
bin_dir="$data_dir/bin"
bin="$bin_dir/nookdeck"
pidfile="$data_dir/agent.pid"
agents_dir="${NOOKDECK_LAUNCH_AGENTS_DIR:-$home_dir/Library/LaunchAgents}"
plist="$agents_dir/dev.nookdeck.agent.plist"
child_env=(NOOKDECK_HOME="$data_dir")
if [ -n "${NOOKDECK_INSTALL_HOME:-}" ]; then
  child_env+=(NOOKDECK_LAUNCH_AGENTS_DIR="$agents_dir" NOOKDECK_CLAUDE_DIR="${NOOKDECK_CLAUDE_DIR:-$home_dir/.claude}" NOOKDECK_CODEX_DIR="${NOOKDECK_CODEX_DIR:-$home_dir/.codex}")
fi

# never delete anything outside a directory that is clearly Nookdeck's
case "$data_dir" in */.nookdeck) ;; *) fail "refusing to touch $data_dir" "It does not look like a Nookdeck data directory." ;; esac

# ---------------------------------------------------------------- the plan
printf '\n%s  Nookdeck%s  uninstaller for macOS\n' "$C_BRAND" "$C_OFF"
printf '\n  This will remove:\n'
say "  - the login service (dev.nookdeck.agent) and any running agent"
say "  - Nookdeck's hooks in Claude Code and Codex (backups: <file>.nookdeck.bak)"
say "  - the PATH entries: ~/.local/bin/nookdeck and the '# nookdeck' line in ~/.zshrc / ~/.bash_profile"
say "  - the program: $bin_dir"
if [ "$purge" = 1 ]; then say "  - ALL your data: $data_dir (layout, paired phones, icons, sounds, settings)"
else say "  Your data in $data_dir stays (add --purge to delete it too)."; fi
if [ "$dry" = 1 ]; then warn "dry run: nothing was changed"; exit 0; fi
ask "Continue?" y || fail "cancelled" "Nothing was removed."
if [ "$purge" = 1 ] && [ "$yes" = 0 ]; then ask "Really delete $data_dir? This cannot be undone." n || fail "cancelled" "Nothing was removed."; fi

# ---------------------------------------------------------------- 1 service
stop_service() {
  stage 1 "Stopping Nookdeck"
  if [ -x "$bin" ]; then
    env "${child_env[@]}" "$bin" service uninstall || warn "the service command failed"
  elif [ -f "$plist" ]; then
    # the program is already gone: unload and delete the plist by hand
    ${NOOKDECK_LAUNCHCTL:-launchctl} bootout "gui/$(id -u)/dev.nookdeck.agent" >/dev/null 2>&1 || true
    rm -f "$plist"; good "removed $plist"
  else
    say "no login service found"
  fi
  # a leftover PhoneDesk 0.1.x login job (an install that never ran the migration)
  if [ -f "$agents_dir/dev.phonedesk.agent.plist" ]; then
    ${NOOKDECK_LAUNCHCTL:-launchctl} bootout "gui/$(id -u)/dev.phonedesk.agent" >/dev/null 2>&1 || true
    rm -f "$agents_dir/dev.phonedesk.agent.plist"; good "removed the old PhoneDesk login service"
  fi
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    case "$pid" in ''|*[!0-9]*) ;; *) if kill "$pid" 2>/dev/null; then good "stopped the agent (pid $pid)"; fi ;; esac
    rm -f "$pidfile"
  fi
}

# ---------------------------------------------------------------- 2 hooks
drop_hooks() {
  stage 2 "Removing hooks"
  if [ -x "$bin" ]; then
    env "${child_env[@]}" "$bin" hooks remove || warn "could not remove the hooks; delete entries ending in '# nookdeck hook' from ~/.claude/settings.json and ~/.codex/hooks.json by hand"
  else
    warn "the program is already gone, so the hooks cannot be removed automatically: delete entries ending in '# nookdeck hook' from ~/.claude/settings.json and ~/.codex/hooks.json"
  fi
}

# ---------------------------------------------------------------- 3 PATH
drop_path() {
  stage 3 "Cleaning PATH"
  local any=0 f link="$home_dir/.local/bin/nookdeck"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$bin" ]; then rm -f "$link"; good "removed the symlink $link"; any=1; fi
  for f in "$home_dir/.zshrc" "$home_dir/.bash_profile"; do
    [ -f "$f" ] || continue
    if grep -F '# nookdeck' "$f" | grep -qF '.nookdeck/bin'; then
      cp "$f" "$f.nookdeck.bak"
      # drop only lines carrying our marker AND pointing at .nookdeck/bin; every other line keeps its place
      awk '{ if (index($0, "# nookdeck") && index($0, ".nookdeck/bin")) next; print }' "$f" >"$f.nookdeck.tmp"
      cat "$f.nookdeck.tmp" >"$f"; rm -f "$f.nookdeck.tmp"
      good "removed the PATH line from $f (backup: $f.nookdeck.bak)"; any=1
    fi
  done
  if [ "$any" = 0 ]; then say "no PATH entries found"; fi
}

# ---------------------------------------------------------------- 4 files
drop_files() {
  stage 4 "Deleting files"
  if [ -d "$bin_dir" ]; then rm -rf "$bin_dir"; good "removed $bin_dir"; else say "$bin_dir was not there"; fi
  if [ "$purge" = 1 ]; then
    rm -rf "$data_dir"; good "removed $data_dir"
    # the link the migration left at the old path (a real old folder is never touched)
    if [ -L "$home_dir/.phonedesk" ]; then rm -f "$home_dir/.phonedesk"; good "removed the link $home_dir/.phonedesk"; fi
    if have security && [ -z "${NOOKDECK_INSTALL_HOME:-}" ]; then security delete-generic-password -s PhoneDesk-HASS >/dev/null 2>&1 || true; fi
    # the Home Assistant token may live in the Keychain
    if have security && [ -z "${NOOKDECK_INSTALL_HOME:-}" ]; then
      if security delete-generic-password -s Nookdeck-HASS >/dev/null 2>&1; then good "removed the Home Assistant token from the Keychain"; fi
    fi
  fi
}

stop_service
drop_hooks
drop_path
drop_files
printf '\n%s  ✓ Nookdeck is gone.%s\n' "$C_GOOD" "$C_OFF"
if [ "$dry" = 0 ]; then track uninstall_finished; fi
