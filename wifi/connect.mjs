// Platform WiFi connect backends for the WLtoys 6401 auto-connect feature (T2).
//
// WHY this file: the pure string/exit-code logic lives in ./core.mjs (T1). This
// module is the thin platform layer that actually talks to the OS WiFi tooling —
// nmcli on Linux/SteamOS, networksetup + ipconfig on macOS — and exposes ONE
// common async surface that drive.mjs / run.sh (T3) call regardless of platform:
//
//   scanCars()            -> Promise<string[]>            list nearby car SSIDs
//   savedCars()           -> Promise<string[]>            list SAVED (preferred) car SSIDs
//   openWifiPicker()      -> Promise<boolean>             open the OS Wi-Fi picker (macOS)
//   onCarAP(carIp)        -> Promise<boolean>             are we on the car AP now?
//   currentCar()          -> Promise<string|null>         which car (or null)
//   joinCar(ssid, carIp)  -> Promise<{ok, reason?}>       join a car AP
//   SCAN_SUPPORTED        -> boolean                      false on macOS (scan dead)
//   wifiIface()           -> Promise<string>              macOS Wi-Fi device (en0…)
//
// Platform split (from docs/research/{linux-wifi-nmcli,macos-wifi-connect}.md):
//   Linux  — full nmcli auto-discovery (scan/join/current all via nmcli argv).
//   macOS  — scanning from a CLI is EMPIRICALLY DEAD (CoreWLAN returns nil SSIDs,
//            SSID strings are redacted). So SCAN_SUPPORTED=false, scanCars()->[],
//            and car-presence is answered by the FIXED GATEWAY (172.16.11.1) via
//            `ipconfig getoption <iface> router`, never by reading the SSID name.
//            Discovery instead reads the user's SAVED (preferred) networks —
//            `networksetup -listpreferredwirelessnetworks <iface>` returns REAL SSID
//            names with NO scan, NO Location permission, NO sudo — so a car the user
//            has ever joined is offered by name with zero CAR_SSID typing; a
//            never-paired car is handled by openWifiPicker() (open Wi-Fi settings).
//
// Security (spec W1.8 / Security): every spawn uses an argv array + shell:false
// (no shell string, so an SSID with spaces can't inject args); the WPA2 password
// is derived from the SSID (core.derivePw) and passed ONLY as an argv element —
// it is NEVER interpolated into a shell string and NEVER logged. This module does
// no logging at all (logging is T3's job) precisely so the pw can't leak here.
// Every SSID is validated with matchCarSsid() before a pw is derived or a connect
// is issued. All parsing calls run under LC_ALL=C for stable, locale-independent
// field text. Zero npm deps — only node:child_process. Style matches drive.mjs.

import { spawn } from "node:child_process";
import { matchCarSsid, derivePw, splitTerse, parseSsidList, classifyNmcliExit } from "./core.mjs";

// Default expected car gateway (mirror drive.mjs's CAR_IP; don't add a 2nd const).
const CAR_IP_DEFAULT = process.env.CAR_IP || "172.16.11.1";

// currentCar() sentinel for macOS: the SSID name is redacted by the OS, so when we
// ARE on the car AP we can't report *which* car — return this truthy, non-null,
// non-SSID marker (matchCarSsid(MAC_CURRENT_CAR) === false on purpose). Callers can
// test presence with either `!== null` or a plain truthiness check.
export const MAC_CURRENT_CAR = "<car>";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- spawn wrapper (the single test seam) ----------------------------------
// run(cmd, args) -> Promise<{code, stdout, stderr}>. shell:false + argv array
// (never a shell string); env forces LC_ALL=C for stable parsing. A spawn error
// (e.g. tool missing) resolves as code 127 with the message on stderr rather than
// rejecting, so callers can treat it as a normal non-zero result. Tests swap the
// real runner via __setRunner() to assert exact argv + drive behavior with no car.
function realRun(cmd, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { shell: false, env: { ...process.env, LC_ALL: "C" } });
    } catch (err) {
      finish({ code: 127, stdout: "", stderr: String((err && err.message) || err) });
      return;
    }
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => finish({ code: 127, stdout, stderr: String((err && err.message) || err) }));
    child.on("close", (code) => finish({ code: code ?? 0, stdout, stderr }));
  });
}

