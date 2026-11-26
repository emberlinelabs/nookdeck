#!/bin/sh
# The body of one GitHub release: the "## Nookdeck <version>" section of .github/release-notes.md (with or without ": title"),
# then its "## Install" and "## Files" sections. Every other version stays in the file only.
# Usage: scripts/release-body.sh v0.6.1 [notes-file]
v="${1#v}"
file="${2:-.github/release-notes.md}"
awk -v head="## Nookdeck $v" '
  /^## / {
    keep = ($0 == head || index($0, head ":") == 1 || $0 == "## Install" || $0 == "## Files")
  }
  keep
' "$file"
