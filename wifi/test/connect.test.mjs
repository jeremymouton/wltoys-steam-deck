// Unit tests for wifi/connect.mjs — the platform WiFi connect backends (T2).
// No real car / radio: we DEPENDENCY-INJECT a fake spawn runner via __setRunner()
// so every test asserts real BEHAVIOR through the public backend functions —
// the exact argv handed to nmcli/networksetup/ipconfig AND the value returned for
// a given fake stdout / exit code. Both platform backends (linux, mac) are exported
// and exercised here regardless of the host OS.
//
// Covers AC1.3 (command construction asserted), AC2.1 (nmcli argv incl. spaces),
// AC3.2 (macOS no-scan fallback + gateway path).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { linux, mac, wifiIface, __setRunner, __resetRunner, MAC_CURRENT_CAR } from "../connect.mjs";

// ---- fake runner ------------------------------------------------------------
// makeFake(responder): records every {cmd,args} call and returns whatever the
// responder maps that call to (defaults: code 0, empty stdout/stderr). fn.calls
// is the spy log the tests assert argv against.
function makeFake(responder) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = (responder ? responder(cmd, args) : null) || {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  fn.calls = calls;
  return fn;
}

// networksetup -listallhardwareports fixtures.
const HW_PORTS_EN0 = [
  "Hardware Port: Ethernet",
  "Device: en3",
  "Ethernet Address: aa:bb:cc:dd:ee:ff",
  "",
  "Hardware Port: Wi-Fi",
  "Device: en0",
  "Ethernet Address: 11:22:33:44:55:66",
  "",
  "Hardware Port: Thunderbolt Bridge",
  "Device: bridge0",
  "Ethernet Address: N/A",
  "",
].join("\n");

const HW_PORTS_EN1 = [
  "Hardware Port: Ethernet",
  "Device: en0",
  "Ethernet Address: aa:bb:cc:dd:ee:ff",
  "",
  "Hardware Port: Wi-Fi",
  "Device: en1",
  "Ethernet Address: 11:22:33:44:55:66",
  "",
].join("\n");

// mac fake: routes networksetup/ipconfig by subcommand.
function macFake({ router = "172.16.11.1", hwports = HW_PORTS_EN0, joinCode = 0, joinStderr = "" } = {}) {
  return makeFake((cmd, args) => {
    if (cmd === "networksetup" && args[0] === "-listallhardwareports") return { stdout: hwports };
    if (cmd === "networksetup" && args[0] === "-setairportnetwork") return { code: joinCode, stderr: joinStderr };
    if (cmd === "ipconfig" && args[0] === "getoption") return { stdout: router + "\n" };
    return {};
  });
}

test.afterEach(() => __resetRunner());

// ========================= Linux (nmcli) ====================================

test("linux scanCars: dedupes to unique car SSIDs from fixture stdout", async () => {
  const fake = makeFake(() => ({
    stdout: ["WL FPV CAR 75899112", "HomeWifi", "", "WL FPV CAR 75899112", "WL FPV CAR 12345678"].join("\n"),
  }));
  __setRunner(fake);
  const cars = await linux.scanCars();
  assert.deepEqual(cars, ["WL FPV CAR 75899112", "WL FPV CAR 12345678"]);
});

test("linux scanCars: invokes nmcli with the exact scan argv", async () => {
  const fake = makeFake(() => ({ stdout: "WL FPV CAR 75899112\n" }));
  __setRunner(fake);
  await linux.scanCars();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].cmd, "nmcli");
  assert.deepEqual(fake.calls[0].args, ["-g", "SSID", "device", "wifi", "list", "--rescan", "yes"]);
});

test("linux scanCars: non-zero nmcli exit -> [] (non-fatal)", async () => {
  __setRunner(makeFake(() => ({ code: 8, stdout: "" })));
  assert.deepEqual(await linux.scanCars(), []);
});

test("linux onCarAP: active car SSID (with spaces) -> true", async () => {
  __setRunner(makeFake(() => ({ stdout: "yes:WL FPV CAR 75899112\nno:HomeWifi\n" })));
  assert.equal(await linux.onCarAP(), true);
});

test("linux onCarAP: active non-car SSID -> false", async () => {
  __setRunner(makeFake(() => ({ stdout: "yes:HomeWifi\nno:WL FPV CAR 75899112\n" })));
  assert.equal(await linux.onCarAP(), false);
});

test("linux onCarAP: queries the terse ACTIVE,SSID listing", async () => {
  const fake = makeFake(() => ({ stdout: "yes:WL FPV CAR 75899112\n" }));
  __setRunner(fake);
  await linux.onCarAP();
  assert.deepEqual(fake.calls[0].args, ["-t", "-f", "ACTIVE,SSID", "device", "wifi"]);
});

test("linux currentCar: returns the active car SSID, else null", async () => {
  __setRunner(makeFake(() => ({ stdout: "yes:WL FPV CAR 75899112\n" })));
  assert.equal(await linux.currentCar(), "WL FPV CAR 75899112");
  __setRunner(makeFake(() => ({ stdout: "yes:HomeWifi\n" })));
  assert.equal(await linux.currentCar(), null);
});

