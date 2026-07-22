#!/usr/bin/env bash
# One-time setup for the WLtoys 6401 driver (Steam Deck / Linux + macOS).
#
# Run this ONCE, on WiFi WITH internet (your home network). It installs Node +
# a video player and caches them, so later — on the car's internet-less WiFi —
# ./run.sh just works offline.
#
#   bash install.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
RT="${RUNTIME_DIR:-$HOME/wltoys-runtime}"
NODE_VER="v22.11.0"
NODE_DIR="$RT/node"
REPO="jeremymouton/wltoys-drive"

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
# nodejs.org names its macOS builds "darwin", not "macos" — remap the token.
case "$PLATFORM" in
  macos-arm64) NODE_SLUG="darwin-arm64" ;;
  linux-x64)   NODE_SLUG="linux-x64" ;;
  *) echo "install.sh: unsupported platform: $PLATFORM (need macos-arm64 or linux-x64)"; exit 1 ;;
esac

echo "==> WLtoys 6401 driver — setup ($PLATFORM)"

# 1. Portable Node (no root; lives in ~/wltoys-runtime)
if [ -x "$NODE_DIR/bin/node" ]; then
  echo "[node] present ($("$NODE_DIR/bin/node" -v))"
else
  echo "[node] downloading $NODE_VER (~30 MB)…"
  mkdir -p "$RT"
  curl -fSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-$NODE_SLUG.tar.gz" | tar -xz -C "$RT"
  mv "$RT/node-$NODE_VER-$NODE_SLUG" "$NODE_DIR"
  echo "[node] installed ($("$NODE_DIR/bin/node" -v))"
fi

# 2. Video player. On the Deck (Linux) mpv installs via flatpak (user scope, no
# sudo). On macOS the players are a brew prereq — not bundled — so we just check
# and tell the user what to install.
if [ "$PLATFORM" = "macos-arm64" ]; then
  # mpv is the real requirement (video + HUD + WASD keyboard). Auto-install via
  # brew when it's available — mirroring the Deck's flatpak auto-install below.
  if command -v mpv >/dev/null 2>&1; then
    echo "[mpv]  present"
  elif command -v brew >/dev/null 2>&1; then
    echo "[mpv]  installing via brew…"; brew install mpv && echo "[mpv]  installed"
  else
    echo "[mpv]  MISSING and no Homebrew — get brew (https://brew.sh), then: brew install mpv"
  fi
  # ffmpeg only supplies the ffplay fallback used when mpv can't run — optional.
  command -v ffplay >/dev/null 2>&1 \
    || echo "[ffmpeg] absent — optional; the bare-video fallback only if mpv is unavailable (brew install ffmpeg)"
# Force --user scope (no sudo, no system/user prompt) and make sure flathub exists.
elif command -v mpv >/dev/null 2>&1 || flatpak info io.mpv.Mpv >/dev/null 2>&1; then
  echo "[mpv]  present"
elif command -v flatpak >/dev/null 2>&1; then
  echo "[mpv]  installing via flatpak (user)…"
  flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
  flatpak install -y --user flathub io.mpv.Mpv && echo "[mpv]  installed"
else
  echo "[mpv]  WARNING: no mpv and no flatpak — install mpv yourself (no HUD without it)"
fi

# 3. macOS gamepad helper — a raw unsigned binary asset (not a tarball). Keyboard
# steering (WASD) is the non-fatal fallback when it's absent. Downloaded binaries
# carry com.apple.quarantine; strip it or Gatekeeper silently blocks the launch.
if [ "$PLATFORM" = "macos-arm64" ]; then
  if curl -fsSL "https://github.com/$REPO/releases/latest/download/gamepad-helper-macos-arm64" \
       -o "$HERE/gamepad-helper" 2>/dev/null; then
    chmod +x "$HERE/gamepad-helper"
    xattr -d com.apple.quarantine "$HERE/gamepad-helper" 2>/dev/null || true
    echo "[pad]  gamepad helper installed"
  else
    rm -f "$HERE/gamepad-helper"
    echo "[pad]  gamepad helper not in release — use keyboard steering (WASD)"
  fi
fi

chmod +x "$HERE/run.sh"

if [ "$PLATFORM" = "macos-arm64" ]; then
  cat <<EOF

==> Done. Node is set up and cached in $RT.

Next:
  • mpv powers video + HUD + keyboard (auto-installed above if you have Homebrew).
    ffmpeg is an optional fallback, only if mpv can't run: brew install ffmpeg
  • Join the car's WiFi, then run: ./run.sh
    (no controller? WASD / arrow keys steer — see the README Controls table.)
EOF
else
  cat <<EOF

==> Done. Node + mpv are set up and cached for offline use.

Next:
  • Right-click run.sh → Add to Steam.
  • Switch to Game Mode, join the car's WiFi, and launch the shortcut.
EOF
fi
