#!/usr/bin/env node
// Native cross-platform driver for the WLtoys 6401 (Steam Deck / Linux + macOS).
//
// Video : fullscreen mpv (hardware HEVC decode, lowest latency — no transcode).
// Control: Linux/Deck reads the gamepad directly from /dev/input/jsN; macOS spawns
//          a tiny GameController helper (gamepad/) that emits the same joydev bytes.
//          Either way the confirmed 16-byte UDP control packets go straight to the
//          car — no browser, so none of the Steam Input gamepad friction. Keyboard
//          steering (WASD / arrows) works too, with or without a controller.
//
// Run with the machine joined to the car's WiFi (physical remote OFF):
//   node drive.mjs            # drive (video + control)
//   node drive.mjs --list     # print live axis/button numbers to map the sticks
//   node drive.mjs --hud-demo # preview the OSD over a test pattern (no car needed)
//   node drive.mjs --selftest # exercise packet + input logic (no hardware)
//
// Tune via env if the default stick mapping is wrong (use --list to find them):
//   STEER_AXIS=3 THROTTLE_AXIS=1 CAR_IP=172.16.11.1 node drive.mjs

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// WiFi auto-connect (W1) + reconnect (W4): pure core + platform backends live in
// ./wifi/ (zero npm deps). drive.mjs stays the sole car-facing script; wifi/ is
// spawn-only glue over nmcli (Linux/Deck) / networksetup+gateway (macOS).
import * as wifi from "./wifi/connect.mjs";
import { matchCarSsid } from "./wifi/core.mjs";

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
const HUD_AXIS = Number(process.env.HUD_AXIS ?? 7); // D-pad Y (hat): up toggles the HUD overlay
const STEER_EXPO = Number(process.env.STEER_EXPO ?? 0.4); // 0=linear .. 1=very soft near center
const THROTTLE_EXPO = Number(process.env.THROTTLE_EXPO ?? 0.3);
const DEADZONE = Number(process.env.DEADZONE ?? 0.08);
const SEND_HZ = 50;

// ---- WiFi auto-connect (W1) + reconnect-on-drop (W4) -----------------------
// CAR_SSID drives macOS discovery (CLI scanning is dead there — see research) and
// is an explicit override on any platform. NO_AUTOCONNECT skips BOTH the pre-flight
// join and the drop monitor (use whatever network is already joined; CAR_IP still
// honored). Treat any set value except 0/false/no/off as "on".
const CAR_SSID = process.env.CAR_SSID || "";
const NO_AUTOCONNECT = !!(process.env.NO_AUTOCONNECT && !/^(0|false|no|off)$/i.test(process.env.NO_AUTOCONNECT));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MON_INTERVAL_MS = Number(process.env.WIFI_MON_MS ?? 1500); // drop-poll cadence (async, off the 50Hz loop)
const LINK_TIMEOUT_MS = 1500; // video-RX staleness that counts as a link-down sample (udp mode)
const DOWN_DEBOUNCE = 3;      // consecutive down samples before declaring a REAL drop (W4.4 debounce)
const REJOIN_MAX = 6;         // bounded rejoin attempts before giving up (W4.5)
let lastSsid = CAR_SSID || null; // the car SSID to rejoin on drop (chosen in the picker / known)
let reconnecting = false;    // W4: link down + actively rejoining -> HUD "RECONNECTING…" + neutral hold
let caveatShown = false;     // surface the single-radio "no internet" note only once

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

// App directory (trailing "/") so paths resolve from any cwd, and the macOS
// gamepad helper: GAMEPAD_BIN env override → dev build (gamepad/gamepad_mac) →
// packaged bundle (gamepad-helper beside drive.mjs). Empty on Linux / when unbuilt.
const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const GAMEPAD_BIN = process.env.GAMEPAD_BIN ||
  [APP_DIR + "gamepad/gamepad_mac", APP_DIR + "gamepad-helper"].find((p) => existsSync(p)) || "";

// ---- gamepad: parse the joydev protocol (fixed 8-byte events) ---------------
const axes = [];
const axisRest = []; // resting value per axis (captured on open) — triggers may rest at -1 or 0
const buttons = [];
let connected = false;
const TRIM_FILE = os.homedir() + "/.wltoys-trim";
let trim = (() => { try { return Math.trunc(Number(fs.readFileSync(TRIM_FILE, "utf8"))) || 0; } catch { return 0; } })();
const saveTrim = () => { try { fs.writeFileSync(TRIM_FILE, String(trim)); } catch { /* noop */ } };
let lastTrimDir = 0; // for edge-triggering one trim step per D-pad press
let hudUpHeld = false; // edge-trigger one HUD toggle per D-pad-up press (never while held)
// Joydev byte-stream parser, module-level so --selftest can feed it synthetic
// events and so BOTH the Linux joydev reader and the macOS helper share one path.
// Tolerates chunks that split mid-event (the kernel delivers 8-byte records but a
// read stream may slice them anywhere).
const EMPTY_BUF = Buffer.alloc(0);
let joyBuf = EMPTY_BUF;
function feedJoyBytes(chunk, listMode = false) {
  // Parse in place with an offset; only concat when a previous chunk left a
  // partial (<8B) event. The common 8-byte-aligned case then skips the concat.
  const data = joyBuf.length ? Buffer.concat([joyBuf, chunk]) : chunk;
  let off = 0;
  while (data.length - off >= 8) {
    const value = data.readInt16LE(off + 4);
    const type = data.readUInt8(off + 6);
    const number = data.readUInt8(off + 7);
    off += 8;
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
      if (number === HUD_AXIS && !isInit) { // D-pad up toggles the HUD (one toggle per press)
        const up = axes[number] < -0.5;
        if (up && !hudUpHeld) toggleHud();
        hudUpHeld = up;
      }
    } else {
      buttons[number] = value; // 0 released, 1 pressed
      if (number === RECORD_BUTTON && value === 1 && !isInit) toggleRecord(); // Y toggles recording (rising edge)
    }
    if (listMode && !isInit) {
      console.log(isAxis ? `axis ${number} = ${(value / 32767).toFixed(2)}` : `button ${number} = ${value}`);
    }
  }
  // Carry any trailing partial event (0-7B). Copy it out so we never retain the
  // whole chunk buffer; reuse the shared empty when the chunk was fully consumed.
  joyBuf = off < data.length ? Buffer.from(data.subarray(off)) : EMPTY_BUF;
}

