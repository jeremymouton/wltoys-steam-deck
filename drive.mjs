#!/usr/bin/env node
// Native Steam Deck driver for the WLtoys 6401.
//
// Video : fullscreen mpv (hardware HEVC decode, lowest latency — no transcode).
// Control: reads the Deck's gamepad directly from /dev/input/jsN and sends the
//          confirmed 16-byte UDP control packets straight to the car. No browser,
//          so none of the Steam Input gamepad friction.
//
// Run in Desktop Mode, with the Deck joined to the car's WiFi (physical remote OFF):
//   node drive.mjs            # drive (video + control)
//   node drive.mjs --list     # print live axis/button numbers to map the sticks
//   node drive.mjs --hud-demo # preview the OSD over a test pattern (no car needed)
//   node drive.mjs --selftest # exercise packet + button-toggle logic (no hardware)
//
// Tune via env if the default stick mapping is wrong (use --list to find them):
//   STEER_AXIS=3 THROTTLE_AXIS=1 CAR_IP=172.16.11.1 node drive.mjs

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CAR_IP = process.env.CAR_IP || "172.16.11.1";
const CTRL_PORT = 23458;
// Video path. "udp" = the app's native raw-HEVC-over-UDP feed (lowest latency,
// no RTSP/jitter buffer). "rtsp" = the RTSP fallback.
const VIDEO_MODE = (process.env.VIDEO_MODE || "udp").toLowerCase();
const CAM_CMD_PORT = 23459; // send camera start/stop here
const CAM_VID_PORT = Number(process.env.CAM_VID_PORT ?? 1234); // car streams raw HEVC here
const CAM_START = Buffer.from("a88a200008000000010002000000d204", "hex");
const CAM_STOP = Buffer.from("a88a210006000000010000000000", "hex");
const RTSP_PATH = process.env.RTSP_PATH || "live/ch00_1";
const RTSP = `rtsp://${CAR_IP}/${RTSP_PATH}`;
const RTSP_TRANSPORT = process.env.RTSP_TRANSPORT || "udp";
const JS = process.env.JS_DEVICE || firstJoystick();
const STEER_AXIS = Number(process.env.STEER_AXIS ?? 0); // left stick X (works on the Deck)
const THROTTLE_MODE = (process.env.THROTTLE_MODE || "trigger").toLowerCase(); // "trigger" | "stick"
const RT_AXIS = Number(process.env.RT_AXIS ?? 5); // right trigger -> forward
const LT_AXIS = Number(process.env.LT_AXIS ?? 2); // left trigger  -> reverse
const ACCEL_BUTTON = Number(process.env.ACCEL_BUTTON ?? 0); // A button -> forward too
const REVERSE_BUTTON = Number(process.env.REVERSE_BUTTON ?? 1); // B button -> reverse too
const RECORD_BUTTON = Number(process.env.RECORD_BUTTON ?? 3); // Y button -> toggle recording
const MINIMAP_BUTTON = Number(process.env.MINIMAP_BUTTON ?? 6); // View button -> show/hide the SLAM minimap
const MAPPING_BUTTON = Number(process.env.MAPPING_BUTTON ?? 5); // RB -> mapping mode (soft throttle cap)
const MAPPING_CAP = Number(process.env.MAPPING_CAP ?? 0.6); // throttle ceiling while mapping (60%)
const THROTTLE_AXIS = Number(process.env.THROTTLE_AXIS ?? 1); // left stick Y (stick mode only)
const TRIM_AXIS = Number(process.env.TRIM_AXIS ?? 6); // D-pad X (hat) — nudges steering trim
const TRIM_STEP = Number(process.env.TRIM_STEP ?? 3); // trim change per D-pad press
const TRIM_MAX = 60;
const STEER_EXPO = Number(process.env.STEER_EXPO ?? 0.4); // 0=linear .. 1=very soft near center
const THROTTLE_EXPO = Number(process.env.THROTTLE_EXPO ?? 0.3);
const DEADZONE = Number(process.env.DEADZONE ?? 0.08);
const SEND_HZ = 50;

// ---- protocol --------------------------------------------------------------
const NEUTRAL = 0x80;
const BASE = Buffer.from("ca47d500000000006680808000008099", "hex");
const clampByte = (v) => Math.max(0, Math.min(255, Math.round(v)));
const axisToByte = (v) => clampByte(((v + 1) / 2) * 255);
const deadzone = (v) => (Math.abs(v) < DEADZONE ? 0 : v);
const expo = (x, e) => (1 - e) * x + e * x * x * x; // soften near center, keep the ends
function buildPacket(steerByte, throttleByte, trimByte = NEUTRAL) {
  const p = Buffer.from(BASE);
  p[9] = clampByte(steerByte);
  p[10] = clampByte(throttleByte);
  p[11] = clampByte(trimByte); // steering trim (0x80 = centered)
  p[14] = p[9] ^ p[10] ^ p[11];
  return p;
}
const neutral = () => buildPacket(NEUTRAL, NEUTRAL);

function firstJoystick() {
  for (let i = 0; i < 8; i++) if (existsSync(`/dev/input/js${i}`)) return `/dev/input/js${i}`;
  return "/dev/input/js0";
}

// Disable WiFi power-save — battery power-management batches/delays incoming
// packets, adding latency+jitter to the live feed. Best-effort (may need root).
function wifiPowerSaveOff() {
  let iface = process.env.WIFI_IFACE;
  if (!iface) {
    const r = spawnSync("sh", ["-c", 'for d in /sys/class/net/*/wireless; do basename "$(dirname "$d")"; done 2>/dev/null'], { encoding: "utf8" });
    iface = (r.stdout || "").trim().split("\n")[0] || "wlan0";
  }
  const r = spawnSync("sh", ["-c", `iw dev ${iface} set power_save off 2>/dev/null || sudo -n iw dev ${iface} set power_save off 2>/dev/null`]);
  console.error(r.status === 0
    ? `[wifi] power_save off on ${iface} (lower jitter)`
    : `[wifi] couldn't disable power_save on ${iface} — optional: sudo iw dev ${iface} set power_save off`);
}

