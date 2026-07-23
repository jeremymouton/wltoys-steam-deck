#!/bin/bash
# slam/package-mac.sh — build slam-macos-arm64.tar.xz LOCALLY, offline.
#
# This is the GUARANTEED shippable path: it takes an already-built arm64
# slam_pipe (slam/build/slam_pipe from build-mac.sh, or a path given as $1),
# copies it + the config + the ORB vocab into a staging dir, then runs the
# relocation walker (relocate.sh) to pull every non-system dylib into slam/lib/
# with @rpath install names and re-sign — producing a bundle that runs from any
# unpack location on any Apple-Silicon Mac with NO brew / dev-prefix dependency.
#
# Feeding the DEV slam_pipe (which links brew's full opencv@4, incl. dnn) yields
# a correct but LARGE tarball — the walker faithfully recurses the whole opencv
# cascade (protobuf, openblas, ~40 abseil dylibs). The lean artifact comes from
# the CI job (.github/workflows/slam-bundle-mac.yml), which links a minimal
# OpenCV built from source. Both use this exact same relocate.sh engine.
#
# Usage: bash slam/package-mac.sh [path/to/slam_pipe]
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BIN="${1:-$SRC/build/slam_pipe}"
PREFIX="$HOME/.cache/wltoys-slam/stella/local"   # build-tree stella/g2o/fbow libs
OCV="/opt/homebrew/opt/opencv@4"                  # dev binary's opencv
YAML="$SRC/wltoys_slam.yaml"

# vocab: build-mac.sh's stella prefix keeps it under stella/; fall back to parent
VOCAB=""
for c in "$HOME/.cache/wltoys-slam/stella/orb_vocab.fbow" \
         "$HOME/.cache/wltoys-slam/orb_vocab.fbow"; do
    [ -f "$c" ] && { VOCAB="$c"; break; }
done

[ -f "$BIN" ]  || { echo "error: slam_pipe not found: $BIN" >&2
                    echo "       build it first: bash slam/build-mac.sh" >&2; exit 1; }
[ -f "$YAML" ] || { echo "error: config not found: $YAML" >&2; exit 1; }
[ -d "$PREFIX/lib" ] || { echo "error: stella prefix not found: $PREFIX/lib (run build-mac.sh)" >&2; exit 1; }
[ -n "$VOCAB" ] || echo "warn: orb_vocab.fbow not found under ~/.cache/wltoys-slam — bundle will omit it" >&2

STAGE="$SRC/dist/slam"
rm -rf "$SRC/dist"
mkdir -p "$STAGE/lib"
cp "$BIN" "$STAGE/slam_pipe"; chmod u+w "$STAGE/slam_pipe"
cp "$YAML" "$STAGE/wltoys_slam.yaml"
[ -n "$VOCAB" ] && cp "$VOCAB" "$STAGE/orb_vocab.fbow"

echo "relocating $BIN → $STAGE/lib ..."
# shellcheck source=slam/relocate.sh
source "$SRC/relocate.sh"
relocate_bundle "$STAGE/slam_pipe" "$STAGE/lib" "$PREFIX/lib" "$OCV/lib"

# Prove self-containment: no host path may appear in ANY bundled Mach-O's load
# commands, and every file must carry a valid ad-hoc signature.
echo "verifying self-containment ..."
leak=0
for f in "$STAGE/slam_pipe" "$STAGE"/lib/*.dylib; do
    if otool -L "$f" | tail -n +2 | grep -qE "/opt/homebrew|/\.cache/|$HOME"; then
        echo "host path leaked in $f:" >&2
        otool -L "$f" | tail -n +2 | grep -E "/opt/homebrew|/\.cache/|$HOME" >&2
        leak=1
    fi
    codesign -v "$f" 2>/dev/null || { echo "codesign verify failed: $f" >&2; leak=1; }
done
[ "$leak" -eq 0 ] || { echo "error: bundle is NOT self-contained — aborting" >&2; exit 1; }

OUT="$SRC/slam-macos-arm64.tar.xz"
XZ_OPT='-9 -T0' tar -C "$SRC/dist" -cJf "$OUT" slam

echo "wrote $OUT"
echo "  size: $(du -h "$OUT" | awk '{print $1}')"
echo "  libs: $(find "$STAGE/lib" -name '*.dylib' | wc -l | tr -d ' ')"
