# wltoys-drive

Native driver for the WLtoys 6401 1/64 WiFi FPV car. Fullscreen mpv video with an
FPV-style OSD and gamepad or keyboard control, read straight from the OS — no
browser, no phone app, no Steam Input layer. Runs on the Steam Deck / Linux and on
Apple-Silicon macOS.

Tested only on the WLtoys 6401. The control protocol, camera commands, and video
feed were reverse-engineered from that model; other models or firmware revisions
may not respond and are unsupported.

## Requirements

- **Steam Deck / Linux** — NetworkManager (default on SteamOS), `flatpak` for mpv.
  `install.sh` sets up Node and mpv.
- **macOS (Apple Silicon)** — Homebrew (`install.sh` uses it to install mpv). Node,
  mpv, and the prebuilt gamepad helper are all set up by `install.sh`. Only building
  the controller helper *from source* needs the Xcode Command Line Tools
  (`xcode-select --install`); the prebuilt helper and keyboard steering don't.

Joining the car's access point removes the device's internet while connected — a
single WiFi radio can only be on one network at a time.

## Steam Deck / Linux

### Install

Run in Desktop Mode (STEAM → Power → Switch to Desktop).

1. Download the source zip from the [latest release](https://github.com/jeremymouton/wltoys-drive/releases/latest) and extract it.
2. Open a terminal in the extracted folder (right-click → Open Terminal Here).
3. On WiFi with internet, run:
   ```bash
   bash install.sh
   ```
   This installs a portable Node and mpv. Run it with `bash` — the download is not
   marked executable.
4. In Dolphin, right-click `run.sh` → Add to Steam.
5. Return to Game Mode.

### Drive

1. Turn the car on with the physical remote off and wait for the camera's green light.
2. Launch the `run.sh` shortcut. It scans for the car, joins its WiFi, and starts
   the video. If several cars are in range it prompts for one; in Game Mode it picks
   the first.
3. Exit with STEAM → Exit Game.

## macOS (Apple Silicon)

### Install

Needs [Homebrew](https://brew.sh) — `install.sh` uses it to install mpv.

1. Download the source zip from the [latest release](https://github.com/jeremymouton/wltoys-drive/releases/latest) and extract it, or clone the repo.
2. On WiFi with internet, from the app folder:
   ```bash
   bash install.sh
   ```
   This installs a portable Node in `~/wltoys-runtime`, mpv (via Homebrew), and the
   prebuilt macOS gamepad helper. Run it with `bash` — the download is not marked
   executable.

That's everything — for controller support you don't need to build anything; the
installer fetches a prebuilt helper. If that download is ever unavailable, build it
from source with `bash gamepad/build-mac.sh` (needs the Xcode Command Line Tools).

If mpv is installed but not found, ensure `/opt/homebrew/bin` is on your PATH.

### Drive

1. Turn the car on with the physical remote off and wait for the camera's green light.
2. From the app folder, run:
   ```bash
   ./run.sh
   ```
   It discovers cars you have joined before and shows a native dialog to connect: one
   saved car asks you to confirm, several let you choose. If you have never joined the
   car, it opens Wi-Fi settings so you can pick it once (its name is `WL FPV CAR …`
   and the password is the last 8 digits). To skip discovery and join a specific car
   directly, set `CAR_SSID`:
   ```bash
   CAR_SSID="WL FPV CAR 75899112" ./run.sh
   ```
3. Exit by closing the video window or pressing Ctrl-C.

## Controls

| Input | Action |
|---|---|
| Left stick | Steer |
| Right trigger / A | Forward |
| Left trigger / B | Reverse |
| W / ↑ | Forward (keyboard) |
| S / ↓ | Reverse (keyboard) |
| A / ← · D / → | Steer (keyboard) |
| Space | Stop (keyboard) |
| D-pad left/right | Steering trim (persists) |
| D-pad up · H | Toggle HUD overlay |
| Y | Toggle recording |
| Exit game / close window / Ctrl-C | Stop |

Keyboard steering requires no controller and works while the mpv window has focus.
Releasing all keys returns to neutral; a failsafe forces neutral if the input
stalls. Gamepad and keyboard can be used together.

Run `./run.sh --list` to print live axis and button numbers for mapping a controller.

## Auto-connect and reconnect

The driver joins the car's WiFi on launch and rejoins it if the link drops.

- **Steam Deck / Linux** scans for `WL FPV CAR …` networks and connects. One match
  joins directly; multiple prompt for a choice (first is auto-picked in Game Mode);
  an existing car connection is reused.
- **macOS** cannot scan from the command line, so it discovers cars from your saved
  (preferred) networks and shows a native dialog to connect — one match asks you to
  confirm, several let you choose. A never-joined car opens Wi-Fi settings once so you
  can pick it. `CAR_SSID` still joins a specific car directly. Car presence is detected
  by its gateway (`172.16.11.1`); because macOS hides the joined network name, set
  `CAR_SSID` if you want rejoin-on-drop after picking a car in Wi-Fi settings.
- On a drop, the OSD shows `RECONNECTING…`, the car is held at neutral, and the
  driver rejoins with backoff. A brief video stall does not trigger a rejoin. After
  repeated failures it stops and holds neutral.
- Set `NO_AUTOCONNECT=1` to disable auto-join and reconnect and use the current
  network.

## Recording

Press Y to toggle recording. Clips are saved to `~/Videos/wltoys-<timestamp>.h265`
(raw HEVC; remux with `ffmpeg -i clip.h265 -c copy clip.mp4`). UDP video mode only.

## Updating

On WiFi with internet, from the app folder:

```bash
bash update.sh
```

This replaces the app files with the latest release in place. The Steam shortcut,
trim setting (`~/.wltoys-trim`), and runtime (`~/wltoys-runtime`) are preserved. On
macOS it also refreshes the gamepad helper.

## Configuration

Set via Steam Launch Options (`VAR=value %command%`) or inline (`VAR=value ./run.sh`).

| Variable | Default | Description |
|---|---|---|
| `CAR_IP` | `172.16.11.1` | Car address; also the expected gateway for auto-connect |
| `CAR_SSID` | auto | Car WiFi name to join directly; optional override (Linux scans, macOS discovers saved cars otherwise) |
| `NO_AUTOCONNECT` | off | `1` disables auto-join and reconnect |
| `VIDEO_MODE` | `udp` | `udp` (low-latency) or `rtsp` (fallback) |
| `STEER_AXIS` | `0` | Steering axis |
| `THROTTLE_MODE` | `trigger` | `trigger` (RT/LT + A/B) or `stick` |
| `RT_AXIS` / `LT_AXIS` | `5` / `2` | Trigger axes (forward / reverse) |
| `ACCEL_BUTTON` / `REVERSE_BUTTON` | `0` / `1` | Forward / reverse buttons |
| `RECORD_BUTTON` | `3` | Recording toggle button |
| `THROTTLE_AXIS` | `1` | Throttle axis (stick mode) |
| `STEER_EXPO` / `THROTTLE_EXPO` | `0.4` / `0.3` | Softness near center |
| `TRIM_AXIS` / `TRIM_STEP` | `6` / `3` | D-pad trim axis and step |
| `HUD_AXIS` | `7` | D-pad hat axis whose up press toggles the HUD |
| `DEADZONE` | `0.08` | Stick deadzone |
| `RTSP_TRANSPORT` | `udp` | RTSP transport; `tcp` if the feed tears |
| `HUD_FONT` | `monospace` | OSD font (fontconfig name) |
| `WIFI_IFACE` | auto | Interface for WiFi power-save (Linux) |
| `JS_DEVICE` | first `/dev/input/js*` | Controller device (Linux) |
| `GAMEPAD_BIN` | auto | Controller helper path (macOS) |

## Troubleshooting

- **No HUD but video works** — mpv is not installed and ffplay is being used. Run
  `bash install.sh` (Deck) or `brew install mpv` (macOS).
- **macOS: no controller input** — build the helper with `bash gamepad/build-mac.sh`,
  or use the keyboard.
- **A control is wrong** — run `./run.sh --list` to read axis/button numbers and set
  the matching variables above.
- **Preview without hardware** — `./run.sh --hud-demo` renders the OSD over a test
  pattern; `node drive.mjs --selftest` checks the input and control-packet logic.
