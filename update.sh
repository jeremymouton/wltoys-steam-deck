#!/usr/bin/env bash
# Update this folder to the latest release in place — no re-download/re-extract
# dance. Overwrites the app files (even if already on the latest version); your
# Steam shortcut, trim setting (~/.wltoys-trim) and runtime (~/wltoys-runtime)
# are untouched. Needs internet (home WiFi — not the car's).
#
#   bash update.sh
set -e

# Everything lives in main() (invoked at the bottom) so bash parses the whole
# script before running it — safe even though tar overwrites update.sh mid-run.
main() {
  HERE="$(cd "$(dirname "$0")" && pwd)"
  REPO="jeremymouton/wltoys-steam-deck"

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
  echo "Done — now on $tag."
  exit 0
}

main "$@"