// macOS has no joydev device. A tiny Swift GameController helper (gamepad/) emits
// the SAME 8-byte joydev event format on stdout, so feedJoyBytes stays byte-for-
// byte unchanged across OSes.
function openGamepadMac(listMode = false) {
  if (!GAMEPAD_BIN) {
    console.error("[gamepad] no macOS controller helper found — build it with: bash gamepad/build-mac.sh");
    console.error("[gamepad] continuing without a controller (keyboard steering + video still work).");
    return; // never crash: keyboard driving + video run regardless of a pad
  }
  console.error(`[gamepad] spawning ${GAMEPAD_BIN}`);
  let helper;
  try {
    helper = spawn(GAMEPAD_BIN, [], { stdio: ["ignore", "pipe", "inherit"] });
  } catch (e) {
    console.error(`[gamepad] helper failed to start: ${e.message} — no controller input`);
    return;
  }
  // The helper stays silent until a controller connects; its first bytes are the
  // init burst. Mirror joydev's "open" semantics — mark connected once events
  // flow, so with no pad `connected` stays false and currentPacket() sends neutral.
  helper.stdout.on("data", (chunk) => { connected = true; feedJoyBytes(chunk, listMode); });
  helper.on("error", (e) => { connected = false; console.error(`[gamepad] helper error: ${e.message} — failsafe to neutral`); });
  helper.on("exit", () => { connected = false; });
  process.once("exit", () => { try { helper.kill(); } catch { /* noop */ } });
}

function openGamepad(listMode = false) {
  if (process.platform === "darwin") return openGamepadMac(listMode);
  // ---- Linux / Steam Deck: read the joydev device directly (UNCHANGED) ----
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
let hudVisible = true; // 'h' (keyboard) or D-pad up toggles the OSD overlay on/off
// Flip HUD visibility and apply it at once — writeHudData paints an empty overlay when off.
function toggleHud() {
  hudVisible = !hudVisible;
  console.error(`[hud] ${hudVisible ? "on" : "off"}`);
  writeHudData();
}

// ---- keyboard steering (WASD + arrows) via mpv Lua FIFO heartbeat -----------
// mpv holds window focus and its Lua gets REAL key down/up (a raw terminal only
// gets down + OS auto-repeat, never up — the exact latch this project already
// hit). So keyboard driving is routed through the HUD Lua: complex key bindings
// keep a held-key SET, and a 20 Hz timer writes the FULL current set each tick to
// this FIFO as a line ("KEYS w d\n", or "KEYS -" when empty). Node recomputes
// kbState FRESH per line — an idempotent heartbeat, so a dropped line can't
// desync — and merges it READ-ONLY into currentPacket(). The keyboard NEVER
// writes the shared axes[]/buttons[] arrays: the exact regression guard for the
// logged throttle-latch bug.
const KEY_FIFO = os.homedir() + "/.wltoys-keys"; // beside HUD_DATA / HUD_LUA
const KB_FAILSAFE_MS = 250; // no heartbeat within this window -> force neutral
const kbState = { steer: 0, fwd: false, rev: false };
let kbLastKeys = 0; // ms of the last KEYS heartbeat (0 = none yet -> inactive)
let kbStream = null;

// Parse one held-key heartbeat line into kbState, recomputed fresh each call.
// Module-level so --selftest can drive it directly with synthetic FIFO lines.
function handleKeyLine(ln) {
  if (ln === "HUD") { toggleHud(); return; } // 'h' key: one-shot HUD on/off (down-edge from the Lua)
  if (!ln.startsWith("KEYS ")) return;
  kbLastKeys = Date.now();
  const h = new Set(ln.slice(5).trim().split(/\s+/));
  if (h.has("SPACE")) { kbState.steer = 0; kbState.fwd = false; kbState.rev = false; return; } // stop overrides all
  kbState.fwd = h.has("w") || h.has("UP");
  kbState.rev = h.has("s") || h.has("DOWN");
  kbState.steer = (h.has("d") || h.has("RIGHT") ? 1 : 0) - (h.has("a") || h.has("LEFT") ? 1 : 0);
}

// kbState with the failsafe applied — neutral if no heartbeat within the window
// (mpv/pipe dead). Read-only: never mutates kbState, so a resumed heartbeat is
// picked up on the very next tick. Never latches throttle on. The stale branch
// returns a shared frozen neutral (read-only) so the 50 Hz packet loop makes no
// per-tick allocation when the keyboard is idle (the gamepad/no-input default).
const KB_NEUTRAL = Object.freeze({ steer: 0, fwd: false, rev: false });
function kbLive() {
  if (Date.now() - kbLastKeys > KB_FAILSAFE_MS) return KB_NEUTRAL;
  return kbState;
}

// Create the Lua->Node FIFO and start reading heartbeats. Called from the mpv
// branch of buildPlayer BEFORE mpv spawns, so Node's read end (flags:"r+" =
// O_RDWR: never blocks, never EOFs even across an mpv restart) is open before the
// Lua opens the write end. Idempotent; clears any stale FIFO first.
function startKeyboard() {
  if (kbStream) return;
  try { fs.unlinkSync(KEY_FIFO); } catch { /* no stale FIFO */ }
  if (spawnSync("mkfifo", [KEY_FIFO]).status !== 0) {
    console.error("[keys] mkfifo failed — keyboard steering unavailable (gamepad + video still work)");
    return;
  }
  try {
    kbStream = fs.createReadStream(KEY_FIFO, { flags: "r+" });
  } catch (e) {
    console.error(`[keys] FIFO open failed: ${e.message} — keyboard steering unavailable`);
    kbStream = null;
    return;
  }
  let buf = "";
  kbStream.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { handleKeyLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > 4096) buf = ""; // a newline-less flood can't grow the buffer forever
  });
  kbStream.on("error", (e) => console.error(`[keys] FIFO read error: ${e.message}`));
  console.error("[keys] keyboard steering ready — W/↑ fwd, S/↓ rev, A/← D/→ steer, SPACE = stop, H = toggle HUD");
}

// Stop reading and remove the FIFO (called from shutdown alongside the failsafe).
function stopKeyboard() {
  if (kbStream) { try { kbStream.close(); } catch { /* noop */ } kbStream = null; }
  try { fs.unlinkSync(KEY_FIFO); } catch { /* already gone */ }
}

