#!/bin/sh
# Install the herdr-status Command Code mod for the Herdr desktop app.
# The mod reports Command Code state through OSC 7501; see mods/herdr-status.ts.
#
# Usage: sh scripts/install-mod.sh [--uninstall]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="${COMMANDCODE_HOME:-$HOME/.commandcode}/mods"
TARGET="$DEST/herdr-status.ts"

if [ "${1:-}" = "--uninstall" ]; then
	rm -f "$TARGET"
	echo "Removed $TARGET"
	exit 0
fi

mkdir -p "$DEST"
cp "$ROOT/mods/herdr-status.ts" "$TARGET"
echo "Installed $TARGET"
echo "Restart Command Code (or run /reload), then verify with: cmd mods list"
