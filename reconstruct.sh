#!/usr/bin/env bash
# reconstruct.sh — Mac offline 3D reconstruction from a WLtoys .h265 recording.
#
#   bash reconstruct.sh <recording.h265> [workdir]
#
# Turns a raw HEVC recording (1280x720@25, calibrated SIMPLE_RADIAL
# fx=628.3 cx=640 cy=360 k1=-0.114) into a viewable 3D model:
#
#   1. remux     -> work/video.mp4                (fast, stream copy)
#   2. extract   -> work/frames/*.jpg             (dedupe + 5fps + blur filter)
#   3. sfm       -> work/db.db + work/sparse/N    (COLMAP sequential SfM, CPU)
#   4. undistort -> work/undistorted/             (required before Brush v0.3.0)
#   5. splat     -> out/splat_*.ply               (Brush gaussian splat, 30-60 min)
#   6. extras    -> out/points.ply + out/topdown.svg  (sparse fallback + map)
#
# Every stage is idempotent: re-running skips stages whose output already
# exists (logged as SKIP). Delete <workdir>/work/.done-<stage> (or the whole
# workdir) to force a stage to re-run.
#
# Requirements: ffmpeg + colmap on PATH (brew), macOS arm64 for the Brush
# splat stage (auto-downloaded, sha256-verified). node (optional) for the
# top-down SVG map. No CUDA anywhere — this is the CPU/Metal-only pipeline.
#
# Compatible with macOS default bash 3.2.

set -u

