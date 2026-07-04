# ccusage Panel

GNOME Shell top bar indicator for Claude Code and Codex usage, powered by [`ccusage`](https://www.npmjs.com/package/ccusage).

It shows a compact top bar label such as `AI $12.34` and a dropdown with today's Claude/Codex usage, Claude billing-block reset time when `ccusage` exposes it, weekly total, monthly total, last refresh time, a manual refresh action, and error details when `ccusage` cannot return usable data.

## Requirements

- GNOME Shell 45 or newer
- Linux desktop session with GNOME Shell extensions enabled
- Node.js, npm, and npx
- `ccusage` data from Claude Code and/or Codex

No Electron app, background daemon, API key prompt, or long-running service is used. The extension calls:

```sh
npx -y ccusage@latest claude daily --json
npx -y ccusage@latest codex daily --json
npx -y ccusage@latest weekly --json
npx -y ccusage@latest monthly --json
npx -y ccusage@latest claude blocks --json
```

Each command is run asynchronously through `Gio.Subprocess` with a 15 second timeout, so GNOME Shell should not freeze.

## Install

Clone the repository and run:

```sh
./install.sh
```

Then enable the extension:

```sh
gnome-extensions enable ccusage-panel@raphael.local
```

If GNOME does not see it immediately:

- X11: press `Alt+F2`, type `r`, press Enter
- Wayland: log out and log back in

## Manual Install

```sh
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/ccusage-panel@raphael.local"
mkdir -p "$EXT_DIR"
cp metadata.json extension.js ccusage-panel-helper.sh README.md "$EXT_DIR/"
cp stylesheet.css "$EXT_DIR/"
chmod +x "$EXT_DIR/ccusage-panel-helper.sh"
gnome-extensions enable ccusage-panel@raphael.local
```

## Debugging

```sh
gnome-extensions list | grep ccusage
gnome-extensions info ccusage-panel@raphael.local
journalctl /usr/bin/gnome-shell -f
npx -y ccusage@latest daily --json
```

If the JSON structure returned by `ccusage` cannot be parsed, the extension writes the last raw response to:

```sh
~/.cache/ccusage-panel/last-raw.json
```

## Uninstall

```sh
gnome-extensions disable ccusage-panel@raphael.local
rm -rf "$HOME/.local/share/gnome-shell/extensions/ccusage-panel@raphael.local"
rm -rf "$HOME/.cache/ccusage-panel"
```

On Wayland, log out and log back in after uninstalling if the old panel item remains visible until the shell reloads.

## License

MIT
