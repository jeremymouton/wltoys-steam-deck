#!/usr/bin/env bash
# Launch the native WLtoys 6401 Deck driver. Uses the portable Node that
# install.sh set up in ~/wltoys-runtime; if it's missing, it fetches one on first
# run (needs internet once).
#
#   ./run.sh            # drive (video + control)
#   ./run.sh --list     # find which stick axis is which
#   ./run.sh --hud-demo # preview the OSD over a test pattern (no car needed)
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
# Node must run from an exec-capable filesystem, so keep this on internal storage
# (not a noexec exFAT/FAT card). Override with RUNTIME_DIR.
RT="${RUNTIME_DIR:-$HOME/wltoys-runtime}"
NODE_VER="v22.11.0"
NODE_DIR="$RT/node"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Node not set up — run 'bash install.sh' first (needs internet). Fetching now…"
  mkdir -p "$RT"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" | tar -xz -C "$RT"
  mv "$RT/node-$NODE_VER-linux-x64" "$NODE_DIR"
fi

exec "$NODE_DIR/bin/node" "$HERE/drive.mjs" "$@"
