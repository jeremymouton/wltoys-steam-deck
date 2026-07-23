#!/bin/bash
# Dev build of slam_pipe on the Mac, against the existing local stella prefix
# (~/.cache/wltoys-slam/stella/local — libstella_vslam, g2o, FBoW, Eigen 3.4).
# The Deck (Linux x86_64) bundle is built by CI, not by this script.
#
# Mac caveats handled here (all bitten before):
# - dev shells may run under Rosetta -> force arm64 via `arch -arm64` and
#   -DCMAKE_OSX_ARCHITECTURES=arm64
# - OpenCV must be opencv@4 (plain opencv is v5, which renamed the modules
#   stella links against)
# - AppleClang has no native -fopenmp -> explicit libomp hints
# - the dev prefix was relocated after install; its generated cmake configs
#   hardcode the old build-time path -> rewrite them in place (idempotent)

set -euo pipefail

PREFIX="$HOME/.cache/wltoys-slam/stella/local"
OPENCV="/opt/homebrew/opt/opencv@4"
LIBOMP="/opt/homebrew/opt/libomp"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SRC_DIR/build"

for p in "$PREFIX" "$OPENCV" "$LIBOMP"; do
    if [ ! -d "$p" ]; then
        echo "error: missing dependency dir: $p" >&2
        exit 1
    fi
done

# Repair relocated-prefix paths inside the installed cmake configs.
for f in "$PREFIX/lib/cmake/stella_vslam/stella_vslamConfig.cmake" \
         "$PREFIX/share/cmake/fbow/fbowConfig.cmake"; do
    if [ -f "$f" ]; then
        sed -i '' \
            -e "s|\"[^\"]*/stella/local/include\"|\"$PREFIX/include\"|g" \
            -e "s|\"[^\"]*/stella/local/lib\"|\"$PREFIX/lib\"|g" \
            "$f"
    fi
done

arch -arm64 cmake -S "$SRC_DIR" -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_PREFIX_PATH="$PREFIX;$OPENCV;/opt/homebrew" \
    -DOpenMP_C_FLAGS="-Xpreprocessor -fopenmp -I$LIBOMP/include" \
    -DOpenMP_C_LIB_NAMES=omp \
    -DOpenMP_CXX_FLAGS="-Xpreprocessor -fopenmp -I$LIBOMP/include" \
    -DOpenMP_CXX_LIB_NAMES=omp \
    -DOpenMP_omp_LIBRARY="$LIBOMP/lib/libomp.dylib"

arch -arm64 cmake --build "$BUILD_DIR" -j "$(sysctl -n hw.ncpu)"

echo "built: $BUILD_DIR/slam_pipe"