let _runner = realRun;
const run = (cmd, args) => _runner(cmd, args);
// Test seams (internal): replace/restore the spawn runner. Prefixed with __ to
// signal "not part of the public T3 surface — for unit tests only".
export function __setRunner(fn) {
  _runner = fn;
}
export function __resetRunner() {
  _runner = realRun;
}

// ---- macOS Wi-Fi interface resolution --------------------------------------
// wifiIface() -> Promise<string>: resolve the Wi-Fi device (e.g. "en0") by parsing
// `networksetup -listallhardwareports`, which prints blocks like:
//     Hardware Port: Wi-Fi
//     Device: en0
//     Ethernet Address: …
// Do NOT hardcode en0 — it isn't guaranteed. Find the block whose "Hardware Port:"
// is "Wi-Fi" (or legacy "AirPort") and return its "Device:". Falls back to "en0"
// only if nothing matches (best-effort, keeps the caller working).
export async function wifiIface() {
  const { stdout } = await run("networksetup", ["-listallhardwareports"]);
  const lines = String(stdout).split("\n");
  let port = null;
  for (const line of lines) {
    const pm = line.match(/^Hardware Port:\s*(.+?)\s*$/);
    if (pm) {
      port = pm[1];
      continue;
    }
    const dm = line.match(/^Device:\s*(.+?)\s*$/);
    if (dm && port && /^(Wi-?Fi|AirPort)$/i.test(port)) {
      return dm[1];
    }
  }
  return "en0";
}

// ---- Linux backend (nmcli) -------------------------------------------------

// The active (connected) SSID as nmcli reports it, or null. Uses the terse,
// escape-aware ACTIVE,SSID listing so an SSID with spaces survives (splitTerse).
async function linuxActiveSsid() {
  const { code, stdout } = await run("nmcli", ["-t", "-f", "ACTIVE,SSID", "device", "wifi"]);
  if (code !== 0) return null;
  for (const line of String(stdout).split("\n")) {
    if (!line) continue;
    const f = splitTerse(line);
    if (f[0] === "yes") return f[1] ?? "";
  }
  return null;
}

async function linuxScanCars() {
  const { code, stdout } = await run("nmcli", ["-g", "SSID", "device", "wifi", "list", "--rescan", "yes"]);
  if (code !== 0) return [];
  return parseSsidList(stdout);
}

async function linuxOnCarAP(/* carIp unused on Linux — SSID is readable here */) {
  return matchCarSsid(await linuxActiveSsid());
}

async function linuxCurrentCar() {
  const ssid = await linuxActiveSsid();
  return matchCarSsid(ssid) ? ssid.trim() : null;
}

async function linuxJoinCar(ssid /*, carIp */) {
  // Normalize FIRST so the exact string we validate is the exact string we spawn
  // (matchCarSsid trims internally; CAR_SSID/env can carry surrounding whitespace).
  // The gate also guarantees ssid starts with "WL FPV CAR" — never a leading "-" —
  // so it can't be mis-parsed as an nmcli flag even before shell:false + argv array.
  const s = String(ssid ?? "").trim();
  if (!matchCarSsid(s)) return { ok: false, reason: "notcar" };
  const pw = derivePw(s); // never logged
  const { code } = await run("nmcli", ["device", "wifi", "connect", s, "password", pw]);
  const cls = classifyNmcliExit(code); // "ok" | "badpw" | "retry" | "fatal"
  return cls === "ok" ? { ok: true } : { ok: false, reason: cls };
}

// ---- macOS backend (networksetup + ipconfig gateway) -----------------------

async function macOnCarAP(carIp = CAR_IP_DEFAULT) {
  const iface = await wifiIface();
  const { code, stdout } = await run("ipconfig", ["getoption", iface, "router"]);
  return code === 0 && String(stdout).trim() === carIp;
}

async function macCurrentCar() {
  // SSID is redacted on macOS — we can tell we're ON the car (gateway) but not
  // which one. Return the truthy sentinel when connected, null otherwise.
  return (await macOnCarAP()) ? MAC_CURRENT_CAR : null;
}

