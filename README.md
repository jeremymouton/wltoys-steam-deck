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
| exit game | stop |

## Recording

Press **Y** to toggle recording; the OSD shows a blinking red **● REC** with the
elapsed time. Clips save to
`~/Videos/wltoys-<timestamp>.h265` (raw HEVC — plays in mpv/VLC; `ffmpeg -i clip.h265
-c copy clip.mp4` to remux). UDP video mode only (the default).

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
| `THROTTLE_AXIS` | `1` | throttle axis (stick mode only) |
| `STEER_EXPO` / `THROTTLE_EXPO` | `0.4` / `0.3` | softness near center (0 = linear) |
| `TRIM_AXIS` / `TRIM_STEP` | `6` / `3` | D-pad axis + step for trim |
| `DEADZONE` | `0.08` | stick deadzone |
| `RTSP_TRANSPORT` | `udp` | RTSP fallback transport; `tcp` if it tears |
| `HUD_FONT` | `monospace` | OSD font (any fontconfig name) |
| `WIFI_IFACE` | auto | interface to disable WiFi power-save on |
| `JS_DEVICE` | first `/dev/input/js*` | controller device to read |
