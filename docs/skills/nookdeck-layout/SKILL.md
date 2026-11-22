---
name: phonedesk-layout
description: Arrange the PhoneDesk phone deck (pages, buttons, widgets, icons, theme) through the phonedesk MCP server. Use when the user asks to organise, design, rearrange or restyle their PhoneDesk screen.
---

# Arranging a PhoneDesk deck

The `phonedesk` MCP server edits the layout of the running agent. Changes reach connected phones at once, and `undo` reverts the last 50 saves.

## Workflow

1. `get_layout` first. It shows an ASCII grid per page and a legend with item ids, positions (x,y, 0-based) and sizes (wxh).
2. Plan the whole page, then run `preview_changes` with all operations and read the resulting grid.
3. Apply the operations one by one (`add_item`, `move_item`, `resize_item`, `update_item`, `remove_item`, `add_page`, `set_theme`).
4. `get_layout` again to confirm. If the user dislikes it, call `undo`.

Placing on an occupied cell pushes the tiles in the way to the nearest free spot of the same page; if nothing fits the change is rejected with free spots listed. Never remove a user's item unless asked.

## Design rules

- Group by function: media together, system stats together, launchers together, one page per theme (for example Work, Media, AI, Smart home).
- Big widgets (clock, now playing, quota) go top-left; they are what the eye lands on first.
- The phone is held in landscape: put the most frequently pressed buttons in the bottom rows, where thumbs rest.
- Keep sizes consistent per row. Mixed 1x1 and 2x2 in one row looks messy; use one size per row and let widgets span whole rows.
- Brand colours: the default accent is cyan `#22d3ee` (deep `#155e75`). Green `#34d399` is reserved for live/connected status; do not use it as a decorative or accent colour, and violet is not a default anywhere (it is only a selectable preset).
- Use one or two accent colours per page. Colour means something (red for destructive or stop, green for go); do not rainbow.
- Launchers use `app:<bundleId>` icons from `list_apps`, so the real app icon shows. Brand marks: `lobe:<name>`. Generic actions: Tabler names from `search_icons`.
- Keep pages at most 80 percent full, so the user can add things later and tiles stay large enough to hit.
- Short labels (one or two words). Hide the label (`hideLabel`) when the icon is obvious, such as an app icon.
- Always `preview_changes` before saving a multi-step rearrangement.

## Reference

- Widgets: clock, cpu, memory, uptime, load, network, nowplaying, quota, sessions, entity (Home Assistant).
- Button actions: open, hotkey, type, shell, media, volume, page, sound, sound-stop, hass.
- Theme fields: mode, accent, background, tile, radius, gap, fontScale, tileStyle (tint, solid, outline, ios), iconScale, iconStroke, showLabels, text, orientation.