// ---- gamepad: parse the joydev protocol (fixed 8-byte events) ---------------
const axes = [];
const axisRest = []; // resting value per axis (captured on open) — triggers may rest at -1 or 0
const buttons = [];
let connected = false;
const TRIM_FILE = os.homedir() + "/.wltoys-trim";
let trim = (() => { try { return Math.trunc(Number(fs.readFileSync(TRIM_FILE, "utf8"))) || 0; } catch { return 0; } })();
const saveTrim = () => { try { fs.writeFileSync(TRIM_FILE, String(trim)); } catch { /* noop */ } };
let lastTrimDir = 0; // for edge-triggering one trim step per D-pad press
// Joydev byte-stream parser, module-level so --selftest can feed it synthetic
// events. Tolerates chunks that split mid-event (kernel delivers 8-byte records
// but the read stream may slice them anywhere).
let joyBuf = Buffer.alloc(0);
function feedJoyBytes(chunk, listMode = false) {
  joyBuf = Buffer.concat([joyBuf, chunk]);
  while (joyBuf.length >= 8) {
    const value = joyBuf.readInt16LE(4);
    const type = joyBuf.readUInt8(6);
    const number = joyBuf.readUInt8(7);
    joyBuf = joyBuf.subarray(8);
    const isAxis = (type & 0x02) !== 0;
    const isInit = (type & 0x80) !== 0; // synthetic event fired on open — ignore for --list
    if (isAxis) {
      axes[number] = value / 32767;
      if (isInit) axisRest[number] = value / 32767; // remember where this axis rests
      if (number === TRIM_AXIS && !isInit) { // D-pad L/R nudges trim (one step per press)
        const dir = axes[number] < -0.5 ? -1 : axes[number] > 0.5 ? 1 : 0;
        if (dir !== 0 && dir !== lastTrimDir) {
          trim = Math.max(-TRIM_MAX, Math.min(TRIM_MAX, trim + dir * TRIM_STEP));
          console.error(`[trim] ${trim > 0 ? "+" : ""}${trim}`);
          saveTrim();
        }
        lastTrimDir = dir;
      }
    } else {
      buttons[number] = value; // 0 released, 1 pressed
      if (value === 1 && !isInit) { // rising edge only
        if (number === RECORD_BUTTON) toggleRecord(); // Y toggles recording
        if (number === MINIMAP_BUTTON) toggleMinimap(); // View shows/hides the minimap
        if (number === MAPPING_BUTTON) toggleMapping(); // RB caps throttle for mapping laps
      }
    }
    if (listMode && !isInit) {
      console.log(isAxis ? `axis ${number} = ${(value / 32767).toFixed(2)}` : `button ${number} = ${value}`);
    }
  }
}
function openGamepad(listMode = false) {
  if (!existsSync(JS)) {
    console.error(`No gamepad at ${JS}. Check: ls /dev/input/js*  (try JS_DEVICE=/dev/input/js1)`);
    if (!listMode) process.exit(1);
    return;
  }
  console.error(`[gamepad] reading ${JS}`);
  const stream = fs.createReadStream(JS);
  stream.on("open", () => { connected = true; });
  stream.on("data", (chunk) => feedJoyBytes(chunk, listMode));
  stream.on("error", (e) => { connected = false; console.error(`[gamepad] error: ${e.message} — failsafe to neutral`); });
  stream.on("close", () => { connected = false; });
}

// ---- video -----------------------------------------------------------------
function noPlayer() {
  console.error("No mpv/ffplay found. Install mpv (Discover store, or: flatpak install flathub io.mpv.Mpv).");
}

// HUD overlay. Node keeps live stats in `hud` and writes them to a small text
// file; a tiny mpv Lua script polls that file and paints it in the top-right
// corner. The file hop keeps the HUD live without an mpv IPC socket, and stays
// readable even when the app runs from a (sandboxed) SD card.
const HUD_LUA = os.homedir() + "/.wltoys-hud.lua";
const HUD_DATA = os.homedir() + "/.wltoys-hud.txt";
const hud = { fps: 0, frames: 0, lastRx: 0, steer: 0, throttle: 0, recStart: 0, mode: VIDEO_MODE.toUpperCase() };

function writeHudLua() {
  // Dev aid (HUD_SHOTS=<dir>/<prefix>): timed WINDOW screenshots — video + ASS
  // HUD + bitmap overlays — used by the Mac minimap verification runs.
  const shots = process.env.HUD_SHOTS ? `
for _, t in ipairs({10, 20, 30}) do
  mp.add_timeout(t, function()
    mp.commandv("screenshot-to-file", "${process.env.HUD_SHOTS}" .. t .. "s.png", "window")
  end)
end
` : "";
  const lua = `
local utils = require("mp.utils")
local datafile = "${HUD_DATA}"
local ov = mp.create_osd_overlay("ass-events")
ov.res_x = 1280
ov.res_y = 720
local function draw()
  local f = io.open(datafile, "r")
  local body = f and f:read("*a") or ""
  if f then f:close() end
  ov.data = body
  ov:update()
end
mp.register_event("file-loaded", draw)
mp.add_periodic_timer(0.1, draw)
-- Live minimap: Node rasterizes a ${MAP_W}x${MAP_H} premultiplied-BGRA file and
-- publishes it by atomic rename; we poll its mtime and (re)issue overlay-add —
-- reusing the id updates the bitmap in place (no flicker). x/y are REAL window
-- pixels (1280x800 on the Deck), NOT the 1280x720 ASS space above. File gone
-- (minimap hidden / SLAM off) -> overlay-remove. This script is the overlay-add
-- id space's single owner.
local mapfile = "${MAP_BGRA}"
local maplast = 0
mp.add_periodic_timer(0.25, function()
  local st = utils.file_info(mapfile)
  if st and st.mtime ~= maplast then
    maplast = st.mtime
    mp.command_native({name = "overlay-add", id = 1, x = ${MAP_X}, y = ${MAP_Y},
      file = mapfile, offset = 0, fmt = "bgra", w = ${MAP_W}, h = ${MAP_H}, stride = ${MAP_W * 4}})
  elseif not st and maplast ~= 0 then
    maplast = 0
    mp.command_native({name = "overlay-remove", id = 1})
  end
end)
${shots}`;
  try { fs.writeFileSync(HUD_LUA, lua); return true; } catch { return false; }
}

// ---- HUD drawing (ASS) ------------------------------------------------------
// Traditional FPV-OSD look: monochrome white with black outlines drawn straight
// on the video — no panels. Vertical throttle tape on the left edge, horizontal
// steering tape bottom-center (both center-origin with tick marks), crosshair,
// blinking center warnings. Red is reserved for REC and warnings.
// Overlay space is a fixed 1280x720 (set in the Lua). Colours are ASS &HBBGGRR&.
// Gauges are vector rectangles (block glyphs don't render reliably).
const OSD_FONT = process.env.HUD_FONT || "monospace";
const WHITE = "FFFFFF", RED = "4040E0"; // red = #E04040
const blink = () => Date.now() % 900 < 600;
const pct = (v) => { const p = Math.round(v * 100); return (p > 0 ? "+" : "") + p + "%"; };
const txt = (x, y, an, fs, s, color = WHITE) =>
  `{\\an${an}\\pos(${x},${y})\\fn${OSD_FONT}\\fs${fs}\\b1\\bord2.5\\shad0\\3c&H000000&\\1c&H${color}&}${s}`;
