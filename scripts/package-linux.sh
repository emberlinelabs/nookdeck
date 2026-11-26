#!/bin/sh
# Builds the Linux packages of one architecture (spec linux-support L7):
#   nookdeck_<v>_<amd64|arm64>.deb, nookdeck-<v>.<x86_64|aarch64>.rpm and nookdeck-linux-<x64|arm64>.tar.gz
# Usage: sh scripts/package-linux.sh <amd64|arm64> <agent binary> <tray binary> [outdir]
#   NOOKDECK_VERSION   the version (default: package.json)
#   ICONS_DIR          app-<22|24|32|48|64|128|256>.png and app.svg (default: apps/shared/icons/linux)
#   NFPM               the nfpm to run (default: nfpm on PATH, else `go run` of the pinned version)
# The tarball needs no installer: nookdeck/nookdeck-tray finds the agent at nookdeck/agent/nookdeck next to it,
# the same layout as the Windows portable zip.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
[ $# -ge 3 ] || { echo "usage: sh scripts/package-linux.sh <amd64|arm64> <agent> <tray> [outdir]" >&2; exit 2; }
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
arch="$1"; agent="$(abs "$2")"; tray="$(abs "$3")"; out="$(abs "${4:-dist}")"
case "$arch" in
  amd64) rpm_arch=x86_64; tar_arch=x64 ;;
  arm64) rpm_arch=aarch64; tar_arch=arm64 ;;
  *) echo "unknown architecture: $arch (amd64 or arm64)" >&2; exit 2 ;;
esac
version="${NOOKDECK_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$root/package.json" | head -n1)}"
icons="$(abs "${ICONS_DIR:-$root/apps/shared/icons/linux}")"
for f in "$agent" "$tray" "$icons/app.svg" "$icons/app-22.png" "$icons/app-24.png" "$icons/app-32.png" "$icons/app-48.png" "$icons/app-64.png" "$icons/app-128.png" "$icons/app-256.png"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 1; }
done
NFPM_VERSION_PIN=v2.49.0
if [ -n "${NFPM:-}" ]; then nfpm="$NFPM"
elif command -v nfpm >/dev/null 2>&1; then nfpm=nfpm
else nfpm="go run github.com/goreleaser/nfpm/v2/cmd/nfpm@$NFPM_VERSION_PIN"; fi
mkdir -p "$out"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
# nfpm expands variables in a few fields only, not in contents: fill them in here (paths with | would break the sed)
esc() { printf '%s' "$1" | sed 's/[&\\]/\\&/g'; }
sed -e "s|\${NFPM_ARCH}|$(esc "$arch")|g" -e "s|\${NFPM_VERSION}|$(esc "$version")|g" -e "s|\${NFPM_AGENT}|$(esc "$agent")|g" \
    -e "s|\${NFPM_TRAY}|$(esc "$tray")|g" -e "s|\${NFPM_ICONS}|$(esc "$icons")|g" -e "s|\${NFPM_ROOT}|$(esc "$root")|g" \
    "$root/packaging/linux/nfpm.yaml" > "$stage/nfpm.yaml"
if grep -q '${NFPM_[A-Z]*}' "$stage/nfpm.yaml"; then echo "nfpm.yaml: a variable was not filled in" >&2; exit 1; fi
deb="$out/nookdeck_${version}_${arch}.deb"
rpm="$out/nookdeck-${version}.${rpm_arch}.rpm"
$nfpm package --config "$stage/nfpm.yaml" --packager deb --target "$deb"
$nfpm package --config "$stage/nfpm.yaml" --packager rpm --target "$rpm"

# the tarball: run nookdeck/nookdeck-tray from anywhere; the .desktop entry and icons are there to copy by hand
d="$stage/nookdeck"
mkdir -p "$d/agent" "$d/share/applications"
cp "$tray" "$d/nookdeck-tray"; cp "$agent" "$d/agent/nookdeck"; chmod 755 "$d/nookdeck-tray" "$d/agent/nookdeck"
cp "$root/packaging/linux/dev.nookdeck.app.desktop" "$d/share/applications/"
for n in 22 24 32 48 64 128 256; do mkdir -p "$d/share/icons/hicolor/${n}x${n}/apps"; cp "$icons/app-$n.png" "$d/share/icons/hicolor/${n}x${n}/apps/dev.nookdeck.app.png"; done
mkdir -p "$d/share/icons/hicolor/scalable/apps"; cp "$icons/app.svg" "$d/share/icons/hicolor/scalable/apps/dev.nookdeck.app.svg"
cp "$root/LICENSE" "$d/LICENSE"
cp "$root/packaging/linux/README-tarball.txt" "$d/README.txt"
tarball="$out/nookdeck-linux-$tar_arch.tar.gz"
# a stable archive: sorted names, fixed owner and time, gzip without a timestamp
(cd "$stage" && find nookdeck -print | LC_ALL=C sort > "$stage/list" \
  && tar --no-recursion --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 00:00:00Z' -cf - -T "$stage/list" 2>/dev/null \
     || tar --no-recursion --uid 0 --gid 0 -cf - -T "$stage/list") | gzip -9 -n > "$tarball"
ls -l "$deb" "$rpm" "$tarball"