function writeHudLua() {
  // Keyboard steering: complex (real down/up) FORCED bindings — forced so SPACE
  // overrides mpv's default pause. A held-key SET updates on down/repeat/up; a
  // 20 Hz timer writes the FULL set each tick to the FIFO Node already opened for
  // reading (so this io.open("w") never blocks). Idempotent heartbeat.
  const keys = `
local keyfifo = io.open("${KEY_FIFO}", "w")
if keyfifo then
  keyfifo:setvbuf("no")
  local held = {}
  local function kbind(k)
    mp.add_forced_key_binding(k, "wlk_" .. k, function(e)
      if e.event == "up" then held[k] = nil
      elseif e.event ~= "press" then held[k] = true end
    end, {complex = true})
  end
  for _, k in ipairs({"w", "a", "s", "d", "UP", "DOWN", "LEFT", "RIGHT", "SPACE"}) do kbind(k) end
  mp.add_forced_key_binding("h", "wlk_hud", function(e) -- 'h' one-shot: toggle the HUD
    if e.event == "down" then keyfifo:write("HUD\\n"); keyfifo:flush() end
  end, {complex = true})
  mp.add_periodic_timer(0.05, function()
    local ks = {}
    for k, _ in pairs(held) do ks[#ks + 1] = k end
    keyfifo:write("KEYS " .. (ks[1] and table.concat(ks, " ") or "-") .. "\\n")
    keyfifo:flush()
  end)
end
`;
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
${keys}`;
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
  if (!hudVisible) { // toggled off: write an empty overlay (Lua clears to nothing), skip the rest
    try { fs.writeFileSync(HUD_DATA + ".tmp", ""); fs.renameSync(HUD_DATA + ".tmp", HUD_DATA); } catch { /* noop */ }
    return;
  }
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
  if (reconnecting) warns.push("RECONNECTING…"); // W4: car link dropped, rejoining
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
    if (hudArgs.length) startKeyboard(); // FIFO + reader up BEFORE mpv's Lua opens the write end
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
  player._camStart = () => { try { sendCam(CAM_START); } catch {} }; // W4: re-arm the stream after a rejoin

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
  player.on("exit", () => { clearInterval(timer); stopKeyboard(); process.exit(0); });
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
  // W4 safety: while the car link is down and we're actively rejoining, HOLD
  // neutral regardless of stick/keys — the mid-drive-disconnect failsafe. This is
  // the exact "neutral held throughout the drop" regression guard (AC4.1). Set/
  // cleared only by the reconnect monitor, never from the 50Hz send path itself.
  if (reconnecting) { hud.steer = 0; hud.throttle = 0; return neutral(); }
  // Keyboard channel (mpv Lua FIFO): read-only, recomputed live, failsafe-neutral
  // when no recent heartbeat. Merged with the gamepad HERE — never written into
  // the shared axes[]/buttons[] (the throttle-latch regression guard).
  const kb = kbLive();
  const kbActive = kb.fwd || kb.rev || kb.steer !== 0; // any live keyboard input this tick
  // Gamepad gone AND no live keyboard -> stop. Keyboard is its OWN liveness source,
  // so keyboard-only driving (no controller at all) still produces real packets.
  if (!connected && !kbActive) { hud.steer = 0; hud.throttle = 0; return neutral(); }
  // steer = gamepad axis + keyboard, additively clamped, then the shared deadzone/expo.
  const steerNorm = expo(deadzone(Math.max(-1, Math.min(1, (axes[STEER_AXIS] || 0) + kb.steer))), STEER_EXPO);

  let net; // throttle in -1..1 (+ forward, - reverse)
  if (THROTTLE_MODE === "trigger") {
    // forward = right trigger OR A button OR keyboard (W/↑); reverse = LT OR B OR keyboard (S/↓)
    const forward = Math.max(triggerAmount(RT_AXIS), buttons[ACCEL_BUTTON] ? 1 : 0, kb.fwd ? 1 : 0);
    const reverse = Math.max(triggerAmount(LT_AXIS), buttons[REVERSE_BUTTON] ? 1 : 0, kb.rev ? 1 : 0);
    net = forward - reverse;
  } else {
    net = -deadzone(axes[THROTTLE_AXIS] || 0) + (kb.fwd ? 1 : 0) - (kb.rev ? 1 : 0); // stick up = forward, + keyboard
    net = Math.max(-1, Math.min(1, net));
  }
  net = expo(net, THROTTLE_EXPO);
  if (Math.abs(net) < 0.03) net = 0;
  hud.steer = steerNorm; // feed the HUD
  hud.throttle = net;
  return buildPacket(axisToByte(steerNorm), axisToByte(net), NEUTRAL + trim);
}

// ---- WiFi auto-connect (W1) + reconnect (W4) --------------------------------
// A stdin/tty picker + prompts, a non-blocking pre-flight join, and an async
// reconnect monitor. All the branch/state logic is dependency-injectable so
// --selftest exercises every path with a synthetic backend — no radio, no car.

// TTY = both stdin AND stderr are terminals. In Game Mode / launched from Steam
// (or piped) this is false, so the picker auto-picks the first car instead of
// hanging on a prompt with no interactive polkit agent behind it.
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

// Ask one question on the tty (prompt on stderr so stdout/--list stay clean),
// resolve the typed line. Only called when isInteractive() is true.
function promptLine(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(q, (ans) => { rl.close(); resolve(ans); });
  });
}

// macOS native car chooser (no CAR_SSID typing). Given the discovered SAVED cars,
// draw a native dialog with osascript: ONE car -> a "Connect to <ssid>?" confirm;
// SEVERAL -> a "choose from list". SSIDs are passed as osascript run-arguments
// (`on run argv` + a trailing `-- <args>`), so a name with spaces is DATA, never
// interpolated into a shell string (spawn is shell:false too). Returns one of:
//   { status: "pick", ssid }  user chose a car
//   { status: "cancel" }      user dismissed the dialog (osascript -128)
//   { status: "nogui" }       no window server (ssh/headless) — caller degrades
// Never involves the WPA2 password (that stays inside wifi/connect.mjs), so nothing
// sensitive can leak here.
function macPickCar(cars) {
  return new Promise((resolve) => {
    const args =
      cars.length === 1
        ? ["-e", "on run argv",
           "-e", 'display dialog "Connect to " & (item 1 of argv) & "?" buttons {"Cancel", "Connect"} default button "Connect"',
           "-e", "end run", "--", cars[0]]
        : ["-e", "on run argv",
           "-e", 'set chosen to choose from list argv with prompt "Which car?"',
           "-e", "if chosen is false then error number -128",
           "-e", "return item 1 of chosen",
           "-e", "end run", "--", ...cars];
    let out = "", err = "";
    let child;
    try {
      child = spawn("osascript", args, { shell: false });
    } catch {
      resolve({ status: "nogui" });
      return;
    }
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", () => resolve({ status: "nogui" }));
    child.on("close", (code) => {
      if (code === 0) {
        // confirm dialog returns the button; the list returns the chosen SSID line.
        resolve({ status: "pick", ssid: cars.length === 1 ? cars[0] : String(out).trim() });
      } else if (/-128|user cancel/i.test(String(err))) {
        resolve({ status: "cancel" });
      } else {
        resolve({ status: "nogui" }); // e.g. -1713 "No user interaction allowed" over ssh
      }
    });
  });
}

// Single-radio caveat: joining the car AP drops this device's internet. Say it
// once (pre-flight or first successful rejoin), never on every reconnect.
function noInternetCaveat() {
  if (caveatShown) return;
  caveatShown = true;
  console.error("[wifi] joined the car — this device now has no internet, expected");
}

// Pre-flight: bring the car network up BEFORE the driver starts. NON-FATAL end to
// end — a failed/absent auto-connect still lets the app run (already-joined net or
// CAR_IP override keeps working), matching the existing behavior. Returns a small
// result object ({action, ssid, ok?, reason?}) so --selftest can assert branches.
// deps overrides (wifi/prompt/interactive/carSsid/noAutoconnect/log) are for tests.
async function connectCar(deps = {}) {
  const w = deps.wifi || wifi;
  const carSsid = deps.carSsid != null ? deps.carSsid : CAR_SSID;
  const noAuto = deps.noAutoconnect != null ? deps.noAutoconnect : NO_AUTOCONNECT;
  const interactive = deps.interactive != null ? deps.interactive : isInteractive;
  const prompt = deps.prompt || promptLine;
  const pickCar = deps.pickCar || macPickCar; // macOS native Connect/pick dialog (injectable for --selftest)
  const nap = deps.sleep || sleep;            // poll delay (injectable so --selftest doesn't really wait)
  const log = deps.log || ((m) => console.error(m));
  const isTty = () => (typeof interactive === "function" ? interactive() : interactive);

  // Shared join + result messaging (one code path for Linux, the macOS CAR_SSID
  // override, and the macOS discovered-car dialog). notInRangeMsg overrides the
  // generic "couldn't join" line so the macOS dialog path can point the user back
  // to Wi-Fi settings. Sets lastSsid so W4 can rejoin-on-drop.
  const finishJoin = async (theSsid, notInRangeMsg) => {
    lastSsid = theSsid; // remember for W4 even if this join fails (car may be booting)
    log(`[wifi] joining ${theSsid}…`);
    let res;
    try { res = await w.joinCar(theSsid); } catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
    if (res && res.ok) {
      noInternetCaveat();
      return { action: "join", ssid: theSsid, ok: true };
    }
    if (res && res.reason === "badpw") {
      log(`[wifi] wrong password for "${theSsid}" — check the SSID digits (not retrying)`);
    } else if (res && res.reason === "notcar") {
      log(`[wifi] "${theSsid}" isn't a car SSID (expected WL FPV CAR <8+ digits>) — continuing`);
      lastSsid = null; // don't let W4 retry a non-car SSID
    } else {
      log(notInRangeMsg || `[wifi] couldn't join "${theSsid}" (${(res && res.reason) || "failed"}) — continuing; will keep trying while driving`);
    }
    return { action: "join", ssid: theSsid, ok: false, reason: res && res.reason };
  };

  if (noAuto) {
    log("[wifi] NO_AUTOCONNECT set — using whatever network is already joined");
    return { action: "skip", ssid: null };
  }

  // Already on the car? Linux reads the SSID; macOS answers by gateway (SSID is
  // redacted). Skip scan/join entirely and just remember an SSID for W4 if we can.
  let already = false;
  try { already = await w.onCarAP(); } catch { already = false; }
  if (already) {
    log("[wifi] already on the car");
    if (!lastSsid) {
      let cc = null;
      try { cc = await w.currentCar(); } catch { cc = null; }
      lastSsid = (typeof cc === "string" && matchCarSsid(cc)) ? cc.trim() : (carSsid || null);
    }
    return { action: "already", ssid: lastSsid };
  }

  // Choose an SSID to join.
  let ssid = null;
  if (w.SCAN_SUPPORTED) {
    // Linux/Deck: scan -> 0 (message, continue) / 1 (auto) / >=2 (picker).
    let cars = [];
    try { cars = await w.scanCars(); } catch { cars = []; }
    if (cars.length === 0) {
      log("[wifi] no car found — power it on / move in range (or set CAR_SSID)");
      if (carSsid) ssid = carSsid;                       // honor an explicit override
      else return { action: "nojoin", ssid: null };      // non-fatal: run on current net / CAR_IP
    } else if (cars.length === 1) {
      ssid = cars[0];
      log(`[wifi] found ${ssid}`);
    } else if (isTty()) {
      log("[wifi] multiple cars found:");
      cars.forEach((s, i) => log(`  [${i}] ${s}`));
      const ans = String(await prompt(`[wifi] which car? [0-${cars.length - 1}] (default 0): `)).trim();
      const idx = ans === "" ? 0 : Number(ans);
      if (Number.isInteger(idx) && idx >= 0 && idx < cars.length) ssid = cars[idx];
      else { ssid = cars[0]; log(`[wifi] invalid choice — using ${cars[0]}`); }
    } else {
      ssid = cars[0]; // Game Mode / non-interactive: auto-pick the first
      log(`[wifi] ${cars.length} cars found; non-interactive — auto-picking ${ssid}`);
    }
  } else {
    // macOS: no CAR_SSID typing. CAR_SSID env is still an explicit override; else
    // discover the SAVED (preferred) cars and show a native Connect/pick dialog.
    if (carSsid) {
      ssid = carSsid; // override path — join directly via the shared handler below
    } else {
      let saved = [];
      try { saved = await w.savedCars(); } catch { saved = []; }

      if (saved.length === 0) {
        // Never paired: open Wi-Fi settings once so the user can pick the car, then
        // poll the gateway for a short while to see if they landed on it. macOS
        // redacts the joined SSID, so we can't learn its name this way — rejoin-on-
        // drop (W4) needs a known SSID, so it stays OFF unless CAR_SSID is set.
        log("[wifi] no saved car — pick your car in Wi-Fi settings");
        try { await w.openWifiPicker(); } catch { /* non-fatal (headless/ssh) */ }
        for (let i = 0; i < 15; i++) {
          await nap(1000);
          let on = false;
          try { on = await w.onCarAP(); } catch { on = false; }
          if (on) {
            log("[wifi] joined — driving");
            lastSsid = carSsid && matchCarSsid(carSsid) ? carSsid.trim() : null;
            if (!lastSsid) log("[wifi] note: rejoin-on-drop is off — SSID is unknown after the system picker (set CAR_SSID to enable it)");
            noInternetCaveat();
            return { action: "join", ssid: lastSsid, ok: true };
          }
        }
        return { action: "nojoin", ssid: null }; // non-fatal: run on the current net
      }

      // 1 or 2+ saved cars -> native dialog (confirm / choose-from-list).
      const pick = await pickCar(saved);
      if (pick.status === "cancel") {
        log("[wifi] cancelled — continuing on the current network");
        return { action: "nojoin", ssid: null };
      }
      let chosen;
      if (pick.status === "nogui") {
        // No window server (ssh/headless): degrade to non-interactive — 1 auto-join,
        // 2+ auto-pick the first (mirrors the Linux Game-Mode fallback).
        chosen = saved[0];
        log(saved.length === 1
          ? `[wifi] no GUI available — auto-joining ${chosen}`
          : `[wifi] no GUI available — ${saved.length} saved cars; auto-picking ${chosen}`);
      } else {
        chosen = pick.ssid;
      }
      return finishJoin(chosen, `[wifi] ${chosen} not in range — power it on, or pick another in Wi-Fi settings`);
    }
  }

  if (!ssid) return { action: "nojoin", ssid: null };
  return finishJoin(ssid);
}