const shape = (x, y, path, alpha = "00") =>
  `{\\an7\\pos(${x},${y})\\bord1\\shad0\\3c&H000000&\\1c&H${WHITE}&\\1a&H${alpha}&\\p1}${path}`;
const rect = (x0, y0, x1, y1) => `m ${x0} ${y0} l ${x1} ${y0} l ${x1} ${y1} l ${x0} ${y1}`;

// Vertical throttle tape, left edge: translucent track, ticks at 0/±50/±100%,
// solid fill growing from the center (up = forward, down = reverse).
function throttleTape(v) {
  const X = 34, Y = 260, H = 200, C = H / 2; // screen box: x 34..58, y 260..460
  const vv = Math.max(-1, Math.min(1, v));
  const ticks = [0, 50, 100, 150, 200]
    .map((ty) => (ty === C ? rect(0, ty - 1, 24, ty + 2) : rect(4, ty - 1, 20, ty + 2)))
    .join(" ");
  const ev = [
    shape(X, Y, rect(10, 0, 14, H), "78"),
    shape(X, Y, ticks),
    txt(46, 250, 2, 22, "THR"),
    txt(46, 468, 8, 24, pct(v)),
  ];
  const y0 = Math.round(C - Math.max(0, vv) * C), y1 = Math.round(C - Math.min(0, vv) * C);
  if (y1 - y0 >= 1) ev.push(shape(X, Y, rect(8, y0, 16, y1)));
  return ev;
}

// Horizontal steering tape, bottom-center: track with a taller center tick and
// a caret riding above it showing the live steering position.
function steeringTape(v) {
  const X = 480, Y = 642, W = 320, C = W / 2; // screen box: x 480..800
  const vv = Math.max(-1, Math.min(1, v));
  const ticks = [0, 80, 160, 240, 320]
    .map((tx) => (tx === C ? rect(tx - 1, 0, tx + 2, 20) : rect(tx - 1, 4, tx + 2, 16)))
    .join(" ");
  return [
    shape(X, Y, rect(0, 8, W, 12), "78"),
    shape(X, Y, ticks),
    shape(Math.round(X + C + vv * C) - 7, Y - 14, "m 0 0 l 14 0 l 7 12"), // caret, tip down
  ];
}

// Small center crosshair: two dashes + a dot (boresight).
const crosshair = () =>
  shape(612, 357, rect(0, 1, 18, 5) + " " + rect(38, 1, 56, 5) + " " + rect(25, 0, 31, 6));

// Render current stats into the ASS the Lua overlay reads. Atomic write so the
// overlay never sees a half-written file (which would flash garbled).
function writeHudData() {
  const up = VIDEO_MODE === "udp" ? Date.now() - hud.lastRx < 1500 : true;
  const fps = VIDEO_MODE === "udp" ? ` ${up ? hud.fps : "--"}FPS` : "";
  const events = [
    txt(1248, 24, 9, 28, `${hud.mode}${fps}`), // top-right: mode + link health
    ...throttleTape(hud.throttle),
    ...steeringTape(hud.steer),
    crosshair(),
    txt(1248, 692, 3, 24, `TRIM ${trim > 0 ? "+" : ""}${trim}`), // bottom-right
  ];
  if (recording) { // top-left: camcorder-style blinking dot + elapsed time
    const s = Math.floor((Date.now() - hud.recStart) / 1000);
    const dur = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    events.push(txt(32, 24, 7, 28, `${blink() ? "●" : "○"} REC ${dur}`, RED));
  }
  if (slam.active) { // minimap caption: SLAM state + NDJSON rate, under the map's corner
    const st = { Initializing: "INIT", Tracking: "TRACKING", Lost: "LOST" }[slam.state] || slam.state.toUpperCase();
    events.push(txt(80, 340, 7, 20, `MAP ${st} ${slam.fps}FPS`));
  }
  if (mappingMode) events.push(txt(640, 26, 8, 22, `MAPPING ${Math.round(MAPPING_CAP * 100)}%`)); // top-center, subtle
  const warns = []; // blinking center warnings, stacked
  if (VIDEO_MODE === "udp" && !up) warns.push("NO SIGNAL");
  if (!connected) warns.push("GAMEPAD LOST");
  if (blink()) warns.forEach((w, i) => events.push(txt(640, 300 + i * 44, 5, 34, w, RED)));
  const body = events.join("\n");
  try {
    fs.writeFileSync(HUD_DATA + ".tmp", body);
    fs.renameSync(HUD_DATA + ".tmp", HUD_DATA);
  } catch { /* noop */ }
}

// Build a player invocation. src = {rtsp:true}, {pipe:true} (raw HEVC on stdin),
// or {demo:true} (mpv-only: test pattern for previewing the OSD; src.clip = a
// recorded .h265 to play instead — the SLAM dev path, windowed at the Deck's
// 1280x800 so overlay geometry previews faithfully).
function buildPlayer(src) {
  const has = (c) => spawnSync("sh", ["-c", `command -v ${c} >/dev/null`]).status === 0;
  const flatpakMpv = spawnSync("sh", ["-c", "flatpak info io.mpv.Mpv >/dev/null 2>&1"]).status === 0;
  const mpvCommon = ["--profile=low-latency", "--hwdec=auto", "--no-audio", "--cache=no",
    "--demuxer-readahead-secs=0", "--framedrop=vo", "--untimed",
    "--fullscreen", "--no-osc", "--osd-level=0", "--force-window=yes"];
  if (has("mpv") || flatpakMpv) {
    const pre = has("mpv") ? ["mpv"] : ["flatpak", "run", "io.mpv.Mpv"];
    const hudArgs = writeHudLua() ? [`--script=${HUD_LUA}`] : [];
    const tail = src.demo ? ["--no-untimed", "--loop=inf", "--no-fullscreen", "--geometry=1280x800",
        ...(src.clip ? ["--demuxer=lavf", "--demuxer-lavf-format=hevc", src.clip]
                     : ["av://lavfi:testsrc2=size=1280x720:rate=30"])]
      : src.pipe ? ["--demuxer=lavf", "--demuxer-lavf-format=hevc", "-"]
      : [`--rtsp-transport=${RTSP_TRANSPORT}`, RTSP];
    return { cmd: pre[0], args: [...pre.slice(1), ...mpvCommon, ...hudArgs, ...tail] };
  }
  if (src.demo) return null; // the OSD needs mpv's Lua overlay — no ffplay fallback
  if (has("ffplay")) {
    return {
      cmd: "ffplay",
      args: src.pipe
        ? ["-fflags", "nobuffer", "-flags", "low_delay", "-framedrop", "-sync", "video", "-fs", "-f", "hevc", "-"]
        : ["-fflags", "nobuffer", "-flags", "low_delay", "-avioflags", "direct", "-framedrop", "-rtsp_transport", RTSP_TRANSPORT, "-fs", RTSP],
    };
  }
  return null;
}