async function macJoinCar(ssid, carIp = CAR_IP_DEFAULT) {
  // Normalize FIRST — see linuxJoinCar: validate and spawn the identical string, and
  // the "WL FPV CAR" gate rules out a leading "-" being read as a networksetup flag.
  const s = String(ssid ?? "").trim();
  if (!matchCarSsid(s)) return { ok: false, reason: "notcar" };
  const pw = derivePw(s); // never logged
  const iface = await wifiIface();
  await run("networksetup", ["-setairportpower", iface, "on"]); // ensure radio up
  const r = await run("networksetup", ["-setairportnetwork", iface, s, pw]); // pw as argv
  if (r.code !== 0) return { ok: false, reason: (String(r.stderr).trim()) || "join failed" };
  // networksetup can return 0 before association settles — VERIFY by the fixed
  // car gateway (SSID is redacted, so gateway is the only reliable signal).
  for (let i = 0; i < 10; i++) {
    const g = await run("ipconfig", ["getoption", iface, "router"]);
    if (g.code === 0 && String(g.stdout).trim() === carIp) return { ok: true };
    await sleep(500);
  }
  return { ok: false, reason: "gateway never matched car" };
}

// savedCars() -> Promise<string[]>: the SAVED (preferred) car networks, discovered
// WITHOUT a scan. `networksetup -listpreferredwirelessnetworks <iface>` reads the
// stored preferred list (no Location permission, no scan, no sudo) and prints a
// header line ("Preferred networks on enX:") then one TAB-indented SSID per line.
// parseSsidList trims each line, drops blanks + the header (not a car SSID), keeps
// only matchCarSsid hits, and dedupes — so a car the user has EVER joined shows up
// here by its REAL name (unlike a live scan, which macOS redacts). This is how
// drive.mjs offers the car with zero CAR_SSID typing. Non-fatal: non-zero -> [].
async function macSavedCars() {
  const iface = await wifiIface();
  const { code, stdout } = await run("networksetup", ["-listpreferredwirelessnetworks", iface]);
  if (code !== 0) return [];
  return parseSsidList(stdout); // header + non-car SSIDs fail matchCarSsid -> dropped
}

// openWifiPicker() -> Promise<boolean>: open the system Wi-Fi settings pane for the
// NEVER-paired case (a car never joined isn't in the preferred list yet, and macOS
// CLI can't scan). VERIFIED on macOS 26.5.1: `open x-apple.systempreferences:com.apple
// .wifi-settings-extension` launches System Settings straight to Wi-Fi. Non-fatal —
// returns true iff `open` exited 0 (false on a headless/ssh box with no window server),
// so the caller can degrade gracefully. The URL is a single argv element (shell:false),
// never a shell string.
async function macOpenWifiPicker() {
  const { code } = await run("open", ["x-apple.systempreferences:com.apple.wifi-settings-extension"]);
  return code === 0;
}

// ---- backends + platform dispatch ------------------------------------------
// Both backends are exported so unit tests can exercise EITHER platform on ANY
// host (the Mac test box drives the Linux nmcli path via the injected runner).
export const linux = {
  SCAN_SUPPORTED: true,
  scanCars: linuxScanCars,
  savedCars: linuxScanCars, // Linux discovers by live scan — no separate saved-list path
  openWifiPicker: async () => false, // not needed on Linux (scanning works); no-op
  onCarAP: linuxOnCarAP,
  currentCar: linuxCurrentCar,
  joinCar: linuxJoinCar,
};

export const mac = {
  SCAN_SUPPORTED: false, // CLI scanning is dead on macOS — see research
  scanCars: async () => [], // live scan is redacted; discovery uses savedCars() instead
  savedCars: macSavedCars, // preferred (saved) car networks — real names, no scan
  openWifiPicker: macOpenWifiPicker, // never-paired case: open Wi-Fi settings once
  onCarAP: macOnCarAP,
  currentCar: macCurrentCar,
  joinCar: macJoinCar,
};

// The live platform (process.platform per spec W1.8; run.sh does the sysctl dance
// for shell — in JS process.platform is the equivalent, "darwin" vs everything
// else treated as Linux/nmcli).
export const PLATFORM = process.platform === "darwin" ? "darwin" : "linux";
const backend = PLATFORM === "darwin" ? mac : linux;

// The common T3 surface — dispatched to the live platform's backend.
export const SCAN_SUPPORTED = backend.SCAN_SUPPORTED;
export const scanCars = (...a) => backend.scanCars(...a);
export const savedCars = (...a) => backend.savedCars(...a);
export const openWifiPicker = (...a) => backend.openWifiPicker(...a);
export const onCarAP = (...a) => backend.onCarAP(...a);
export const currentCar = (...a) => backend.currentCar(...a);
export const joinCar = (...a) => backend.joinCar(...a);