// W4 reconnect monitor — a self-contained, injectable state machine so the whole
// drop -> debounce -> reconnecting -> rejoin(backoff) -> resume / give-up flow is
// unit-testable with synthetic samples (no radio, no real timers). Production wires
// `sample` to onCarAP()+RX-staleness, `join` to wifi.joinCar(lastSsid), `sleep` to
// the real timer; --selftest injects synthetic ones. NEVER called from the 50Hz
// loop — driven by its own async setInterval, so the control cadence is untouched.
function makeReconnectMonitor({
  sample, join, sleep: nap, onNeutralHold, log = () => {},
  debounce = DOWN_DEBOUNCE, maxAttempts = REJOIN_MAX, backoffBase = 1000, backoffCap = 8000,
}) {
  let downCount = 0;
  let reconnectingState = false;
  let stopped = false;
  let ticking = false; // in-flight guard: a slow sample() spawn must not let two ticks overlap
  const setHold = (v) => { reconnectingState = v; if (onNeutralHold) onNeutralHold(v); };

  async function reconnect() {
    setHold(true); // engage the neutral failsafe + HUD "RECONNECTING…" for the whole rejoin
    log("[wifi] car link down — reconnecting…");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try { res = await join(); } catch (e) { res = { ok: false, reason: String((e && e.message) || e) }; }
      if (res && res.ok) {
        setHold(false); downCount = 0;
        log("[wifi] reconnected — resuming");
        return true;
      }
      if (res && res.reason === "badpw") {
        log("[wifi] wrong password — not retrying (fix the SSID / CAR_SSID)");
        stopped = true; setHold(false); // a bad pw won't fix itself by looping; let the driver resume
        return false;
      }
      if (attempt < maxAttempts) {
        await nap(Math.min(backoffCap, backoffBase * 2 ** (attempt - 1))); // 1,2,4,8,8… s (capped)
      }
    }
    log("[wifi] car appears off / out of range — giving up auto-reconnect");
    stopped = true; // leave the neutral failsafe engaged (nothing to drive)
    return false;
  }

  async function tick() {
    // `ticking` is set synchronously before the first await, so a second interval
    // firing while sample()/reconnect() is still pending returns here — no overlap
    // even if a sample() spawn runs longer than the tick interval.
    if (stopped || reconnectingState || ticking) return; // one rejoin loop at a time
    ticking = true;
    try {
      let isDown = false;
      try { isDown = await sample(); } catch { isDown = false; }
      if (isDown) {
        if (++downCount >= debounce) await reconnect();
      } else {
        downCount = 0;
      }
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    get stopped() { return stopped; },
    get reconnecting() { return reconnectingState; },
    get downCount() { return downCount; },
    _timer: null,
  };
}