function startVideo() {
  return VIDEO_MODE === "udp" ? startUdpVideo() : startRtspVideo();
}

function startRtspVideo() {
  const p = buildPlayer({ rtsp: true });
  if (!p) { noPlayer(); return null; }
  console.error(`[video] rtsp ${RTSP_TRANSPORT}: ${p.cmd} ${p.args.join(" ")}`);
  return spawn(p.cmd, p.args, { stdio: "inherit" });
}

// Is there an HEVC keyframe / parameter set in this frame? (skip frames until the
// first one, so the decoder doesn't spew "PPS out of range" errors at startup)
function hasKeyframe(buf) {
  for (let i = 0; i + 5 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 &&
        (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const hdr = buf[i + 2] === 1 ? buf[i + 3] : buf[i + 4];
      const t = (hdr >> 1) & 0x3f; // VPS/SPS/PPS = 32/33/34, IDR/CRA = 19/20/21
      if (t === 19 || t === 20 || t === 21 || t === 32 || t === 33 || t === 34) return true;
    }
  }
  return false;
}

// ---- recording (UDP mode only: tee complete HEVC frames to a .h265 file) ----
let recording = false, recStream = null, recWriting = false;
const recStamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function toggleRecord() {
  if (VIDEO_MODE !== "udp") { console.error("[rec] recording needs VIDEO_MODE=udp"); return; }
  if (recording) {
    recording = false;
    try { recStream.end(); } catch {}
    recStream = null;
    console.error("[rec] stopped");
  } else {
    const dir = os.homedir() + "/Videos";
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = `${dir}/wltoys-${recStamp()}.h265`;
    try {
      recStream = fs.createWriteStream(file);
      recStream.on("error", (e) => { console.error(`[rec] ${e.message}`); recording = false; });
      recWriting = false; // start the file at a keyframe so it's playable
      recording = true;
      hud.recStart = Date.now(); // for the OSD's REC elapsed-time readout
      console.error(`[rec] recording → ${file}`);
    } catch (e) { console.error(`[rec] ${e.message}`); }
  }
}
function stopRecord() { if (recording) toggleRecord(); }

// ---- SLAM sidecar (live minimap) -------------------------------------------
// When the slam_pipe binary is present (built by slam/build-mac.sh on the Mac,
// shipped beside drive.mjs as slam/slam_pipe in the Deck bundle) and video is
// the UDP feed, complete HEVC frames are teed — at the exact point recording
// tees them — into a decode chain, both halves nice'd below the control loop:
//   nice ffmpeg -f hevc … -f rawvideo -pix_fmt gray  →  nice slam_pipe
// slam_pipe answers with NDJSON (pose per frame, landmarks/keyframes at 1 Hz);
// Node keeps a decimated path trail + the latest snapshot and rasterizes a
// top-down minimap (premultiplied BGRA) at ~3 Hz, published by atomic rename
// for the HUD Lua to overlay-add. Everything here is async callbacks off the
// control path: a sidecar crash logs, drops the minimap, and driving carries on.
const APP_DIR = fileURLToPath(new URL(".", import.meta.url)); // trailing "/"
const SLAM_BIN = process.env.SLAM_BIN ||
  [APP_DIR + "slam/build/slam_pipe", APP_DIR + "slam/slam_pipe"].find((p) => existsSync(p)) || "";
const SLAM_DIR = SLAM_BIN.slice(0, SLAM_BIN.lastIndexOf("/") + 1);
const SLAM_VOCAB = process.env.SLAM_VOCAB || // bundle ships the vocab beside the binary; Mac dev uses the cache
  [SLAM_DIR + "orb_vocab.fbow", os.homedir() + "/.cache/wltoys-slam/stella/orb_vocab.fbow"].find((p) => existsSync(p)) || "";
const SLAM_CONFIG = process.env.SLAM_CONFIG ||
  [SLAM_DIR + "wltoys_slam.yaml", APP_DIR + "slam/wltoys_slam.yaml"].find((p) => existsSync(p)) || "";
const SLAM_MAP = process.env.SLAM_MAP || os.homedir() + "/wltoys-runtime/map.msg"; // persisted across sessions
const SLAM_OK = Boolean(SLAM_BIN && SLAM_VOCAB && SLAM_CONFIG);
// The BGRA file lives on tmpfs when possible; picked ONCE here and baked into
// the generated Lua so both sides agree. macOS (dev) has no /dev/shm — the
// $HOME fallback covers it, same trust model as the other ~/.wltoys-* files.
const MAP_BGRA = (() => {
  try { fs.accessSync("/dev/shm", fs.constants.W_OK); return "/dev/shm/wltoys-map.bgra"; }
  catch { return os.homedir() + "/.wltoys-map.bgra"; }
})();

const slam = {
  ff: null, proc: null, // ffmpeg decoder + slam_pipe children
  active: false, // chain running (tee + raster enabled)
  dropping: false, // ffmpeg stdin backpressured — drop frames until drain
  eof: false, // demo clip fully fed (a following exit is expected, not a crash)
  state: "-", fps: 0, lines: 0, // tracking state + NDJSON lines/sec (like hud.fps)
  pose: null, // last 12-float world<-cam pose while tracking
  trail: [], // decimated [x,z] driven path (world y ~ down; ground plane = x/z)
  lms: [], kfs: [], // latest snapshot, as [x,z] pairs (kfs nearest-neighbor chained)
  dirty: false, // new data since the last raster
  fpsTimer: null, rasterTimer: null,
};
let mapVisible = true; // View button toggles; hidden = BGRA file deleted (Lua removes overlay)
let mappingMode = false; // RB toggles; caps throttle so mapping laps stay slow + smooth

// ffmpeg for the decode leg — mirrors the AR branch convention: env override,
// then PATH, then the static build install.sh drops in the runtime dir.
function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  if (spawnSync("sh", ["-c", "command -v ffmpeg >/dev/null"]).status === 0) return "ffmpeg";
  const rt = (process.env.RUNTIME_DIR || os.homedir() + "/wltoys-runtime") + "/ffmpeg/ffmpeg";
  return existsSync(rt) ? rt : "";
}

