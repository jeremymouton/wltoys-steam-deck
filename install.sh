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

echo "==> WLtoys 6401 Deck driver — setup"

# 1. Portable Node (no root; lives in ~/wltoys-runtime)
if [ -x "$NODE_DIR/bin/node" ]; then
  echo "[node] present ($("$NODE_DIR/bin/node" -v))"
else
  echo "[node] downloading $NODE_VER (~30 MB)…"
  mkdir -p "$RT"
  curl -fSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.gz" | tar -xz -C "$RT"
  mv "$RT/node-$NODE_VER-linux-x64" "$NODE_DIR"
  echo "[node] installed ($("$NODE_DIR/bin/node" -v))"
fi

# 2. mpv — required for the on-screen HUD + hardware decode (ffplay has no HUD).
# Force --user scope (no sudo, no system/user prompt) and make sure flathub exists.
if command -v mpv >/dev/null 2>&1 || flatpak info io.mpv.Mpv >/dev/null 2>&1; then
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
SLAM_URL="https://github.com/jeremymouton/wltoys-steam-deck/releases/latest/download/slam-linux-x64.tar.xz"
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

chmod +x "$HERE/run.sh"

cat <<EOF

==> Done. Node + mpv are set up and cached for offline use.

Next:
  • Right-click run.sh → Add to Steam.
  • Switch to Game Mode, join the car's WiFi, and launch the shortcut.
EOF