test("linux joinCar: builds connect argv (pw = last 8) and exit 0 -> {ok:true}", async () => {
  const fake = makeFake(() => ({ code: 0 }));
  __setRunner(fake);
  const r = await linux.joinCar("WL FPV CAR 75899112");
  assert.deepEqual(r, { ok: true });
  assert.equal(fake.calls[0].cmd, "nmcli");
  assert.deepEqual(fake.calls[0].args, ["device", "wifi", "connect", "WL FPV CAR 75899112", "password", "75899112"]);
});

test("linux joinCar: exit 4 -> {ok:false, reason:'badpw'}", async () => {
  __setRunner(makeFake(() => ({ code: 4 })));
  assert.deepEqual(await linux.joinCar("WL FPV CAR 75899112"), { ok: false, reason: "badpw" });
});

test("linux joinCar: exit 10 -> {ok:false, reason:'retry'}", async () => {
  __setRunner(makeFake(() => ({ code: 10 })));
  assert.deepEqual(await linux.joinCar("WL FPV CAR 75899112"), { ok: false, reason: "retry" });
});

test("linux joinCar: exit 8 -> {ok:false, reason:'fatal'}", async () => {
  __setRunner(makeFake(() => ({ code: 8 })));
  assert.deepEqual(await linux.joinCar("WL FPV CAR 75899112"), { ok: false, reason: "fatal" });
});

test("linux joinCar: rejects a non-car SSID BEFORE spawning", async () => {
  const fake = makeFake(() => ({ code: 0 }));
  __setRunner(fake);
  const r = await linux.joinCar("Some Home WiFi");
  assert.equal(r.ok, false);
  assert.equal(fake.calls.length, 0); // never spawned nmcli
});

// ========================= macOS (networksetup / gateway) ===================

test("mac wifiIface: parses the Wi-Fi block -> its Device (en0)", async () => {
  __setRunner(makeFake(() => ({ stdout: HW_PORTS_EN0 })));
  assert.equal(await wifiIface(), "en0");
});

test("mac wifiIface: does NOT hardcode en0 — returns the real device (en1)", async () => {
  __setRunner(makeFake(() => ({ stdout: HW_PORTS_EN1 })));
  assert.equal(await wifiIface(), "en1");
});

test("mac onCarAP: gateway == car IP -> true", async () => {
  __setRunner(macFake({ router: "172.16.11.1" }));
  assert.equal(await mac.onCarAP("172.16.11.1"), true);
});

test("mac onCarAP: gateway != car IP -> false", async () => {
  __setRunner(macFake({ router: "192.168.0.1" }));
  assert.equal(await mac.onCarAP("172.16.11.1"), false);
});

test("mac onCarAP: probes ipconfig getoption <iface> router", async () => {
  const fake = macFake({ router: "172.16.11.1" });
  __setRunner(fake);
  await mac.onCarAP("172.16.11.1");
  const probe = fake.calls.find((c) => c.cmd === "ipconfig");
  assert.deepEqual(probe.args, ["getoption", "en0", "router"]);
});

test("mac currentCar: on car -> truthy sentinel; off car -> null", async () => {
  __setRunner(macFake({ router: "172.16.11.1" }));
  const on = await mac.currentCar();
  assert.equal(on, MAC_CURRENT_CAR);
  assert.ok(on); // truthy marker
  __setRunner(macFake({ router: "192.168.0.1" }));
  assert.equal(await mac.currentCar(), null);
});

test("mac joinCar: builds setairportnetwork argv (pw from SSID) + verifies by gateway", async () => {
  const fake = macFake({ router: "172.16.11.1" });
  __setRunner(fake);
  const r = await mac.joinCar("WL FPV CAR 75899112", "172.16.11.1");
  assert.deepEqual(r, { ok: true });
  const join = fake.calls.find((c) => c.cmd === "networksetup" && c.args[0] === "-setairportnetwork");
  assert.ok(join, "expected a -setairportnetwork call");
  assert.deepEqual(join.args, ["-setairportnetwork", "en0", "WL FPV CAR 75899112", "75899112"]);
  // radio powered on first
  assert.ok(fake.calls.some((c) => c.cmd === "networksetup" && c.args[0] === "-setairportpower"));
});

test("mac joinCar: nonzero rc -> {ok:false} with reason from stderr", async () => {
  __setRunner(macFake({ joinCode: 8, joinStderr: "Could not find network WL FPV CAR ..." }));
  const r = await mac.joinCar("WL FPV CAR 75899112", "172.16.11.1");
  assert.equal(r.ok, false);
  assert.match(r.reason, /Could not find network/);
});

test("mac joinCar: rejects a non-car SSID before spawning", async () => {
  const fake = macFake();
  __setRunner(fake);
  const r = await mac.joinCar("Cafe Guest WiFi", "172.16.11.1");
  assert.equal(r.ok, false);
  assert.equal(fake.calls.length, 0);
});

test("mac: SCAN_SUPPORTED is false and scanCars() resolves []", async () => {
  assert.equal(mac.SCAN_SUPPORTED, false);
  assert.deepEqual(await mac.scanCars(), []);
});

// ========================= security: pw never logged ========================

test("pw is never logged: no console.* call in the module references pw", async () => {
  const src = await readFile(new URL("../connect.mjs", import.meta.url), "utf8");
  const consoleCalls = src.match(/console\.[a-zA-Z]+\([^)]*\)/g) || [];
  for (const c of consoleCalls) {
    assert.ok(!/\bpw\b/.test(c), `pw leaked in a console call: ${c}`);
  }
});