// NDJSON line -> map state. Lengths and finiteness are validated before any
// value can steer a Buffer offset (sidecar output is data, not trusted input).
const finiteArr = (a) => Array.isArray(a) && a.every((v) => Number.isFinite(v));
const toXZ = (flat) => { // flat [x,y,z,...] -> [[x,z],...] (top-down: drop y)
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 2]]);
  return out;
};
function slamLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; } // tolerate torn/garbled lines
  slam.lines++;
  if (typeof m.state === "string") slam.state = m.state;
  if (finiteArr(m.pose) && m.pose.length === 12) { // row-major 3x4 world<-cam
    slam.pose = m.pose;
    const x = m.pose[3], z = m.pose[11]; // camera position = translation column
    const last = slam.trail[slam.trail.length - 1];
    if (!last || (x - last[0]) ** 2 + (z - last[1]) ** 2 > 0.05 ** 2) { // decimate: >0.05 units moved
      slam.trail.push([x, z]);
      if (slam.trail.length > 500) slam.trail = slam.trail.filter((_, i) => i % 2 === 0); // thin, keep shape
    }
    slam.dirty = true;
  }
  if (finiteArr(m.lms) && m.lms.length % 3 === 0) { slam.lms = toXZ(m.lms); slam.dirty = true; }
  if (finiteArr(m.kfs) && m.kfs.length % 3 === 0) { slam.kfs = chainKfs(toXZ(m.kfs)); slam.dirty = true; }
}

// stella returns keyframes in unordered_map (hash) order, not temporal order —
// chain them greedy nearest-neighbor from an extreme point so the polyline
// follows the driven route instead of zigzagging across the map. O(n^2) on
// ≤ a few hundred keyframes at 1 Hz — negligible.
function chainKfs(pts) {
  if (pts.length < 3) return pts;
  const rest = pts.slice();
  let cx = 0, cz = 0;
  for (const [x, z] of rest) { cx += x; cz += z; }
  cx /= rest.length; cz /= rest.length;
  let si = 0, best = -1; // start at the point farthest from the centroid (a route end)
  rest.forEach(([x, z], i) => { const d = (x - cx) ** 2 + (z - cz) ** 2; if (d > best) { best = d; si = i; } });
  const out = rest.splice(si, 1);
  while (rest.length) {
    const [lx, lz] = out[out.length - 1];
    let bi = 0;
    best = Infinity;
    rest.forEach(([x, z], i) => { const d = (x - lx) ** 2 + (z - lz) ** 2; if (d < best) { best = d; bi = i; } });
    out.push(...rest.splice(bi, 1));
  }
  return out;
}

// ---- minimap rasterizer ----------------------------------------------------
// 300x300 top-down view, auto-fit to the 2nd..98th percentile of path +
// landmark coords (one stray landmark can't zoom the whole map away), uniform
// scale both axes. mpv's overlay format is premultiplied BGRA: every colour
// byte is scaled by alpha up front, packed as one LE uint32 (A R G B high->low).
const MAP_W = 300, MAP_H = 300;
const MAP_X = 80, MAP_Y = 70; // REAL window px: below the REC line (~y58), right of the throttle tape (~x82)
const pmul = (r, g, b, a) =>
  (((a << 24) | (Math.round((r * a) / 255) << 16) | (Math.round((g * a) / 255) << 8) | Math.round((b * a) / 255)) >>> 0);
const MAP_COL = {
  lm: pmul(70, 110, 255, 110), // landmarks: dim blue
  kf: pmul(64, 224, 96, 200), // keyframe path: green
  trail: pmul(255, 255, 255, 190), // this session's driven path: white
  car: pmul(255, 176, 32, 255), // car marker: orange
};
const mapPix = Buffer.alloc(MAP_W * MAP_H * 4);
const mapBg = (() => { // dark translucent background + 1px border, built once
  const b = Buffer.alloc(MAP_W * MAP_H * 4);
  const bg = pmul(8, 12, 8, 96), edge = pmul(255, 255, 255, 64);
  for (let v = 0; v < MAP_H; v++) {
    for (let u = 0; u < MAP_W; u++) {
      const c = (v === 0 || v === MAP_H - 1 || u === 0 || u === MAP_W - 1) ? edge : bg;
      b.writeUInt32LE(c, (v * MAP_W + u) * 4);
    }
  }
  return b;
})();
function mapDot(x, y, c, r = 0) {
  for (let v = y - r; v <= y + r; v++) {
    for (let u = x - r; u <= x + r; u++) {
      if (u >= 0 && u < MAP_W && v >= 0 && v < MAP_H) mapPix.writeUInt32LE(c, (v * MAP_W + u) * 4);
    }
  }
}
function mapSeg(x0, y0, x1, y1, c) { // Bresenham, clipped per pixel
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), err = dx + dy;
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  for (;;) {
    if (x0 >= 0 && x0 < MAP_W && y0 >= 0 && y0 < MAP_H) mapPix.writeUInt32LE(c, (y0 * MAP_W + x0) * 4);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function fitBounds() { // robust percentile bounds over path + landmarks + keyframes
  const xs = [], zs = [];
  for (const src of [slam.trail, slam.kfs, slam.lms]) {
    for (const [x, z] of src) { xs.push(x); zs.push(z); }
  }
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const lo = (a) => a[Math.floor(a.length * 0.02)], hi = (a) => a[Math.ceil(a.length * 0.98) - 1];
  const span = Math.max(hi(xs) - lo(xs), hi(zs) - lo(zs), 0.5) * 1.15; // pad 15%, floor the span
  return { cx: (lo(xs) + hi(xs)) / 2, cz: (lo(zs) + hi(zs)) / 2, s: (MAP_W - 20) / span };
}
function drawMinimap() {
  const fit = fitBounds();
  if (!fit) return;
  mapBg.copy(mapPix);
  const U = (x) => Math.round(MAP_W / 2 + (x - fit.cx) * fit.s);
  const V = (z) => Math.round(MAP_H / 2 - (z - fit.cz) * fit.s); // world +z (forward from start) = up
  for (const [x, z] of slam.lms) mapDot(U(x), V(z), MAP_COL.lm);
  if (slam.kfs.length > 1) { // skip outlier segments the NN chain couldn't order (> 3x median hop)
    const d = [];
    for (let i = 1; i < slam.kfs.length; i++) {
      d.push((slam.kfs[i][0] - slam.kfs[i - 1][0]) ** 2 + (slam.kfs[i][1] - slam.kfs[i - 1][1]) ** 2);
    }
    const cap = 9 * [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)]; // (3x dist)^2
    for (let i = 1; i < slam.kfs.length; i++) {
      if (d[i - 1] <= cap) mapSeg(U(slam.kfs[i - 1][0]), V(slam.kfs[i - 1][1]), U(slam.kfs[i][0]), V(slam.kfs[i][1]), MAP_COL.kf);
    }
  }
  for (let i = 1; i < slam.trail.length; i++) {
    mapSeg(U(slam.trail[i - 1][0]), V(slam.trail[i - 1][1]), U(slam.trail[i][0]), V(slam.trail[i][1]), MAP_COL.trail);
  }
  if (slam.pose) { // car: small triangle at the camera position, nose = camera forward
    const p = slam.pose, u = U(p[3]), v = V(p[11]);
    const a = Math.atan2(p[2], p[10]); // yaw from the optical axis (3rd rotation column) on x/z
    const du = Math.sin(a), dv = -Math.cos(a), pu = -dv, pv = du;
    const P = (fu, fp) => [Math.round(u + du * fu + pu * fp), Math.round(v + dv * fu + pv * fp)];
    const tip = P(8, 0), bl = P(-4, 4), br = P(-4, -4);
    mapSeg(tip[0], tip[1], bl[0], bl[1], MAP_COL.car);
    mapSeg(tip[0], tip[1], br[0], br[1], MAP_COL.car);
    mapSeg(bl[0], bl[1], br[0], br[1], MAP_COL.car);
    mapDot(u, v, MAP_COL.car, 1);
  }
  try { // atomic publish — mpv re-reads the path on every overlay-add, never sees a torn frame
    fs.writeFileSync(MAP_BGRA + ".tmp", mapPix);
    fs.renameSync(MAP_BGRA + ".tmp", MAP_BGRA);
  } catch { /* tmpfs hiccup — next raster retries */ }
}