// Wire + start the live W4 monitor after video/control are up. Off if NO_AUTOCONNECT
// or if we have no SSID to rejoin (can't blind-rejoin). Timer is unref'd so it never
// keeps the process alive on its own.
function startWifiMonitor(video) {
  if (NO_AUTOCONNECT) return null;
  if (!lastSsid) {
    console.error("[wifi] auto-reconnect off (no known car SSID — set CAR_SSID to enable rejoin-on-drop)");
    return null;
  }
  const mon = makeReconnectMonitor({
    sample: async () => {
      let onAp;
      try { onAp = await wifi.onCarAP(); } catch { onAp = false; }
      const rxStale = VIDEO_MODE === "udp" && hud.lastRx > 0 && (Date.now() - hud.lastRx > LINK_TIMEOUT_MS);
      return !onAp || rxStale;
    },
    join: async () => {
      const r = await wifi.joinCar(lastSsid);
      if (r && r.ok) { noInternetCaveat(); try { video && video._camStart && video._camStart(); } catch { /* noop */ } }
      return r;
    },
    sleep,
    onNeutralHold: (v) => { reconnecting = v; },
    log: (m) => console.error(m),
  });
  const t = setInterval(() => { mon.tick(); }, MON_INTERVAL_MS);
  if (t.unref) t.unref();
  mon._timer = t;
  return mon;
}

