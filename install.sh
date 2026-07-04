#!/usr/bin/env bash
set -euo pipefail

UUID="ccusage-panel@raphael.local"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

if ! command -v gnome-extensions >/dev/null 2>&1; then
  echo "gnome-extensions was not found. Install GNOME Shell extension tooling first." >&2
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx was not found. Install Node.js and npm first." >&2
  exit 1
fi

mkdir -p "$TARGET_DIR"
cp "$SOURCE_DIR/metadata.json" \
   "$SOURCE_DIR/extension.js" \
   "$SOURCE_DIR/stylesheet.css" \
   "$SOURCE_DIR/ccusage-panel-helper.sh" \
   "$SOURCE_DIR/README.md" \
   "$TARGET_DIR/"
chmod +x "$TARGET_DIR/ccusage-panel-helper.sh"

gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
gnome-extensions enable "$UUID" >/dev/null 2>&1 || true

cat <<EOF
Installed $UUID to:
$TARGET_DIR

If GNOME does not show it immediately:
- X11: press Alt+F2, type r, press Enter
- Wayland: log out and log back in
EOF