// ---- sidecar lifecycle -----------------------------------------------------
function startSlam(paced = false) { // paced: demo clips read at native rate (-re)
  if (slam.proc || !SLAM_OK) return false;
  const ffBin = findFfmpeg();
  if (!ffBin) { console.error("[slam] no ffmpeg for the decode leg — minimap disabled"); return false; }
  try { fs.mkdirSync(SLAM_MAP.slice(0, SLAM_MAP.lastIndexOf("/")), { recursive: true }); } catch {}
  try { fs.unlinkSync(MAP_BGRA); } catch {} // stale raster from a previous run
  console.error(`[slam] ${SLAM_BIN}${existsSync(SLAM_MAP) ? ` (resuming map ${SLAM_MAP})` : ""}` +
    ` — View toggles minimap, RB toggles mapping mode`);
  // detached: own process group, so a terminal Ctrl-C (delivered to the whole
  // foreground group) can't kill the chain before the orderly EOF→save in
  // stopSlam(). If drive.mjs dies hard anyway, the closing pipes still EOF
  // through ffmpeg → slam_pipe, which saves the map and exits on its own.
  const ff = spawn("nice", ["-n", "10", ffBin, "-hide_banner", "-loglevel", "error",
    ...(paced ? ["-re"] : []),
    "-f", "hevc", "-i", "pipe:",
    "-f", "rawvideo", "-pix_fmt", "gray", "-s", "1280x720", "pipe:"],
    { stdio: ["pipe", "pipe", "ignore"], detached: true });
  const sp = spawn("nice", ["-n", "10", SLAM_BIN, SLAM_CONFIG, SLAM_VOCAB, SLAM_MAP, SLAM_MAP],
    { stdio: ["pipe", "pipe", process.env.SLAM_LOG ? "inherit" : "ignore"], detached: true });
  slam.ff = ff;
  slam.proc = sp;
  slam.active = true;
  ff.stdin.on("error", () => {}); // EPIPE when a sidecar dies mid-write
  sp.stdin.on("error", () => {});
  ff.stdout.pipe(sp.stdin); // node handles the inter-child backpressure
  const dead = (what) => (code) => {
    if (!slam.active) return; // already stopped deliberately
    slam.active = false;
    clearInterval(slam.fpsTimer);
    clearInterval(slam.rasterTimer);
    if (slam.eof) { // demo clip finished: expected, map already saved by slam_pipe
      console.error(`[slam] clip fully processed — map saved to ${SLAM_MAP}`);
      return; // leave the last raster on screen for the rest of the demo
    }
    slam.state = "-";
    console.error(`[slam] ${what} exited (code ${code}) — minimap disabled, driving unaffected`);
    try { fs.unlinkSync(MAP_BGRA); } catch {} // Lua sees it gone -> overlay-remove
  };
  ff.on("error", (e) => console.error(`[slam] ffmpeg spawn: ${e.message}`));
  sp.on("error", (e) => console.error(`[slam] slam_pipe spawn: ${e.message}`));
  ff.on("exit", dead("ffmpeg"));
  sp.on("exit", dead("slam_pipe"));
  let acc = ""; // NDJSON reassembly — chunks split lines anywhere
  sp.stdout.setEncoding("utf8");
  sp.stdout.on("data", (chunk) => {
    acc += chunk;
    let i;
    while ((i = acc.indexOf("\n")) >= 0) {
      const l = acc.slice(0, i);
      acc = acc.slice(i + 1);
      if (l) slamLine(l);
    }
  });
  slam.fpsTimer = setInterval(() => { slam.fps = slam.lines; slam.lines = 0; }, 1000);
  slam.rasterTimer = setInterval(() => { // 3 Hz, only when fresh data AND on screen
    if (slam.active && mapVisible && slam.dirty) { slam.dirty = false; drawMinimap(); }
  }, 333);
  return true;
}

// Tee one complete HEVC frame into the decode leg. Never blocks: if ffmpeg's
// stdin buffer is full (SLAM slower than the feed), frames are dropped until
// drain — the decoder resyncs at the next keyframe.
function slamFeed(f) {
  if (!slam.active || slam.dropping) return;
  try {
    if (!slam.ff.stdin.write(Buffer.from(f))) {
      slam.dropping = true;
      slam.ff.stdin.once("drain", () => { slam.dropping = false; });
    }
  } catch { /* sidecar died mid-write; its exit handler cleans up */ }
}

// Close the chain's input: EOF flows ffmpeg -> slam_pipe, which then saves the
// map and exits. `done` (when given) runs after the save or an 8s safety cap.
function stopSlam(done) {
  if (!slam.proc || slam.proc.exitCode !== null) { if (done) done(); return; }
  const wasActive = slam.active;
  slam.active = false; // silences the exit handlers + stops tee/raster
  clearInterval(slam.fpsTimer);
  clearInterval(slam.rasterTimer);
  try { fs.unlinkSync(MAP_BGRA); } catch {}
  try { slam.ff.stdin.end(); } catch {}
  if (!done) return;
  if (wasActive) console.error(`[slam] saving map to ${SLAM_MAP}…`);
  const cap = setTimeout(done, 8000);
  slam.proc.once("exit", () => { clearTimeout(cap); done(); });
}

