#!/usr/bin/env bash
# Update this folder to the latest release in place — no re-download/re-extract
# dance. Overwrites the app files (even if already on the latest version); your
# Steam shortcut, trim setting (~/.wltoys-trim) and runtime (~/wltoys-runtime)
# are untouched. Needs internet (home WiFi — not the car's).
#
#   bash update.sh
set -e

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

# Everything lives in main() (invoked at the bottom) so bash parses the whole
# script before running it — safe even though tar overwrites update.sh mid-run.
main() {
  HERE="$(cd "$(dirname "$0")" && pwd)"
  REPO="jeremymouton/wltoys-steam-deck"
  PLATFORM="$(detect_platform)"

  echo "Checking the latest release…"
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" \
    || { echo "Can't reach GitHub — join WiFi with internet (not the car's), then retry."; exit 1; }
  tag="${url##*/tag/}"
  case "$tag" in
    v*) ;;
    *) echo "No release found at https://github.com/$REPO/releases — nothing to update."; exit 1 ;;
  esac

  echo "Downloading ${tag}…"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://github.com/$REPO/archive/refs/tags/$tag.tar.gz" -o "$tmp/src.tgz"

  echo "Installing into ${HERE}…"
  tar -xzf "$tmp/src.tgz" --strip-components=1 -C "$HERE"

  # SLAM bundle (live minimap) — optional release asset, same flow as the
  # ffmpeg one: missing just means the feature is off, not an error. Asset name
  # is per-platform off the SAME tag (slam-linux-x64 / slam-macos-arm64).
  if curl -fsSL "https://github.com/$REPO/releases/download/$tag/slam-$PLATFORM.tar.xz" \
      -o "$tmp/slam.tar.xz" 2>/dev/null; then
    # unpacks as slam/ over the app dir: slam_pipe + lib/ + orb_vocab.fbow + yaml
    if tar -xJf "$tmp/slam.tar.xz" -C "$HERE"; then
      echo "SLAM bundle installed → slam/slam_pipe (live minimap enabled)."
    else
      echo "WARNING: SLAM bundle extract failed — minimap disabled (driving is unaffected)."
    fi
  else
    echo "SLAM bundle not found in release — minimap disabled."
  fi

  # macOS gamepad helper (raw unsigned binary) + quarantine strip. Keyboard
  # steering (WASD) is the non-fatal fallback when it's absent.
  if [ "$PLATFORM" = "macos-arm64" ]; then
    if curl -fsSL "https://github.com/$REPO/releases/download/$tag/gamepad-helper-macos-arm64" \
        -o "$HERE/gamepad-helper" 2>/dev/null; then
      chmod +x "$HERE/gamepad-helper"
      xattr -d com.apple.quarantine "$HERE/gamepad-helper" 2>/dev/null || true
      echo "Gamepad helper installed."
    else
      rm -f "$HERE/gamepad-helper"
      echo "Gamepad helper not in release — use keyboard steering (WASD)."
    fi
    xattr -dr com.apple.quarantine "$HERE/slam" 2>/dev/null || true
  fi

  echo "Done — now on $tag."
  exit 0
}

main "$@"
