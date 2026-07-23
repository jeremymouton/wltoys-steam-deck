#!/usr/bin/env bash
# One-time setup for the WLtoys 6401 Deck driver.
#
# Run this ONCE, in Desktop Mode, on WiFi WITH internet (your home network). It
# installs Node + mpv and caches them, so later — on the car's internet-less WiFi —
# ./run.sh just works offline.
#
#   bash install.sh
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
RT="${RUNTIME_DIR:-$HOME/wltoys-runtime}"
NODE_VER="v22.11.0"
NODE_DIR="$RT/node"
REPO="jeremymouton/wltoys-steam-deck"

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

# 2. Video players. On the Deck (Linux) mpv installs via flatpak (user scope, no
# sudo). On macOS the players are a brew prereq (spec R3.3) — not bundled — so we
# just check and tell the user what to install.
if [ "$PLATFORM" = "macos-arm64" ]; then
  for tool in ffmpeg mpv; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "[$tool] present"
    else
      echo "[$tool] MISSING — run: brew install $tool"
    fi
  done
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

# 3. SLAM bundle — prebuilt stella_vslam sidecar for the live minimap
# (optional). Built by CI (.github/workflows/slam-bundle.yml) and attached to
# releases like the ffmpeg asset; a release without it just means the minimap
# is off — driving is unaffected.
SLAM_ASSET="slam-$PLATFORM.tar.xz"
SLAM_URL="https://github.com/$REPO/releases/latest/download/$SLAM_ASSET"
if [ -x "$HERE/slam/slam_pipe" ]; then
  echo "[slam] present"
else
  echo "[slam] checking the release for the SLAM bundle (~50 MB)…"
  SLAM_TMP="$(mktemp -d)"
  if curl -fsSL "$SLAM_URL" -o "$SLAM_TMP/slam.tar.xz" 2>/dev/null; then
    # unpacks as slam/ over the app dir: slam_pipe + lib/ + orb_vocab.fbow + yaml
    if tar -xJf "$SLAM_TMP/slam.tar.xz" -C "$HERE"; then
      echo "[slam] installed → $HERE/slam/slam_pipe (live minimap enabled)"
    else
      echo "[slam] WARNING: extract failed — minimap disabled (driving is unaffected)"
    fi
  else
    echo "[slam] SLAM bundle not found in release — minimap disabled"
  fi
  rm -rf "$SLAM_TMP"
fi

# 4. macOS gamepad helper — a raw unsigned binary asset (not a tarball). Keyboard
# steering (WASD, spec R1.5) is the non-fatal fallback when it's absent. Downloaded
# binaries carry com.apple.quarantine; strip it or Gatekeeper silently blocks the
# launch. Same for the unpacked slam bundle (slam_pipe + its dylibs).
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
  xattr -dr com.apple.quarantine "$HERE/slam" 2>/dev/null || true
fi

chmod +x "$HERE/run.sh"

if [ "$PLATFORM" = "macos-arm64" ]; then
  cat <<EOF

==> Done. Node is set up and cached in $RT.

Next:
  • Make sure mpv + ffmpeg are installed: brew install mpv ffmpeg
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
