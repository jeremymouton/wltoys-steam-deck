# wltoys-steam-deck

Native driver for the WLtoys 6401 (1/64 WiFi FPV car): fullscreen mpv video +
gamepad read straight from `/dev/input`. No browser, no internet.

## Install (Steam Deck)

All setup is done in **Desktop Mode** (hold **STEAM → Power → Switch to Desktop**).

1. **Download** the **Source code (zip)** from the
   [latest release](https://github.com/jeremymouton/wltoys-steam-deck/releases/latest).
2. **Extract it.** In the file manager (Dolphin), right-click the zip →
   *Extract → Extract Archive Here*. You get a `wltoys-steam-deck-*` folder.
3. **Open a terminal in that folder.** Enter the folder, then right-click empty
   space → **Open Terminal Here** (or press **F4**).
4. **Run setup** — on WiFi **with internet**:
   ```bash
   bash install.sh
   ```
   Type `bash install.sh` (not `./install.sh` — the download isn't marked
   executable, so a double-click or *Run in Konsole* won't work). This installs
   Node + mpv (~1–2 min). Let it finish.
5. **Add to Steam.** In Dolphin, right-click **`run.sh`** → **Add to Steam**.
   *(Optional: rename it and set Controller → a Gamepad layout in its Properties.)*
6. **Switch back to Game Mode** (STEAM → Power → **Switch to Game Mode**).

## Install (Mac)

The same repo runs on an Apple-Silicon Mac (arm64) — handy for testing the live
minimap with more compute than the Deck. The scripts auto-detect the platform
(`macos-arm64` vs `linux-x64`) off the **same release tag**, so there's nothing
extra to download.

1. **Players are a prerequisite** (not bundled on Mac — the Deck ships a static
   ffmpeg, the Mac uses Homebrew):
   ```bash
   brew install mpv ffmpeg
   ```
2. **Get the code** — download the **Source code (zip)** from the
   [latest release](https://github.com/jeremymouton/wltoys-steam-deck/releases/latest)
   and unzip it (or `git clone`).
3. **Run setup** on WiFi with internet:
   ```bash
   bash install.sh
   ```
   This fetches the portable `darwin-arm64` Node, checks that `mpv`/`ffmpeg` are
   on PATH, and — when they're published to the release — pulls the
   `slam-macos-arm64` bundle and the `gamepad-helper-macos-arm64` binary
   (quarantine stripped automatically). Any missing optional asset is non-fatal:
   the minimap or the gamepad helper just stays off.
4. **Drive:**
   ```bash
   ./run.sh            # video + control
   ./run.sh --list     # find which stick axis is which
   ./run.sh --hud-demo # preview the OSD, no car needed
   ```
   No controller? **WASD / arrow keys** steer (see [Controls](#controls)).

> **Homebrew on PATH:** Apple-Silicon brew lives in `/opt/homebrew/bin`. If
> `run.sh` warns that mpv/ffmpeg are missing even though you installed them, your
> shell doesn't have that dir on PATH — open a normal Terminal, or add it.

`bash update.sh` works the same on both platforms: it resolves the latest tag and
pulls the assets for whichever OS you're on. macOS **x86_64** (Intel) is detected
honestly but unsupported — no assets are built for it.

## Drive (Game Mode)

1. Turn the car on, physical remote **OFF**, wait for the camera's green light.
2. Join the car's WiFi (`WL FPV CAR …`, password = last 8 digits of the SSID).
   The Deck says "no internet" — that's fine.
3. In your Library, launch the **run.sh** shortcut. Video fills the screen with an
   FPV-style OSD: throttle tape (left edge), steering tape + crosshair (center),
   mode · fps (top-right), trim (bottom-right). If the video feed or gamepad drops,
   a red **NO SIGNAL** / **GAMEPAD LOST** flashes mid-screen.
   *(Preview it without the car: `./run.sh --hud-demo`.)*
4. Stop: **STEAM button → Exit Game** (snaps the car to neutral).

## Controls

| input | action |
|---|---|
| left stick | steer |
| right trigger / A | forward |
| left trigger / B | reverse |
| D-pad left/right | steering trim (persists) |
| Y | start / stop recording |
| View | show / hide the live minimap |
| RB | mapping mode (throttle capped at 60%) |
| **W / ↑** | forward (keyboard — no controller needed) |
| **S / ↓** | reverse |
| **A / ←**, **D / →** | steer left / right |
| **Space** | neutral / stop |
| exit game | stop |

The minimap buttons only do something when the SLAM bundle is installed — see
[Live minimap](#live-minimap-experimental).

**Keyboard steering** (WASD / arrows) needs no controller — handy for driving and
mapping from a Mac or the Deck's Desktop-Mode keyboard. It works while the **mpv
video window has focus** (mpv gets true key press/release, so throttle can't latch
on; releasing all keys returns to neutral within ~¼ s). Gamepad and keyboard can be
used together — throttle takes whichever is higher, steering adds. It's active on
the video/`--hud-demo` paths (mpv), not `--list`.

## Drive from a Mac (dev)

`drive.mjs` also runs on macOS (arm64) — handy for testing the live minimap with
more compute than the Deck. Video, HUD and the SLAM minimap are identical; the one
Mac-specific piece is gamepad input (macOS has no `/dev/input/jsN`).

1. **Build the controller helper** (needs the Xcode Command Line Tools —
   `xcode-select --install`):
   ```bash
   bash gamepad/build-mac.sh
   ```
   This compiles a small Swift GameController helper (`gamepad/gamepad_mac`) that
   feeds the same 8-byte events into `drive.mjs`. It uses Apple's GameController
   framework, so there's **no "Input Monitoring" prompt**.
2. **Connect a controller** — Xbox Wireless, DualSense / DualShock 4, Switch Pro or
   an MFi pad, over Bluetooth or USB (macOS Catalina+ supports these natively).
3. **Check the mapping** with `node drive.mjs --list`, then drive with
   `node drive.mjs`. The stick / trigger / D-pad / button layout matches the
   [Controls](#controls) table above.

## Recording

Press **Y** to toggle recording; the OSD shows a blinking red **● REC** with the
elapsed time. Clips save to
`~/Videos/wltoys-<timestamp>.h265` (raw HEVC — plays in mpv/VLC; `ffmpeg -i clip.h265
-c copy clip.mp4` to remux). UDP video mode only (the default).

## Live minimap (experimental)

When the SLAM sidecar is present (`slam/slam_pipe` from the release bundle, or a
local `slam/build-mac.sh` build during development) and video is the default UDP
mode, driving runs sparse visual SLAM on the camera feed and overlays a live
top-down minimap in the corner: blue dots = wall/furniture landmarks, green =
the mapped route, white = this session's driven path, orange triangle = the car.
The caption under it shows the tracking state (`MAP TRACKING 25FPS` /
`LOST` / `INIT`).

- **View** shows/hides the minimap. **RB** toggles *mapping mode*, which caps
  throttle at 60% — drive slow smooth laps to build a clean map.
- The map persists in `~/wltoys-runtime/map.msg`: it's saved on exit, reloaded
  on the next run, and the car re-localizes into it when it re-sees mapped area
  (tracking losses don't wipe it).
- SLAM runs as a separate low-priority process — if it crashes the minimap
  disappears and driving is unaffected. No scale/north: the map is relative to
  where mapping started.
- **Deck install:** the prebuilt SLAM bundle (`slam-linux-x64.tar.xz`, built by
  the `slam-bundle` GitHub Actions workflow) ships as a release asset —
  `install.sh` / `update.sh` fetch and unpack it automatically when present.
  A release without the bundle simply leaves the minimap off; everything else
  works as normal.
- **Mac install:** the arm64 equivalent is `slam-macos-arm64.tar.xz` (built by
  the `slam-bundle-mac` GitHub Actions workflow, or locally with
  `slam/package-mac.sh`) — fetched and unpacked the same way. It is fully
  self-contained: `slam_pipe` plus every non-system dylib rides along in
  `slam/lib/`, so it needs no Homebrew opencv/stella install to run.
- Preview it on any machine without the car:
  `SLAM_DEMO_CLIP=recording.h265 ./run.sh --hud-demo` plays a recorded clip and
  maps it through the identical pipeline.

### macOS SLAM bundle (`slam-macos-arm64.tar.xz`)

The Mac SLAM sidecar ships as a portable, self-contained bundle — the Apple-
Silicon analogue of the Deck's `$ORIGIN`-rpath Linux bundle. Two ways to build it:

- **CI (lean, ~15-30 MB):** `.github/workflows/slam-bundle-mac.yml` on a `macos-14`
  arm64 runner builds a **minimal OpenCV from source** (not brew opencv@4), plus
  g2o / FBoW / stella at the same pinned commits as the Linux job, then relocates
  everything with `slam/relocate.sh`. Dispatch from the Actions tab or push to the
  `ci/slam-bundle-mac` branch; attach the artifact to a release by hand:
  ```
  gh run download <run-id> -n slam-macos-arm64
  gh release upload vX.Y.Z slam-macos-arm64.tar.xz
  ```
- **Local, offline (guaranteed):** after a dev `slam/build-mac.sh`, run
  ```
  bash slam/package-mac.sh          # or: bash slam/package-mac.sh path/to/slam_pipe
  ```
  It stages `slam_pipe` + `wltoys_slam.yaml` + `orb_vocab.fbow`, relocates against
  the dev prefixes, verifies no host path leaks, and writes
  `slam/slam-macos-arm64.tar.xz`. This path packages the dev binary as-is, so it
  bundles the full brew opencv@4 cascade (larger — ~55 MB); the CI job produces
  the lean artifact.

`slam/relocate.sh` is the shared engine both use: it recursively copies every
non-system dylib into `slam/lib/`, rewrites all install names to
`@rpath/<name>`, gives `slam_pipe` a single `@loader_path/lib` rpath, and
re-signs ad-hoc (`codesign -s -`) after every edit — mandatory on Apple Silicon,
where any `install_name_tool` change invalidates the signature and the loader
then refuses to run the binary. It is sourceable (`relocate_bundle <exe> <libdir>
[search dirs…]`) or runnable standalone, and is `/bin/bash` 3.2-safe.

## Updating

No need to re-download the zip: in Desktop Mode, on WiFi **with internet**, open
a terminal in the app folder (as in Install step 3) and run:

```bash
bash update.sh
```

It replaces the app files with the latest release in place — your Steam
shortcut, trim setting, and runtime stay put.

## Troubleshooting

- **Right-click "Run in Konsole" errors** — the zip drops the executable bit; run
  `bash install.sh` from a terminal (step 4) instead.
- **flatpak asks system vs user** — `install.sh` now forces **user**; if you hit it
  running flatpak by hand, pick **user**.
- **No HUD, but video works** — mpv isn't installed (you're on ffplay). Re-run
  `bash install.sh`.
- **A control is wrong** — run `./run.sh --list` to read axis/button numbers, then
  set the env vars below via Steam **Launch Options** (e.g. `RT_AXIS=5 %command%`).

## Options

| var | default | |
|---|---|---|
| `CAR_IP` | `172.16.11.1` | car address |
| `VIDEO_MODE` | `udp` | `udp` = native low-latency feed; `rtsp` = fallback |
| `STEER_AXIS` | `0` | steering axis (left stick X) |
| `THROTTLE_MODE` | `trigger` | `trigger` (RT/LT + A/B) or `stick` (left stick Y) |
| `RT_AXIS` / `LT_AXIS` | `5` / `2` | trigger axes (forward / reverse) |
| `ACCEL_BUTTON` / `REVERSE_BUTTON` | `0` / `1` | A / B buttons (forward / reverse) |
| `RECORD_BUTTON` | `3` | button to toggle recording (Y) |
| `MINIMAP_BUTTON` | `6` | button to show/hide the minimap (View) |
| `MAPPING_BUTTON` | `5` | button to toggle mapping mode (RB) |
| `MAPPING_CAP` | `0.6` | mapping-mode throttle ceiling (0..1) |
| `SLAM_BIN` | auto | slam_pipe binary (`slam/build/slam_pipe`, then `slam/slam_pipe`) |
| `SLAM_MAP` | `~/wltoys-runtime/map.msg` | persistent SLAM map database |
| `SLAM_DEMO_CLIP` | – | recorded `.h265` for the `--hud-demo` SLAM preview |
| `THROTTLE_AXIS` | `1` | throttle axis (stick mode only) |
| `STEER_EXPO` / `THROTTLE_EXPO` | `0.4` / `0.3` | softness near center (0 = linear) |
| `TRIM_AXIS` / `TRIM_STEP` | `6` / `3` | D-pad axis + step for trim |
| `DEADZONE` | `0.08` | stick deadzone |
| `RTSP_TRANSPORT` | `udp` | RTSP fallback transport; `tcp` if it tears |
| `HUD_FONT` | `monospace` | OSD font (any fontconfig name) |
| `WIFI_IFACE` | auto | interface to disable WiFi power-save on |
| `JS_DEVICE` | first `/dev/input/js*` | controller device to read |
