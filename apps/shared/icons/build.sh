#!/bin/sh
# Regenerates every icon in this folder from src/*.svg. Needs rsvg-convert and magick (ImageMagick); the .icns step needs macOS iconutil.
# Run from anywhere: sh apps/shared/icons/build.sh
set -e
cd "$(dirname "$0")"
mkdir -p macos windows

# (src/flat-*.svg come from src/flatten.py: uv run --with shapely python src/flatten.py)
# ---- macOS menu bar: template images (black + alpha; macOS tints them). 18 pt, @1x and @2x, plus a PDF each. ----
for s in running stopped attention; do
  rsvg-convert -w 18 -h 18 "src/glyph-$s-black.svg" -o "macos/nookdeck-${s}Template.png"
  rsvg-convert -w 36 -h 36 "src/glyph-$s-black.svg" -o "macos/nookdeck-${s}Template@2x.png"
  # The PDF uses the flattened glyph (one compound path, no masks); 72 dpi so 18 px = 18 pt.
  rsvg-convert -f pdf --dpi-x 72 --dpi-y 72 "src/flat-$s.svg" -o "macos/nookdeck-${s}Template.pdf"
done
cp macos/nookdeck-runningTemplate.png macos/nookdeckTemplate.png
cp macos/nookdeck-runningTemplate@2x.png macos/nookdeckTemplate@2x.png
cp macos/nookdeck-runningTemplate.pdf macos/nookdeckTemplate.pdf

# ---- macOS app icon ----
rsvg-convert -w 1024 -h 1024 src/app-icon.svg -o macos/AppIcon-1024.png
if command -v iconutil >/dev/null 2>&1; then
  set_dir=$(mktemp -d)/AppIcon.iconset
  mkdir -p "$set_dir"
  for n in 16 32 128 256 512; do
    rsvg-convert -w $n -h $n src/app-icon.svg -o "$set_dir/icon_${n}x${n}.png"
    rsvg-convert -w $((n * 2)) -h $((n * 2)) src/app-icon.svg -o "$set_dir/icon_${n}x${n}@2x.png"
  done
  iconutil -c icns "$set_dir" -o macos/AppIcon.icns
  rm -rf "$(dirname "$set_dir")"
fi

# ---- Windows tray: one .ico per taskbar theme and state. "light" = for a light taskbar (dark glyph); "dark" = for a dark taskbar (white glyph). ----
ico() { # ico <svg> <out.ico>
  tmp=$(mktemp -d)
  for n in 16 20 24 32; do rsvg-convert -w $n -h $n "$1" -o "$tmp/$n.png"; done
  magick "$tmp/16.png" "$tmp/20.png" "$tmp/24.png" "$tmp/32.png" "$2"
  rm -rf "$tmp"
}
for s in running stopped attention; do
  ico "src/glyph-$s-black.svg" "windows/tray-light-$s.ico"
  ico "src/glyph-$s-white.svg" "windows/tray-dark-$s.ico"
done
cp windows/tray-light-running.ico windows/tray-light.ico
cp windows/tray-dark-running.ico windows/tray-dark.ico

# ---- Windows app icon (installer, shortcuts, exe) ----
tmp=$(mktemp -d)
for n in 16 24 32 48 64 128 256; do rsvg-convert -w $n -h $n src/app-icon-win.svg -o "$tmp/$n.png"; done
magick "$tmp/16.png" "$tmp/24.png" "$tmp/32.png" "$tmp/48.png" "$tmp/64.png" "$tmp/128.png" "$tmp/256.png" windows/app.ico
rm -rf "$tmp"
rsvg-convert -w 512 -h 512 src/app-icon-win.svg -o app-512.png
echo "icons built"
