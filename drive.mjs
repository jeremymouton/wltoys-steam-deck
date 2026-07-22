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
//
// Tune via env if the default stick mapping is wrong (use --list to find them):
//   STEER_AXIS=3 THROTTLE_AXIS=1 CAR_IP=172.16.11.1 node drive.mjs

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

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
function openGamepad(listMode = false) {
  if (!existsSync(JS)) {
    console.error(`No gamepad at ${JS}. Check: ls /dev/input/js*  (try JS_DEVICE=/dev/input/js1)`);
    if (!listMode) process.exit(1);
    return;
  }
  console.error(`[gamepad] reading ${JS}`);
  const stream = fs.createReadStream(JS);
  let buf = Buffer.alloc(0);
  stream.on("open", () => { connected = true; });
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const value = buf.readInt16LE(4);
      const type = buf.readUInt8(6);
      const number = buf.readUInt8(7);
      buf = buf.subarray(8);
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
        if (number === RECORD_BUTTON && value === 1 && !isInit) toggleRecord(); // Y toggles recording
      }
      if (listMode && !isInit) {
        console.log(isAxis ? `axis ${number} = ${(value / 32767).toFixed(2)}` : `button ${number} = ${value}`);
      }
    }
  });
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
  const lua = `
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
`;
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
// or {demo:true} (mpv-only: test pattern for previewing the OSD).
function buildPlayer(src) {
  const has = (c) => spawnSync("sh", ["-c", `command -v ${c} >/dev/null`]).status === 0;
  const flatpakMpv = spawnSync("sh", ["-c", "flatpak info io.mpv.Mpv >/dev/null 2>&1"]).status === 0;
  const mpvCommon = ["--profile=low-latency", "--hwdec=auto", "--no-audio", "--cache=no",
    "--demuxer-readahead-secs=0", "--framedrop=vo", "--untimed",
    "--fullscreen", "--no-osc", "--osd-level=0", "--force-window=yes"];
  if (has("mpv") || flatpakMpv) {
    const pre = has("mpv") ? ["mpv"] : ["flatpak", "run", "io.mpv.Mpv"];
    const hudArgs = writeHudLua() ? [`--script=${HUD_LUA}`] : [];
    const tail = src.demo ? ["--no-untimed", "--loop=inf", "av://lavfi:testsrc2=size=1280x720:rate=30"]
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
function hudDemo() {
  const p = buildPlayer({ demo: true });
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
  const player = spawn(p.cmd, p.args, { stdio: "inherit" });
  player.on("exit", () => { clearInterval(timer); process.exit(0); });
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
  if (Math.abs(net) < 0.03) net = 0;
  hud.steer = steerNorm; // feed the HUD
  hud.throttle = net;
  return buildPacket(axisToByte(steerNorm), axisToByte(net), NEUTRAL + trim);
}

// ---- main ------------------------------------------------------------------
if (process.argv.includes("--list")) {
  console.error("Move the sticks. Note which AXIS number changes when you steer (left/right)");
  console.error("and when you throttle (up/down). Ctrl-C to quit, then set STEER_AXIS / THROTTLE_AXIS.\n");
  openGamepad(true);
} else if (process.argv.includes("--hud-demo")) {
  hudDemo();
} else {
  wifiPowerSaveOff();
  openGamepad(false);
  const video = startVideo();
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
    setTimeout(() => process.exit(0), 150);
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