// ---- selftest ---------------------------------------------------------------
// No-hardware exercise of the input + packet paths. Crafted 8-byte joydev events
// go through feedJoyBytes (the exact code path real gamepad events take) and
// synthetic "KEYS ..." lines go through handleKeyLine (the exact path the mpv Lua
// 20 Hz heartbeat takes). Then the resulting control-packet bytes are asserted.
async function selftest() {
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

  // ---- trigger rest calibration -------------------------------------------
  // The macOS helper's init burst records rest=0 for a trigger (which rests at 0
  // on macOS, not -1). feedJoyBytes must then read a resting trigger as NEUTRAL
  // throttle — never half throttle. Exercised through the real parse+packet path.
  feedJoyBytes(ev(0, 0x82, RT_AXIS)); // init burst: seed trigger rest = 0
  feedJoyBytes(ev(0, 0x02, RT_AXIS)); // trigger released
  check("trigger at rest = neutral throttle", currentPacket()[10] === NEUTRAL);
  feedJoyBytes(ev(32767, 0x02, RT_AXIS)); // trigger fully pressed → forward
  check("trigger full press = forward byte 255", currentPacket()[10] === 255);
  feedJoyBytes(ev(0, 0x02, RT_AXIS)); // release again

  // ---- gamepad parse ------------------------------------------------------
  feedJoyBytes(ev(16384, 0x02, STEER_AXIS)); // steer axis ~ +0.5
  check("gamepad axis parse (steer axis ~+0.5)", Math.abs((axes[STEER_AXIS] ?? 0) - 0.5) < 0.01);
  feedJoyBytes(ev(0, 0x02, STEER_AXIS)); // recenter
  feedJoyBytes(ev(-32767, 0x82, LT_AXIS)); // init burst: seed a -1-resting trigger
  check("init event seeds axisRest", Math.abs((axisRest[LT_AXIS] ?? 0) - (-1)) < 0.01);
  feedJoyBytes(ev(1, 0x01, 9).subarray(0, 5)); // split an 8-byte record mid-event…
  feedJoyBytes(ev(1, 0x01, 9).subarray(5)); // …parser must reassemble (button 9 = unmapped)
  check("split event reassembled (button 9 pressed)", buttons[9] === 1);
  feedJoyBytes(ev(0, 0x01, 9)); // release
  buttons[ACCEL_BUTTON] = 1; // A button = full forward
  check("A button full throttle byte = 255", currentPacket()[10] === 255);

  // ---- keyboard steering: mpv Lua FIFO heartbeat -> kbState -> packet ------
  // Feed synthetic "KEYS ..." lines through handleKeyLine (the 20 Hz heartbeat's
  // exact path). Neutralize the gamepad first so the keyboard is the ONLY source.
  buttons[ACCEL_BUTTON] = 0; buttons[REVERSE_BUTTON] = 0; axes[STEER_AXIS] = 0;
  handleKeyLine("KEYS w"); // hold W -> full forward
  check("KEYS w = forward throttle (>128)", currentPacket()[10] > NEUTRAL);
  check("KEYS w = full-forward byte 255 (like A/RT path)", currentPacket()[10] === 255);
  handleKeyLine("KEYS d"); // fresh set: W dropped, D held -> steer right, throttle back to neutral
  check("KEYS d = steer right (>128)", currentPacket()[9] > NEUTRAL);
  check("KEYS d releases throttle (recomputed live, not latched)", currentPacket()[10] === NEUTRAL);
  handleKeyLine("KEYS w d"); // hold W and D -> forward AND steer
  check("KEYS w d = forward AND steer", currentPacket()[10] === 255 && currentPacket()[9] > NEUTRAL);
  handleKeyLine("KEYS -"); // release everything -> NEUTRAL on release (the latch regression guard)
  check("KEYS - (release) -> throttle NEUTRAL 0x80", currentPacket()[10] === NEUTRAL);
  check("KEYS - (release) -> steer centered 0x80", currentPacket()[9] === NEUTRAL);
  handleKeyLine("KEYS s"); // reverse
  check("KEYS s = reverse throttle (<128)", currentPacket()[10] < NEUTRAL);
  handleKeyLine("KEYS UP"); // arrow up = forward (alias of W)
  check("KEYS UP (arrow) = forward byte 255", currentPacket()[10] === 255);
  handleKeyLine("KEYS LEFT"); // arrow left = steer left (alias of A)
  check("KEYS LEFT (arrow) = steer left (<128)", currentPacket()[9] < NEUTRAL);
  handleKeyLine("KEYS w SPACE"); // SPACE stop overrides even a held W
  check("KEYS SPACE = neutral (stop overrides held keys)", currentPacket()[10] === NEUTRAL);
  handleKeyLine("KEYS w"); // hold forward again, then simulate a dead pipe (stale heartbeat)
  kbLastKeys = Date.now() - (KB_FAILSAFE_MS + 50); // no heartbeat within the window -> failsafe
  check("stale heartbeat > failsafe window -> neutral (never latch)", currentPacket()[10] === NEUTRAL);
  kbLastKeys = 0; // leave the keyboard inactive for the remaining check

  // ---- HUD toggle: keyboard 'h' (one-shot) + controller D-pad up (edge) ----
  const hud0 = hudVisible; // capture starting state; sequence restores it at the end
  handleKeyLine("HUD");                       // 'h' key -> one-shot toggle
  check("'HUD' line toggles the overlay off", hudVisible === !hud0);
  handleKeyLine("HUD");                        // toggle back on
  check("'HUD' line toggles the overlay back on", hudVisible === hud0);
  feedJoyBytes(ev(-32767, 0x02, HUD_AXIS));    // D-pad up (hat Y negative) -> toggle
  check("D-pad up toggles HUD on rising edge", hudVisible === !hud0);
  feedJoyBytes(ev(-32767, 0x02, HUD_AXIS));    // still held -> must NOT re-toggle
  check("D-pad up held = no repeat toggle", hudVisible === !hud0);
  feedJoyBytes(ev(0, 0x02, HUD_AXIS));         // release
  feedJoyBytes(ev(-32767, 0x02, HUD_AXIS));    // fresh press -> toggles again
  check("D-pad up re-press toggles again", hudVisible === hud0);
  feedJoyBytes(ev(0, 0x02, HUD_AXIS));         // release; HUD back to its original state

  // ---- protocol checksum --------------------------------------------------
  const pkt = currentPacket();
  check("checksum byte14 = b9^b10^b11", pkt[14] === (pkt[9] ^ pkt[10] ^ pkt[11]));

  // ======================= WiFi auto-connect (W1) + reconnect (W4) ==========
  // All synthetic: connectCar() runs against a FAKE wifi backend (spy) so every
  // pre-flight branch is exercised on ANY host; the W4 monitor is driven with
  // synthetic down/up samples + a fake join/sleep — no radio, no real timers, no
  // waiting. caveatShown pre-set so the one-time "no internet" note stays quiet.
  caveatShown = true;
  try {
    const fakeWifi = (over = {}) => {
      const calls = { scan: 0, saved: 0, onCarAP: 0, openPicker: 0, join: [] };
      return {
        calls,
        SCAN_SUPPORTED: over.SCAN_SUPPORTED ?? true,
        // onCarAP may be a bool OR a fn(callIndex) so the macOS 0-saved poll can flip
        // false (the "already?" probe) -> true (landed on the car after the picker).
        onCarAP: async () => { const i = calls.onCarAP++; return (typeof over.onCarAP === "function" ? over.onCarAP(i) : over.onCarAP) ?? false; },
        scanCars: async () => { calls.scan++; return over.scanCars ?? []; },
        savedCars: async () => { calls.saved++; return over.savedCars ?? []; },
        openWifiPicker: async () => { calls.openPicker++; return over.openPicker ?? true; },
        currentCar: async () => (over.currentCar ?? null),
        joinCar: async (ssid) => { calls.join.push(ssid); return over.joinResult ?? { ok: true }; },
      };
    };
    const silent = () => {};
    const noNap = async () => {}; // don't really sleep during the macOS poll test
    // fake native picker: "pick"->chose ssid, "cancel"->dismissed, "nogui"->headless
    const fakePick = (status, ssid) => async () => (status === "pick" ? { status, ssid } : { status });

    // ---- pre-flight branches ------------------------------------------------
    lastSsid = null; reconnecting = false;
    const r1 = await connectCar({ wifi: fakeWifi({ onCarAP: true }), noAutoconnect: false, carSsid: "", log: silent });
    check("preflight: already-on car -> skip (no scan/join)", r1.action === "already");

    const w2 = fakeWifi({ scanCars: [] });
    const r2 = await connectCar({ wifi: w2, noAutoconnect: false, carSsid: "", interactive: () => false, log: silent });
    check("preflight: 0 found -> non-fatal nojoin (app proceeds)", r2.action === "nojoin" && w2.calls.join.length === 0);

    const w3 = fakeWifi({ scanCars: ["WL FPV CAR 75899112"] });
    const r3 = await connectCar({ wifi: w3, noAutoconnect: false, carSsid: "", interactive: () => false, log: silent });
    check("preflight: exactly 1 found -> joinCar(that SSID)", r3.action === "join" && w3.calls.join[0] === "WL FPV CAR 75899112");

    const w4 = fakeWifi({ scanCars: ["WL FPV CAR 11111111", "WL FPV CAR 22222222"] });
    const r4 = await connectCar({ wifi: w4, noAutoconnect: false, carSsid: "", interactive: () => true, prompt: async () => "1", log: silent });
    check("preflight: >=2 picker (tty choice '1') -> joins chosen", w4.calls.join[0] === "WL FPV CAR 22222222" && r4.ssid === "WL FPV CAR 22222222");

    const w5 = fakeWifi({ scanCars: ["WL FPV CAR 11111111", "WL FPV CAR 22222222"] });
    const r5 = await connectCar({ wifi: w5, noAutoconnect: false, carSsid: "", interactive: () => false, log: silent });
    check("preflight: >=2 picker non-TTY -> auto-picks first", w5.calls.join[0] === "WL FPV CAR 11111111" && r5.ssid === "WL FPV CAR 11111111");

    const w6 = fakeWifi({ SCAN_SUPPORTED: false });
    await connectCar({ wifi: w6, noAutoconnect: false, carSsid: "WL FPV CAR 75899112", interactive: () => false, log: silent });
    check("preflight: macOS CAR_SSID override -> join directly (no scan, no savedCars, no picker)", w6.calls.scan === 0 && w6.calls.saved === 0 && w6.calls.openPicker === 0 && w6.calls.join[0] === "WL FPV CAR 75899112");

    // ---- macOS discovery: NO CAR_SSID typing (savedCars + native dialog) -----
    // 0 saved -> open Wi-Fi settings once + poll onCarAP; it flips true -> joined.
    lastSsid = null;
    const wm0 = fakeWifi({ SCAN_SUPPORTED: false, savedCars: [], onCarAP: (i) => i >= 1 });
    const rm0 = await connectCar({ wifi: wm0, noAutoconnect: false, carSsid: "", pickCar: fakePick("pick"), sleep: noNap, log: silent });
    check("preflight: macOS 0 saved -> opens Wi-Fi picker + polls; onCarAP true -> joined", rm0.action === "join" && rm0.ok === true && wm0.calls.openPicker === 1 && wm0.calls.join.length === 0);

    // 0 saved + never lands on the car -> opened picker, non-fatal nojoin.
    lastSsid = null;
    const wm0b = fakeWifi({ SCAN_SUPPORTED: false, savedCars: [], onCarAP: () => false });
    const rm0b = await connectCar({ wifi: wm0b, noAutoconnect: false, carSsid: "", pickCar: fakePick("pick"), sleep: noNap, log: silent });
    check("preflight: macOS 0 saved + never on -> opened picker, non-fatal nojoin", rm0b.action === "nojoin" && wm0b.calls.openPicker === 1 && wm0b.calls.join.length === 0);

    // 1 saved -> native confirm dialog; Connect -> joinCar(that car).
    lastSsid = null;
    const wm1 = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 64462168"] });
    const rm1 = await connectCar({ wifi: wm1, noAutoconnect: false, carSsid: "", pickCar: fakePick("pick", "WL FPV CAR 64462168"), sleep: noNap, log: silent });
    check("preflight: macOS 1 saved -> confirm dialog -> joins that car (no picker window)", rm1.action === "join" && wm1.calls.join[0] === "WL FPV CAR 64462168" && wm1.calls.openPicker === 0);

    // 1 saved -> Cancel -> non-fatal, never joins.
    lastSsid = null;
    const wm1c = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 64462168"] });
    const rm1c = await connectCar({ wifi: wm1c, noAutoconnect: false, carSsid: "", pickCar: fakePick("cancel"), sleep: noNap, log: silent });
    check("preflight: macOS 1 saved -> Cancel -> non-fatal nojoin (never joins)", rm1c.action === "nojoin" && wm1c.calls.join.length === 0);

    // 2+ saved -> choose-from-list -> joinCar(the pick).
    lastSsid = null;
    const wm2 = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 11111111", "WL FPV CAR 22222222"] });
    const rm2 = await connectCar({ wifi: wm2, noAutoconnect: false, carSsid: "", pickCar: fakePick("pick", "WL FPV CAR 22222222"), sleep: noNap, log: silent });
    check("preflight: macOS 2+ saved -> choose-from-list -> joins the pick", rm2.action === "join" && wm2.calls.join[0] === "WL FPV CAR 22222222");

    // 2+ saved -> cancel -> non-fatal nojoin.
    lastSsid = null;
    const wm2c = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 11111111", "WL FPV CAR 22222222"] });
    const rm2c = await connectCar({ wifi: wm2c, noAutoconnect: false, carSsid: "", pickCar: fakePick("cancel"), sleep: noNap, log: silent });
    check("preflight: macOS 2+ saved -> cancel -> non-fatal nojoin", rm2c.action === "nojoin" && wm2c.calls.join.length === 0);

    // not-in-range (joinCar reason) -> reported, non-fatal, SSID kept for W4 rejoin.
    lastSsid = null;
    const wmnr = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 64462168"], joinResult: { ok: false, reason: "gateway never matched car" } });
    const rmnr = await connectCar({ wifi: wmnr, noAutoconnect: false, carSsid: "", pickCar: fakePick("pick", "WL FPV CAR 64462168"), sleep: noNap, log: silent });
    check("preflight: macOS not-in-range -> non-fatal, join attempted, SSID kept for W4", rmnr.action === "join" && rmnr.ok === false && wmnr.calls.join[0] === "WL FPV CAR 64462168" && lastSsid === "WL FPV CAR 64462168");

    // no GUI (ssh/headless) fallback: 1 saved -> auto-join it.
    lastSsid = null;
    const wmg1 = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 64462168"] });
    await connectCar({ wifi: wmg1, noAutoconnect: false, carSsid: "", pickCar: fakePick("nogui"), sleep: noNap, log: silent });
    check("preflight: macOS no-GUI + 1 saved -> auto-joins it", wmg1.calls.join[0] === "WL FPV CAR 64462168");

    // no GUI fallback: 2+ saved -> auto-pick the first.
    lastSsid = null;
    const wmg2 = fakeWifi({ SCAN_SUPPORTED: false, savedCars: ["WL FPV CAR 11111111", "WL FPV CAR 22222222"] });
    await connectCar({ wifi: wmg2, noAutoconnect: false, carSsid: "", pickCar: fakePick("nogui"), sleep: noNap, log: silent });
    check("preflight: macOS no-GUI + 2+ saved -> auto-picks the first", wmg2.calls.join[0] === "WL FPV CAR 11111111");

    const w8 = fakeWifi({ onCarAP: false });
    const r8 = await connectCar({ wifi: w8, noAutoconnect: true, log: silent });
    check("preflight: NO_AUTOCONNECT -> skip entirely", r8.action === "skip" && w8.calls.scan === 0 && w8.calls.join.length === 0);

    const w9 = fakeWifi({ scanCars: ["WL FPV CAR 75899112"], joinResult: { ok: false, reason: "badpw" } });
    const r9 = await connectCar({ wifi: w9, noAutoconnect: false, carSsid: "", interactive: () => false, log: silent });
    check("preflight: bad password -> reported, not looped", r9.ok === false && r9.reason === "badpw" && w9.calls.join.length === 1);

    // ---- W4 reconnect state machine ----------------------------------------
    const seqSample = (seq) => { let i = 0; return async () => seq[Math.min(i++, seq.length - 1)]; };
    const noSleep = async () => {};

    // Debounce (AC4.2): a 2-sample down blip that recovers must NOT rejoin.
    let dbJoins = 0;
    const dbMon = makeReconnectMonitor({ sample: seqSample([true, true, false, false]), join: async () => { dbJoins++; return { ok: true }; }, sleep: noSleep, onNeutralHold: (v) => { reconnecting = v; }, log: silent });
    await dbMon.tick(); await dbMon.tick(); await dbMon.tick();
    check("W4 debounce: <3 consecutive downs -> NO rejoin (transient stall)", dbJoins === 0);
    reconnecting = false;

    // Real drop (AC4.1): connected -> down x3 -> reconnecting -> join ok -> resumed.
    // Stick "held forward" the whole time; neutral MUST be held during reconnect.
    connected = true; buttons[ACCEL_BUTTON] = 1; axes[STEER_AXIS] = 0; kbLastKeys = 0; reconnecting = false;
    check("W4 pre-drop: drive path live (throttle 255, stick held)", currentPacket()[10] === 255);
    let heldT = null, heldS = null, dropJoins = 0;
    const dropMon = makeReconnectMonitor({
      sample: seqSample([true, true, true]),
      join: async () => { dropJoins++; heldT = currentPacket()[10]; heldS = currentPacket()[9]; return { ok: true }; },
      sleep: noSleep, onNeutralHold: (v) => { reconnecting = v; }, log: silent,
    });
    await dropMon.tick();
    check("W4: 1 down -> not yet reconnecting (debouncing)", reconnecting === false && dropJoins === 0);
    await dropMon.tick(); await dropMon.tick();
    check("W4: 3 consecutive downs -> rejoin attempted", dropJoins === 1);
    check("W4: NEUTRAL held during reconnect (throttle 0x80 despite held stick)", heldT === NEUTRAL);
    check("W4: NEUTRAL held during reconnect (steer centered 0x80)", heldS === NEUTRAL);
    check("W4: reconnected -> reconnecting cleared", reconnecting === false);
    check("W4: resume -> drive path live again (throttle 255)", currentPacket()[10] === 255);

    // Backoff schedule + bounded give-up (AC4.3).
    reconnecting = false;
    const backoffs = [];
    const giveMon = makeReconnectMonitor({
      sample: seqSample([true, true, true]),
      join: async () => ({ ok: false, reason: "retry" }),
      sleep: async (ms) => { backoffs.push(ms); }, onNeutralHold: (v) => { reconnecting = v; }, log: silent,
    });
    await giveMon.tick(); await giveMon.tick(); await giveMon.tick();
    check("W4 backoff schedule = 1,2,4,8,8s (cap)", JSON.stringify(backoffs) === JSON.stringify([1000, 2000, 4000, 8000, 8000]));
    check("W4 bounded give-up after N attempts -> monitor stopped", giveMon.stopped === true);
    check("W4 give-up leaves the neutral failsafe engaged", reconnecting === true);
    reconnecting = false;

    // Bad password mid-drive -> bail immediately, no backoff loop.
    let bpSlept = false;
    const bpMon = makeReconnectMonitor({
      sample: seqSample([true, true, true]),
      join: async () => ({ ok: false, reason: "badpw" }),
      sleep: async () => { bpSlept = true; }, onNeutralHold: (v) => { reconnecting = v; }, log: silent,
    });
    await bpMon.tick(); await bpMon.tick(); await bpMon.tick();
    check("W4 badpw mid-drive -> stop, no backoff loop", bpMon.stopped === true && bpSlept === false);
    reconnecting = false;

    // ---- control-loop cadence (AC4.4): the 50Hz send path is synchronous ----
    buttons[ACCEL_BUTTON] = 0;
    const pkt2 = currentPacket();
    check("cadence: currentPacket() is synchronous (Buffer, not a Promise)", Buffer.isBuffer(pkt2) && typeof pkt2.then !== "function");
    const probeMon = makeReconnectMonitor({ sample: async () => false, join: async () => ({ ok: true }), sleep: noSleep, onNeutralHold: () => {}, log: silent });
    const tickRet = probeMon.tick();
    check("cadence: monitor tick is async (Promise) — off the hot path", tickRet && typeof tickRet.then === "function");
    await tickRet;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5000; i++) currentPacket();
    const dms = Number(process.hrtime.bigint() - t0) / 1e6;
    check(`cadence: 5000 currentPacket() calls in ${dms.toFixed(1)}ms (<50ms, no blocking I/O)`, dms < 50);
  } catch (e) {
    check(`wifi selftest threw: ${e && e.message}`, false);
  }

  process.exit(ok ? 0 : 1);
}

