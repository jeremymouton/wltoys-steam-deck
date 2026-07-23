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

# Platform token: linux-x64 | macos-arm64 (also used verbatim in release asset
# names). Rosetta trap: `uname -m` prints x86_64 on an arm64 Mac under a
# translated shell; `sysctl -n hw.optional.arm64` does not — trust it on Darwin.
detect_platform() {
  local arch
  case "$(uname -s)" in
    Darwin)
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
        echo "macos-arm64"
      else
        echo "macos-x64"        # honest, but no assets built for it (unsupported)
      fi
      ;;
    Linux)
      case "$(uname -m)" in
        aarch64|arm64) arch="arm64" ;;
        *)             arch="x64" ;;
      esac
      echo "linux-$arch"
      ;;
    *) echo "unknown-unknown" ;;
  esac
}

PLATFORM="$(detect_platform)"
# nodejs.org names its macOS builds "darwin", not "macos" — remap the token so
# the download URL is correct (the token itself stays right for asset names).
case "$PLATFORM" in
  macos-arm64) NODE_SLUG="darwin-arm64" ;;
  linux-x64)   NODE_SLUG="linux-x64" ;;
  *) echo "run.sh: unsupported platform: $PLATFORM (need macos-arm64 or linux-x64)"; exit 1 ;;
esac

if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "Node not set up — run 'bash install.sh' first (needs internet). Fetching now…"
  mkdir -p "$RT"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_SLUG.tar.gz" | tar -xz -C "$RT"
  mv "$RT/node-$NODE_VER-$NODE_SLUG" "$NODE_DIR"
fi

# Mac players are a brew prereq (not bundled). Warn — non-fatal — if they're not
# on PATH; Apple-Silicon Homebrew lives in /opt/homebrew/bin, which a Finder- or
# Steam-launched shell may lack even when mpv/ffmpeg are installed.
if [ "$PLATFORM" = "macos-arm64" ]; then
  command -v mpv    >/dev/null 2>&1 || echo "run.sh: mpv not on PATH — video HUD needs it: brew install mpv"
  command -v ffmpeg >/dev/null 2>&1 || echo "run.sh: ffmpeg not on PATH — SLAM minimap needs it: brew install ffmpeg"
fi

exec "$NODE_DIR/bin/node" "$HERE/drive.mjs" "$@"
