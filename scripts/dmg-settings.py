# dmgbuild settings for Nookdeck.dmg. dmgbuild writes the .DS_Store itself (no Finder, no AppleScript), so it works on headless CI.
# Everything variable comes from `-D key=value` (scripts/build-macos-app.ts passes them); the layout numbers live in that script (DMG_LAYOUT).
import os

d = defines  # noqa: F821  (provided by dmgbuild)
app = d["app"]

files = [app]
symlinks = {"Applications": "/Applications"}
icon = d.get("volicon") or None  # becomes .VolumeIcon.icns
if d.get("size"):
    size = int(d["size"])  # bytes; explicit because the automatic estimate is too small on some CI runners
format = "UDZO"
filesystem = "HFS+"

# the Finder window: no toolbar, sidebar, status bar or path bar; icon view, 128 pt icons
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
default_view = "icon-view"
arrange_by = None
icon_size = int(d["icon_size"])
text_size = 13
w, h = int(d["width"]), int(d["height"])
# the window height includes the 28 pt title bar; the content area (where icon_locations and the background live) is w x h
window_rect = ((200, 120), (w, h + 28))
icon_locations = {
    os.path.basename(app): (int(d["app_x"]), int(d["app_y"])),
    "Applications": (int(d["apps_x"]), int(d["apps_y"])),
}
if d.get("background"):
    background = d["background"]  # a png (a sibling background@2x.png is picked up for Retina) or a multi-representation tiff