// ---- main ------------------------------------------------------------------
if (process.argv.includes("--list")) {
  console.error("Move the sticks. Note which AXIS number changes when you steer (left/right)");
  console.error("and when you throttle (up/down). Ctrl-C to quit, then set STEER_AXIS / THROTTLE_AXIS.\n");
  openGamepad(true);
} else if (process.argv.includes("--selftest")) {
  selftest().catch((e) => { console.log(`FAIL - selftest crashed: ${e && e.message}`); process.exit(1); });
} else if (process.argv.includes("--hud-demo")) {
  hudDemo();
} else {
  main();
}

async function main() {
  // Pre-flight: bring the car network up BEFORE video/control start (non-fatal —
  // an already-joined net or CAR_IP still works if this can't connect).
  await connectCar();
  wifiPowerSaveOff();
  openGamepad(false);
  const video = startVideo();
  const timer = setInterval(() => sock.send(currentPacket(), CTRL_PORT, CAR_IP), 1000 / SEND_HZ);
  // HUD: recompute fps once a second, repaint the overlay data file 4x a second.
  writeHudData();
  const fpsTimer = setInterval(() => { hud.fps = hud.frames; hud.frames = 0; }, 1000);
  const hudTimer = setInterval(writeHudData, 100); // responsive throttle/steer bars
  // W4: reconnect-on-drop monitor — async timer, NEVER in the 50Hz control loop.
  const monitor = startWifiMonitor(video);
  let done = false;
  const shutdown = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    clearInterval(fpsTimer);
    clearInterval(hudTimer);
    if (monitor && monitor._timer) clearInterval(monitor._timer); // stop the reconnect poll
    stopRecord(); // flush + close any recording
    stopKeyboard(); // close the FIFO reader + remove ~/.wltoys-keys
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