function toggleMinimap() {
  mapVisible = !mapVisible;
  console.error(`[map] minimap ${mapVisible ? "shown" : "hidden"}`);
  if (!mapVisible) { try { fs.unlinkSync(MAP_BGRA); } catch {} } // Lua -> overlay-remove
  else slam.dirty = true; // repaint on the next raster tick
}
function toggleMapping() {
  mappingMode = !mappingMode;
  console.error(`[map] mapping mode ${mappingMode ? `ON — throttle capped at ${Math.round(MAPPING_CAP * 100)}%` : "off"}`);
}

// The app's native path: send START, receive raw-HEVC fragments on UDP, reassemble
// frames, pipe complete ones to the player. Lowest latency (no RTSP/jitter buffer).
function startUdpVideo() {
  const p = buildPlayer({ pipe: true });
  if (!p) { noPlayer(); return null; }
  console.error(`[video] udp raw-hevc :${CAM_VID_PORT}: ${p.cmd} ${p.args.join(" ")}`);
  const player = spawn(p.cmd, p.args, { stdio: ["pipe", "inherit", "inherit"] });
  player.stdin.on("error", () => {}); // ignore EPIPE when the window closes

  const cmdSock = dgram.createSocket("udp4");
  cmdSock.on("error", () => {});
  const sendCam = (b) => cmdSock.send(b, CAM_CMD_PORT, CAR_IP);
  player._camStop = () => { try { sendCam(CAM_STOP); } catch {} };

  const rx = dgram.createSocket("udp4");
  rx.on("error", (e) => console.error(`[video] udp rx error: ${e.message}`));
  const FRAME_MAX = 1 << 20;
  const frame = Buffer.alloc(FRAME_MAX);
  let lastId = -1, got = 0, total = 0, emitted = false, started = false, lastRx = Date.now();
  rx.on("message", (data) => {
    lastRx = Date.now();
    hud.lastRx = lastRx;
    if (data.length < 32) return;
    const totalSize = data.readUInt32LE(4);
    const frameId = data.readUInt32LE(8);
    const offset = data.readUInt32LE(24);
    const psz = data.readUInt32LE(28);
    if (frameId !== lastId) { lastId = frameId; got = 0; total = totalSize; emitted = false; }
    if (emitted || psz > data.length - 32 || offset + psz > FRAME_MAX) return;
    data.copy(frame, offset, 32, 32 + psz);
    got += psz;
    if (total > 0 && got >= total) {
      emitted = true;
      const f = frame.subarray(0, total);
      if (!started) { if (hasKeyframe(f)) started = true; else return; }
      try { player.stdin.write(Buffer.from(f)); } catch {}
      hud.frames++; // one complete frame delivered to the player (fps source)
      if (recording) { // tee to the recording, started at a keyframe so it plays
        if (!recWriting && hasKeyframe(f)) recWriting = true;
        if (recWriting) { try { recStream.write(Buffer.from(f)); } catch {} }
      }
      slamFeed(f); // tee the same complete frame into the SLAM sidecar (no-op when inactive)
    }
  });
  rx.bind(CAM_VID_PORT, () => { sendCam(CAM_STOP); setTimeout(() => sendCam(CAM_START), 250); });

  // watchdog: if the feed stalls (car hiccup / WiFi blip), re-request the stream
  const watchdog = setInterval(() => {
    if (Date.now() - lastRx > 3000) {
      console.error("[video] stream stalled — re-sending camera START");
      sendCam(CAM_START);
      lastRx = Date.now();
    }
  }, 1000);

  player.on("exit", () => {
    clearInterval(watchdog);
    player._camStop();
    try { rx.close(); } catch {}
    try { cmdSock.close(); } catch {}
  });
  return player;
}

// Preview the OSD over a test pattern with animated inputs — no car or gamepad
// needed. Inputs sweep continuously; REC engages at 3s; 8-11s simulates signal loss.
// Dev path (AC1.5): SLAM_DEMO_CLIP=<recording.h265> plays the clip in mpv AND
// feeds the SAME clip through the identical ffmpeg→slam_pipe chain the live tee
// uses (paced at native rate), so the minimap renders end-to-end without the car.
function hudDemo() {
  let clip = process.env.SLAM_DEMO_CLIP || "";
  if (clip && !existsSync(clip)) { // degrade like every other SLAM path: demo runs, minimap off
    console.error(`[hud-demo] SLAM_DEMO_CLIP not found: ${clip} — continuing demo without minimap`);
    clip = "";
  }
  const p = buildPlayer({ demo: true, clip });
  if (!p) { console.error("HUD demo needs mpv."); return; }
  console.error(`[hud-demo] ${p.cmd} ${p.args.join(" ")}`);
  connected = true;
  hud.fps = 30;
  trim = 6;
  const t0 = Date.now();
  writeHudData();
  const timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000, phase = t % 16;
    hud.throttle = Math.sin(t * 0.8);
    hud.steer = Math.sin(t * 1.5);
    hud.lastRx = phase >= 8 && phase < 11 ? 0 : Date.now(); // simulated signal loss
    const rec = phase >= 3 && phase < 14;
    if (rec && !recording) hud.recStart = Date.now();
    recording = rec;
    writeHudData();
  }, 100);
  if (clip) {
    if (startSlam(true)) { // paced (-re): SLAM sees the clip at realtime like the live feed
      const rs = fs.createReadStream(clip);
      rs.on("error", (e) => console.error(`[slam] clip read: ${e.message}`));
      rs.on("end", () => { slam.eof = true; }); // the chain's clean exit is expected
      rs.pipe(slam.ff.stdin); // pipe() ends stdin at EOF -> slam_pipe saves the map
    } else console.error("[hud-demo] SLAM_DEMO_CLIP set but the slam chain is unavailable");
  }
  const player = spawn(p.cmd, p.args, { stdio: "inherit" });
  const bye = () => { clearInterval(timer); stopSlam(() => process.exit(0)); };
  player.on("exit", bye);
  process.on("SIGINT", bye);
}

// ---- control loop ----------------------------------------------------------
const sock = dgram.createSocket("udp4");
sock.on("error", () => {});

// how far a trigger is pressed, 0..1 — auto-calibrated from its resting value
// (triggers rest at -1 on some pads, 0 on others).
function triggerAmount(idx) {
  const v = axes[idx];
  if (v === undefined) return 0;
  const rest = axisRest[idx] ?? -1;
  const span = 1 - rest;
  return span <= 0.01 ? 0 : Math.max(0, Math.min(1, (v - rest) / span));
}