# ---------------------------------------------------------------- arguments
if [ $# -lt 1 ]; then
  echo "usage: bash reconstruct.sh <recording.h265> [workdir]" >&2
  exit 2
fi
INPUT="$1"
if [ ! -f "$INPUT" ]; then
  echo "error: input not found: $INPUT" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE="$(basename "$INPUT")"
BASE="${BASE%.*}"
WORKDIR="${2:-./reconstruct-$BASE}"
mkdir -p "$WORKDIR"
WORKDIR="$(cd "$WORKDIR" && pwd)"
WORK="$WORKDIR/work"
OUT="$WORKDIR/out"
mkdir -p "$WORK" "$OUT"

# Calibrated intrinsics (COLMAP feasibility run, ~1px reprojection error)
CAM_PARAMS="628.3,640,360,-0.114"

BRUSH_CACHE="$HOME/.cache/wltoys-slam/brush"
BRUSH_BIN="$BRUSH_CACHE/brush_app"
BRUSH_URL="https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz"

log()  { echo "[$(date +%H:%M:%S)] $*"; }
skip() { log "$1 SKIP — $2"; }
die()  { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH — install with: brew install $2"; }
need ffmpeg ffmpeg
need colmap colmap

T_START=$(date +%s)

# ---------------------------------------------------------------- 1. remux
# Raw HEVC has no container timestamps; remux to mp4 at the known 25 fps.
if [ -f "$WORK/.done-remux" ] && [ -f "$WORK/video.mp4" ]; then
  skip "remux" "exists: $WORK/video.mp4"
else
  log "remux: $INPUT -> work/video.mp4"
  rm -f "$WORK/video.mp4"
  ffmpeg -hide_banner -loglevel error -y \
    -fflags +genpts+discardcorrupt -r 25 -f hevc -i "$INPUT" \
    -c copy "$WORK/video.mp4" || die "remux failed (is this a raw .h265 recording?)"
  touch "$WORK/.done-remux"
  log "remux: done ($(du -h "$WORK/video.mp4" | cut -f1 | tr -d ' '))"
fi

# ---------------------------------------------------------------- 2. extract
# Two passes: (a) measure per-frame blur over the mpdecimate+5fps candidate
# set, pick the ~70th-percentile threshold (sharper 70% survive); (b) extract
# with that threshold. blurdetect: lower = sharper.
FRAMES="$WORK/frames"
if [ -f "$WORK/.done-extract" ] && [ -d "$FRAMES" ]; then
  N_FRAMES=$(find "$FRAMES" -name '*.jpg' | wc -l | tr -d ' ')
  skip "extract" "exists: $FRAMES ($N_FRAMES frames)"
else
  log "extract: measuring blur over candidate frames (mpdecimate + fps=5)..."
  rm -rf "$FRAMES"; mkdir -p "$FRAMES"
  ffmpeg -hide_banner -i "$WORK/video.mp4" \
    -vf "mpdecimate,fps=5,blurdetect=block_width=64:block_height=64,metadata=mode=print:key=lavfi.blur" \
    -f null - 2>&1 | grep -o 'lavfi.blur=[0-9.]*' | cut -d= -f2 > "$WORK/blur.values" || true
  N_CAND=$(wc -l < "$WORK/blur.values" | tr -d ' ')
  [ "$N_CAND" -ge 1 ] || die "blur measurement pass produced no frames — recording unreadable?"
  BLUR_THRESH=$(sort -n "$WORK/blur.values" | awk 'BEGIN{i=0}{v[i++]=$1}END{printf "%.4f", v[int(0.70*(i-1)+0.5)]}')
  log "extract: $N_CAND candidate frames, blur threshold = $BLUR_THRESH (70th pct)"
  # (decode-recovery noise from UDP loss in the recording goes to the log)
  ffmpeg -hide_banner -loglevel error -i "$WORK/video.mp4" \
    -vf "mpdecimate,fps=5,blurdetect=block_width=64:block_height=64,metadata=mode=select:key=lavfi.blur:value=${BLUR_THRESH}:function=less" \
    -fps_mode vfr -qscale:v 2 "$FRAMES/frame_%05d.jpg" \
    2> "$WORK/ffmpeg-extract.log" || die "frame extraction failed — see $WORK/ffmpeg-extract.log"
  N_FRAMES=$(find "$FRAMES" -name '*.jpg' | wc -l | tr -d ' ')
  if [ "$N_FRAMES" -lt 30 ]; then
    die "only $N_FRAMES sharp frames survived (need >=30). The recording is too short, too blurry, or mostly stationary — record a longer, slower, smoother drive."
  fi
  touch "$WORK/.done-extract"
  log "extract: kept $N_FRAMES frames -> work/frames/"
fi
N_FRAMES=$(find "$FRAMES" -name '*.jpg' | wc -l | tr -d ' ')

# ---------------------------------------------------------------- 3. sfm
# COLMAP sequential SfM on CPU with the calibrated camera as prior.
# affine shape + domain-size pooling = low-texture indoor robustness;
# loop_detection with empty vocab_tree_path auto-downloads the faiss vocab
# tree on first run (one-time, cached by COLMAP).
SPARSE="$WORK/sparse"
BEST_FILE="$WORK/sparse-best.txt"
if [ -f "$WORK/.done-sfm" ] && [ -f "$BEST_FILE" ]; then
  skip "sfm" "exists: $SPARSE/$(cat "$BEST_FILE") (see $BEST_FILE)"
else
  log "sfm: feature extraction (CPU SIFT + affine shape + domain-size pooling)..."
  rm -rf "$SPARSE" "$WORK/db.db"; mkdir -p "$SPARSE"
  colmap feature_extractor \
    --database_path "$WORK/db.db" --image_path "$FRAMES" \
    --ImageReader.camera_model SIMPLE_RADIAL --ImageReader.single_camera 1 \
    --ImageReader.camera_params "$CAM_PARAMS" \
    --FeatureExtraction.use_gpu 0 \
    --SiftExtraction.estimate_affine_shape 1 \
    --SiftExtraction.domain_size_pooling 1 \
    > "$WORK/colmap-extract.log" 2>&1 || die "feature_extractor failed — see $WORK/colmap-extract.log"

  log "sfm: sequential matching (overlap 15, quadratic, loop detection)..."
  colmap sequential_matcher \
    --database_path "$WORK/db.db" \
    --SequentialMatching.overlap 15 --SequentialMatching.quadratic_overlap 1 \
    --SequentialMatching.loop_detection 1 \
    --FeatureMatching.use_gpu 0 \
    > "$WORK/colmap-match.log" 2>&1 || die "sequential_matcher failed — see $WORK/colmap-match.log"

  log "sfm: incremental mapping (this is the long CPU stage)..."
  colmap mapper \
    --database_path "$WORK/db.db" --image_path "$FRAMES" --output_path "$SPARSE" \
    --Mapper.min_num_matches 10 \
    --Mapper.ba_global_function_tolerance 1e-6 \
    > "$WORK/colmap-mapper.log" 2>&1 || die "mapper failed — see $WORK/colmap-mapper.log"

  # Tracking breaks fragment the reconstruction into sparse/0, sparse/1, ...
  # Pick the model with the most registered images.
  BEST=""; BEST_REG=0
  for d in "$SPARSE"/[0-9]*; do
    [ -d "$d" ] || continue
    REG=$(colmap model_analyzer --path "$d" 2>&1 | grep -ioE 'registered images[^0-9]*[0-9]+' | grep -oE '[0-9]+$' | head -1)
    [ -n "$REG" ] || REG=0
    log "sfm: model $(basename "$d"): $REG registered images"
    if [ "$REG" -gt "$BEST_REG" ]; then BEST="$(basename "$d")"; BEST_REG=$REG; fi
  done
  [ -n "$BEST" ] || die "mapper produced no models — footage may lack texture/overlap"
  echo "$BEST" > "$BEST_FILE"
  PCT=$(( BEST_REG * 100 / N_FRAMES ))
  log "sfm: best model = sparse/$BEST with $BEST_REG/$N_FRAMES frames registered (${PCT}%)"
  if [ "$PCT" -lt 60 ]; then
    log "sfm: WARNING — only ${PCT}% of frames registered (<60%). The model covers part of the drive; expect a partial map. Slower, smoother, better-lit footage helps."
  fi
  touch "$WORK/.done-sfm"
fi
BEST=$(cat "$BEST_FILE")
BEST_MODEL="$SPARSE/$BEST"

# ---------------------------------------------------------------- 4. undistort
# Brush v0.3.0 ignores k1 — feeding it the raw SIMPLE_RADIAL model smears the
# splat. image_undistorter outputs PINHOLE cameras + undistorted images in a
# COLMAP-layout workspace Brush loads directly.
UNDIST="$WORK/undistorted"
if [ -f "$WORK/.done-undistort" ] && [ -d "$UNDIST" ]; then
  skip "undistort" "exists: $UNDIST"
else
  log "undistort: sparse/$BEST -> work/undistorted/"
  rm -rf "$UNDIST"
  colmap image_undistorter \
    --image_path "$FRAMES" --input_path "$BEST_MODEL" \
    --output_path "$UNDIST" --output_type COLMAP \
    > "$WORK/colmap-undistort.log" 2>&1 || die "image_undistorter failed — see $WORK/colmap-undistort.log"
  touch "$WORK/.done-undistort"
  log "undistort: done"
fi

# ---------------------------------------------------------------- 5. splat
# Gaussian splat via Brush v0.3.0 (wgpu/Metal, headless when given a source
# path). Binary auto-fetched once into ~/.cache/wltoys-slam/brush/,
# sha256-verified against the published checksum, dequarantined.
ensure_brush() {
  if [ -x "$BRUSH_BIN" ]; then return 0; fi
  # Apple Silicon check: uname -m lies under Rosetta; hw.optional.arm64 doesn't.
  if [ "$(uname -s)" != "Darwin" ] || [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
    log "splat: no prebuilt Brush for $(uname -s)/$(uname -m) (only macOS Apple Silicon wired up) — skipping splat"
    return 1
  fi
  log "splat: fetching Brush v0.3.0 (~40MB, one-time) -> $BRUSH_CACHE"
  mkdir -p "$BRUSH_CACHE"
  local tarball="$BRUSH_CACHE/brush-app-aarch64-apple-darwin.tar.xz"
  curl -fsSL --retry 3 -o "$tarball" "$BRUSH_URL" || { log "splat: download failed"; return 1; }
  curl -fsSL --retry 3 -o "$tarball.sha256" "$BRUSH_URL.sha256" || { log "splat: checksum download failed"; return 1; }
  local expect actual
  expect=$(awk '{print $1}' "$tarball.sha256")
  actual=$(shasum -a 256 "$tarball" | awk '{print $1}')
  if [ -z "$expect" ] || [ "$expect" != "$actual" ]; then
    rm -f "$tarball"
    log "splat: sha256 MISMATCH (expected $expect, got $actual) — refusing to run the binary"
    return 1
  fi
  log "splat: sha256 verified ($actual)"
  tar -xJf "$tarball" -C "$BRUSH_CACHE" || { log "splat: extract failed"; return 1; }
  if [ ! -f "$BRUSH_BIN" ]; then
    local found
    found=$(find "$BRUSH_CACHE" -name brush_app -type f | head -1)
    [ -n "$found" ] || { log "splat: brush_app not found in archive"; return 1; }
    mv "$found" "$BRUSH_BIN"
  fi
  chmod +x "$BRUSH_BIN"
  xattr -dr com.apple.quarantine "$BRUSH_BIN" 2>/dev/null || true
  log "splat: Brush ready at $BRUSH_BIN"
}

SPLAT_OK=0
FINAL_SPLAT="$OUT/splat_10000.ply"
if [ -f "$WORK/.done-splat" ] && [ -f "$FINAL_SPLAT" ]; then
  skip "splat" "exists: $FINAL_SPLAT"
  SPLAT_OK=1
elif ensure_brush; then
  log "splat: training gaussian splat (10000 steps — expect 30-60 min on M1 Pro; intermediate PLYs export every 2500 steps)..."
  T_SPLAT=$(date +%s)
  if "$BRUSH_BIN" "$UNDIST" \
      --total-steps 10000 --max-splats 1500000 \
      --export-every 2500 --export-path "$OUT" --export-name "splat_{iter}.ply" \
      > "$WORK/brush.log" 2>&1 && [ -f "$FINAL_SPLAT" ]; then
    touch "$WORK/.done-splat"
    SPLAT_OK=1
    log "splat: done in $(( ($(date +%s) - T_SPLAT) / 60 )) min -> $FINAL_SPLAT ($(du -h "$FINAL_SPLAT" | cut -f1 | tr -d ' '))"
  else
    log "splat: Brush training FAILED — see $WORK/brush.log. Falling back to sparse point cloud."
  fi
else
  log "splat: Brush unavailable — falling back to sparse point cloud."
fi

# ---------------------------------------------------------------- 6. extras
# Always: sparse point cloud PLY (the no-GPU fallback viewable) + top-down
# SVG map of the drive.
if [ -f "$OUT/points.ply" ]; then
  skip "extras(points.ply)" "exists: $OUT/points.ply"
else
  log "extras: exporting sparse point cloud -> out/points.ply"
  colmap model_converter --input_path "$BEST_MODEL" \
    --output_path "$OUT/points.ply" --output_type PLY \
    > "$WORK/colmap-ply.log" 2>&1 || die "model_converter PLY export failed — see $WORK/colmap-ply.log"
fi

SPARSE_TXT="$WORK/sparse-txt"
if [ -f "$OUT/topdown.svg" ]; then
  skip "extras(topdown.svg)" "exists: $OUT/topdown.svg"
else
  if [ ! -f "$SPARSE_TXT/images.txt" ]; then
    mkdir -p "$SPARSE_TXT"
    colmap model_converter --input_path "$BEST_MODEL" \
      --output_path "$SPARSE_TXT" --output_type TXT \
      > "$WORK/colmap-txt.log" 2>&1 || die "model_converter TXT export failed — see $WORK/colmap-txt.log"
  fi
  NODE_BIN="$(command -v node || true)"
  [ -z "$NODE_BIN" ] && [ -x "$HOME/wltoys-runtime/node/bin/node" ] && NODE_BIN="$HOME/wltoys-runtime/node/bin/node"
  if [ -n "$NODE_BIN" ]; then
    log "extras: rendering top-down map -> out/topdown.svg"
    "$NODE_BIN" "$SCRIPT_DIR/slam/topdown.mjs" "$SPARSE_TXT" "$OUT/topdown.svg" \
      || log "extras: WARNING — topdown.svg generation failed (non-fatal)"
  else
    log "extras: node not found — skipping out/topdown.svg (install node to get the top-down map)"
  fi
fi

# ---------------------------------------------------------------- summary
ELAPSED=$(( ($(date +%s) - T_START) / 60 ))
BEST_REG=$(colmap model_analyzer --path "$BEST_MODEL" 2>&1 | grep -ioE 'registered images[^0-9]*[0-9]+' | grep -oE '[0-9]+$' | head -1)
echo ""
log "======================================================================"
log "Reconstruction complete in ${ELAPSED} min — $BEST_REG/$N_FRAMES frames registered (model sparse/$BEST)"
log "Artifacts in $OUT:"
for f in "$OUT"/*; do
  [ -f "$f" ] && log "  $(basename "$f")  ($(du -h "$f" | cut -f1 | tr -d ' '))"
done
if [ "$SPLAT_OK" = 1 ]; then
  log "View the gaussian splat (Brush doubles as a viewer):"
  log "  \"$BRUSH_BIN\" \"$FINAL_SPLAT\""
else
  log "No splat was produced — out/points.ply is the sparse SfM point cloud:"
  log "  a recognizable room outline (tens of thousands of points), NOT a solid"
  log "  model. Open it in any PLY viewer (e.g. MeshLab), and see out/topdown.svg"
  log "  for the drive path + landmark map."
fi
log "Re-running this script skips completed stages (delete $WORKDIR to start over)."
