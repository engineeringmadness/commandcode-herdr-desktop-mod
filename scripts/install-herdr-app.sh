#!/bin/sh
# Install the Herdr app companion for the herdr-status mod.
#
# Herdr app 0.1.16's shipped agents pane only draws sub-agents that are herdr-core
# child terminals. This copies that mod, patches it to draw OSC 7501
# `subagents/...` records too, clones the main layout to use the copy, and
# switches to it. Your original `main` mod and layout are untouched.
#
# Usage: sh scripts/install-herdr-app.sh [--uninstall]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
HERDR_HOME=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
MODS="$HERDR_HOME/mods"
LAYOUTS="$HERDR_HOME/layouts"
SOURCE="$MODS/agents"
CLONE="$MODS/agents-records"
RECORDS="$LAYOUTS/main-records.json"

find_app() {
	if [ -n "${HERDR_APP:-}" ]; then
		printf '%s\n' "$HERDR_APP"
		return
	fi
	if command -v herdr-app >/dev/null 2>&1; then
		command -v herdr-app
		return
	fi
	for candidate in "$HOME/.local/bin/herdr-app" "$HOME/Applications/Herdr.app/Contents/MacOS/herdr-app"; do
		if [ -x "$candidate" ]; then
			printf '%s\n' "$candidate"
			return
		fi
	done
}

APP=$(find_app || true)
RUNNING=0
if [ -n "$APP" ] && [ -e "$HERDR_HOME/herdr-app.sock" ]; then
	RUNNING=1
fi

if [ "${1:-}" = "--uninstall" ]; then
	if [ "$RUNNING" = 1 ]; then
		"$APP" do layout.switch --name main || echo "Could not switch back to main; use ctrl-shift-l." >&2
	fi
	rm -rf "$CLONE" "$RECORDS"
	echo "Removed $CLONE"
	echo "Removed $RECORDS"
	echo "Restart Herdr if it is running."
	exit 0
fi

if [ ! -d "$SOURCE" ]; then
	echo "Herdr's agents mod was not found at $SOURCE. Start Herdr once, then retry." >&2
	exit 1
fi
if ! command -v node >/dev/null 2>&1; then
	echo "Node.js is required to patch the agents mod." >&2
	exit 1
fi

mkdir -p "$CLONE"
cp -R "$SOURCE"/. "$CLONE"/
node "$ROOT/scripts/patch-agents-mod.mjs" "$CLONE/main.js"

if [ ! -f "$RECORDS" ]; then
	cp "$LAYOUTS/main.json" "$RECORDS"
fi
node "$ROOT/scripts/patch-herdr-layout.mjs" "$RECORDS"

echo "Installed $CLONE"
echo "Installed $RECORDS"

if [ "$RUNNING" = 1 ]; then
	"$APP" do layout.switch --name main-records || echo "Could not switch to main-records automatically; use ctrl-shift-l." >&2
	echo "Switched to the main-records layout."
else
	echo "Start Herdr, then switch to the main-records layout (ctrl-shift-l)."
fi
echo "Switch back any time with: $APP do layout.switch --name main"
