#!/bin/sh
# Builds the Windows tray app. Run from anywhere: sh apps/windows/build.sh [outdir]
#   copies the shared strings and icons next to the code (go:embed cannot reach ../shared), runs the tests, then cross-compiles
#   dist/Nookdeck.exe (GUI subsystem, no console, no cgo). Works on macOS, Linux and Windows (Git Bash).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
# an outdir given relative is relative to where the script was run from, not to apps/windows
case "${1:-}" in "") out="$here/dist" ;; /*|[A-Za-z]:*) out="$1" ;; *) out="$PWD/$1" ;; esac
[ -z "${AGENT_EXE:-}" ] || case "$AGENT_EXE" in /*|[A-Za-z]:*) ;; *) AGENT_EXE="$PWD/$AGENT_EXE" ;; esac
cd "$here"
mkdir -p internal/core/assets cmd/nookdeck-tray/assets "$out"
cp ../shared/strings.json internal/core/assets/strings.json
cp ../shared/icons/windows/tray-*.ico ../shared/icons/windows/app.ico cmd/nookdeck-tray/assets/
version="${NOOKDECK_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' ../../package.json | head -n1)}"
export CGO_ENABLED=0
if [ "${SKIP_TESTS:-}" != 1 ]; then go test ./internal/... ; fi
# the icon and version resource of the exe (goversioninfo-free: a plain .syso is not needed, the icon is set at runtime and by the installer)
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-H=windowsgui -s -w -X main.version=$version" -o "$out/Nookdeck.exe" ./cmd/nookdeck-tray
ls -l "$out/Nookdeck.exe"

# a folder (and zip) that runs without the installer: Nookdeck.exe sets the agent up on its first start, exactly as after Nookdeck-Setup.exe.
# Needs the Windows agent: AGENT_EXE=path/to/nookdeck-windows-x64.exe (bun run build:win makes dist/nookdeck-windows-x64.exe at the repo root).
agent="${AGENT_EXE:-../../dist/nookdeck-windows-x64.exe}"
if [ -f "$agent" ]; then
  rm -rf "$out/portable"; mkdir -p "$out/portable/agent"
  cp "$out/Nookdeck.exe" "$out/portable/Nookdeck.exe"
  cp "$agent" "$out/portable/agent/nookdeck.exe"
  (cd "$out/portable" && rm -f ../Nookdeck-portable.zip && zip -qr ../Nookdeck-portable.zip .)
  ls -l "$out/Nookdeck-portable.zip"
else
  echo "(no Windows agent at $agent: skipped the portable zip; set AGENT_EXE or run: bun run build:win)"
fi