function currentPacket() {
  if (!connected) { hud.steer = 0; hud.throttle = 0; return neutral(); } // gamepad gone -> stop
  const steerNorm = expo(deadzone(axes[STEER_AXIS] || 0), STEER_EXPO);

  let net; // throttle in -1..1 (+ forward, - reverse)
  if (THROTTLE_MODE === "trigger") {
    // forward = right trigger OR A button; reverse = left trigger OR B button.
    const forward = Math.max(triggerAmount(RT_AXIS), buttons[ACCEL_BUTTON] ? 1 : 0);
    const reverse = Math.max(triggerAmount(LT_AXIS), buttons[REVERSE_BUTTON] ? 1 : 0);
    net = forward - reverse;
  } else {
    net = -deadzone(axes[THROTTLE_AXIS] || 0); // stick up = forward
  }
  net = expo(net, THROTTLE_EXPO);
  if (mappingMode) net = Math.max(-MAPPING_CAP, Math.min(MAPPING_CAP, net)); // slow lap for clean SLAM
  if (Math.abs(net) < 0.03) net = 0;
  hud.steer = steerNorm; // feed the HUD
  hud.throttle = net;
  return buildPacket(axisToByte(steerNorm), axisToByte(net), NEUTRAL + trim);
}

// ---- selftest ---------------------------------------------------------------
// No-hardware exercise of the joydev parser + toggle edges + the mapping-mode
// throttle cap, by feeding crafted 8-byte joydev events through feedJoyBytes —
// the exact code path real button presses take.
function selftest() {
  const ev = (value, type, number) => {
    const b = Buffer.alloc(8);
    b.writeInt16LE(value, 4);
    b.writeUInt8(type, 6);
    b.writeUInt8(number, 7);
    return b;
  };
  let ok = true;
  const check = (name, cond) => { console.log(`${cond ? "ok" : "FAIL"} - ${name}`); ok &&= cond; };
  connected = true;
  const v0 = mapVisible;
  feedJoyBytes(ev(1, 0x01, MINIMAP_BUTTON));
  check("View press toggles minimap", mapVisible === !v0);
  feedJoyBytes(ev(0, 0x01, MINIMAP_BUTTON));
  check("View release does NOT toggle", mapVisible === !v0);
  feedJoyBytes(ev(1, 0x81, MINIMAP_BUTTON)); // synthetic init event fired on device open
  check("init-flagged press ignored", mapVisible === !v0);
  feedJoyBytes(ev(1, 0x01, MINIMAP_BUTTON).subarray(0, 5)); // split mid-event…
  feedJoyBytes(ev(1, 0x01, MINIMAP_BUTTON).subarray(5)); // …parser must reassemble
  check("split event toggles back", mapVisible === v0);
  buttons[ACCEL_BUTTON] = 1; // full forward
  check("full throttle byte = 255", currentPacket()[10] === 255);
  feedJoyBytes(ev(1, 0x01, MAPPING_BUTTON));
  check("RB enables mapping mode", mappingMode === true);
  check(`mapping caps throttle byte at ${axisToByte(MAPPING_CAP)}`, currentPacket()[10] === axisToByte(MAPPING_CAP));
  feedJoyBytes(ev(0, 0x01, MAPPING_BUTTON));
  feedJoyBytes(ev(1, 0x01, MAPPING_BUTTON));
  check("RB again restores full throttle", mappingMode === false && currentPacket()[10] === 255);
  const pkt = currentPacket();
  check("checksum byte14 = b9^b10^b11", pkt[14] === (pkt[9] ^ pkt[10] ^ pkt[11]));
  process.exit(ok ? 0 : 1);
}

// Dev probe (LAG_PROBE=1): samples event-loop drift on the same 20ms grid as
// the 50 Hz control timer — if SLAM I/O ever stalled the loop, packet cadence
// would drift exactly as these numbers do.
if (process.env.LAG_PROBE) {
  const lags = [];
  let lastTick = Date.now();
  setInterval(() => { const now = Date.now(); lags.push(now - lastTick - 20); lastTick = now; }, 20);
  setInterval(() => {
    if (!lags.length) return;
    const s = [...lags].sort((a, b) => a - b);
    const q = (f) => s[Math.min(s.length - 1, Math.floor(s.length * f))];
    console.error(`[lag] n=${s.length} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${s[s.length - 1]}ms`);
    lags.length = 0;
  }, 5000);
}

// ---- main ------------------------------------------------------------------
if (process.argv.includes("--list")) {
  console.error("Move the sticks. Note which AXIS number changes when you steer (left/right)");
  console.error("and when you throttle (up/down). Ctrl-C to quit, then set STEER_AXIS / THROTTLE_AXIS.\n");
  openGamepad(true);
} else if (process.argv.includes("--selftest")) {
  selftest();
} else if (process.argv.includes("--hud-demo")) {
  hudDemo();
} else {
  wifiPowerSaveOff();
  openGamepad(false);
  const video = startVideo();
  if (VIDEO_MODE === "udp") { // SLAM auto-enables only when the binary bundle is present
    if (SLAM_OK) startSlam();
    else console.error("[slam] slam_pipe bundle not found — minimap off");
  }
  const timer = setInterval(() => sock.send(currentPacket(), CTRL_PORT, CAR_IP), 1000 / SEND_HZ);
  // HUD: recompute fps once a second, repaint the overlay data file 4x a second.
  writeHudData();
  const fpsTimer = setInterval(() => { hud.fps = hud.frames; hud.frames = 0; }, 1000);
  const hudTimer = setInterval(writeHudData, 100); // responsive throttle/steer bars
  let done = false;
  const shutdown = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearInterval(fpsTimer);
    clearInterval(hudTimer);
    stopRecord(); // flush + close any recording
    for (let i = 0; i < 6; i++) sock.send(neutral(), CTRL_PORT, CAR_IP); // failsafe
    if (video && video._camStop) video._camStop(); // stop the UDP camera stream
    if (video) try { video.kill(); } catch {}
    stopSlam(() => setTimeout(() => process.exit(0), 150)); // EOF -> slam_pipe saves the map first
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (video) video.on("exit", shutdown); // closing the video window stops the car
  console.error(`[drive] car=${CAR_IP}  video=${VIDEO_MODE}  throttle=${THROTTLE_MODE}  steerAxis=${STEER_AXIS}` +
    (THROTTLE_MODE === "trigger" ? `  RT=${RT_AXIS} LT=${LT_AXIS} accelBtn=${ACCEL_BUTTON} revBtn=${REVERSE_BUTTON}` : ` throttleAxis=${THROTTLE_AXIS}`));
  console.error(`[drive] expo steer=${STEER_EXPO} throttle=${THROTTLE_EXPO}  trim=${trim}`);
  console.error(THROTTLE_MODE === "trigger"
    ? "Left stick = steer. RT/A = forward, LT/B = reverse, D-pad = trim. Close video or Ctrl-C to stop."
    : "Left stick = throttle + steer. D-pad = trim. Close video or Ctrl-C to stop.");
}
