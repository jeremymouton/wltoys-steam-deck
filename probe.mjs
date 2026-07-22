#!/usr/bin/env node
// probe.mjs — empirical WLToys 6401 API probe.
//
// Decompiling the WL Tech FPV CAR app (v1.0.10) proved it only ever sends:
//   • the 16-byte control packet (steer / throttle / trim / two more bytes)
//   • video open/close/I-frame commands to the camera
// Nothing else — no light, speed-mode, boost, drift, or horn command exists in
// the app. This tool pokes the surfaces the app NEVER touches, to check the one
// thing a decompile can't: whether the CAR FIRMWARE reacts to anything the app
// doesn't send.
//
// Two things worth probing (from the decompile):
//   1. Control bytes 12 & 13. Byte 13 is the app's 2nd trim; byte 12 is always
//      zero in the app. Sweep both and watch the car for any reaction.
//   2. The camera command channel (:23459). The app uses only cmd 0x20 (open)
//      and 0x21 (close). Scan neighbouring command IDs for replies.
//
// IMPORTANT — checksum. The app's checksum = XOR of wire bytes 9..13 (steer ^
// throttle ^ trim ^ byte12 ^ byte13). The older reverse-engineering used only
// 9^10^11, which happens to match ONLY because bytes 12/13 were left at 0. If
// you fuzz byte 12/13 you MUST fold them into the checksum or the firmware
// rejects the packet and you get a false "no reaction". This tool does that.
//
// Run on a machine joined to the car's WiFi (SSID "WL FPV CAR ..."):
//   node probe.mjs bytes           # sweep control bytes 12 & 13 (car idle)
//   node probe.mjs cam             # scan camera command channel :23459
//   node probe.mjs raw <32-hex>    # send one raw 16-byte control packet
//   node probe.mjs selftest        # offline sanity check (no car needed)
//
// Env:
//   CAR_IP=172.16.11.1             car address
//   HOLD_THROTTLE=90               (hex) apply a steady throttle during `bytes`
//                                  so speed-mode effects are visible. ELEVATE
//                                  THE CAR (wheels off the ground) first.

import dgram from "node:dgram";

const CAR_IP = process.env.CAR_IP || "172.16.11.1";
const CTRL_PORT = 23458; // control packets
const CAM_CMD_PORT = 23459; // camera open/close/etc.
const CAM_VID_PORT = 1234; // camera streams here

// Neutral 16-byte control packet (our known-good base). Bytes:
//  0-3 magic | 4-7 reserved | 8 start(0x66) | 9 steer | 10 throttle | 11 trim
//  | 12 unused | 13 trim2 | 14 crc | 15 stop(0x99)
const BASE = Buffer.from("ca47d500000000006680808000008099", "hex");
const NEUTRAL = 0x80;

// Camera commands the app is known to send (to :23459).
const CAM_START = Buffer.from("a88a200008000000010002000000d204", "hex");
const CAM_STOP = Buffer.from("a88a210006000000010000000000", "hex");

function buildCtrl(steer = NEUTRAL, throttle = NEUTRAL, trim = NEUTRAL, b12 = 0, b13 = 0) {
  const p = Buffer.from(BASE);
  p[9] = steer & 0xff;
  p[10] = throttle & 0xff;
  p[11] = trim & 0xff;
  p[12] = b12 & 0xff;
  p[13] = b13 & 0xff;
  p[14] = (p[9] ^ p[10] ^ p[11] ^ p[12] ^ p[13]) & 0xff; // app's checksum (9..13)
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function hold(ms, fn) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    fn();
    await sleep(20); // ~50 Hz, matching the driver
  }
}
const hex = (b) => b.toString("hex");

// ---------------------------------------------------------------- selftest ---
function selftest() {
  const neutral = buildCtrl();
  const ok = neutral.equals(BASE);
  console.log("neutral packet:", hex(neutral), ok ? "== BASE ✓" : "!= BASE ✗");
  // checksum must fold in bytes 12/13
  const p = buildCtrl(0x80, 0x80, 0x80, 0x11, 0x22);
  const want = (0x80 ^ 0x80 ^ 0x80 ^ 0x11 ^ 0x22) & 0xff;
  console.log(
    `crc(9..13) with b12=0x11 b13=0x22 -> 0x${p[14].toString(16)} (expect 0x${want.toString(16)})`,
    p[14] === want ? "✓" : "✗",
  );
  console.log("cam START:", hex(CAM_START));
  console.log("cam STOP :", hex(CAM_STOP));
  const pass = ok && p[14] === want;
  console.log(pass ? "\nselftest PASSED" : "\nselftest FAILED");
  process.exit(pass ? 0 : 1);
}

// ------------------------------------------------------------- byte sweep ---
async function sweepBytes() {
  const sock = dgram.createSocket("udp4");
  const send = (p) => sock.send(p, CTRL_PORT, CAR_IP);

  let thr = NEUTRAL;
  if (process.env.HOLD_THROTTLE) {
    thr = parseInt(process.env.HOLD_THROTTLE, 16) & 0xff;
    console.log(
      `\n⚠  HOLD_THROTTLE=0x${thr.toString(16)} — the car WILL try to drive. ` +
        `Elevate it (wheels off the ground) before continuing.`,
    );
  }

  let quitting = false;
  const neutralOff = async () => {
    quitting = true;
    for (let i = 0; i < 5; i++) {
      send(buildCtrl());
      await sleep(20);
    }
    sock.close();
  };
  process.on("SIGINT", async () => {
    console.log("\nstopping → neutral");
    await neutralOff();
    process.exit(0);
  });

  // Positive control — the lesson from the camera scan: prove the car is
  // actually executing our packets before trusting a "nothing happened" result.
  // Only possible with throttle (movement is the observable), so it needs the
  // elevated + HOLD_THROTTLE setup.
  if (thr !== NEUTRAL) {
    console.log("\n── POSITIVE CONTROL ──");
    console.log(`Holding throttle 0x${thr.toString(16)} for 3 s. The wheels MUST spin now.`);
    console.log("If they DON'T, stop (Ctrl-C) and fix the car state — the sweep is");
    console.log("meaningless otherwise. Checklist:");
    console.log("  • car powered on (not asleep — toggle power if it idled off)");
    console.log("  • physical remote OFF (an ON remote overrides WiFi throttle)");
    console.log("  • car elevated, wheels free");
    console.log("  • Mac still on the car's Wi-Fi");
    await hold(3000, () => send(buildCtrl(NEUTRAL, thr, NEUTRAL, 0, 0)));
    await hold(500, () => send(buildCtrl()));
    console.log("Did the wheels spin? If yes, the sweep below is trustworthy.\n");
  }

  console.log(
    "Sweeping control bytes 12 and 13. Steer/throttle/trim stay neutral" +
      (thr !== NEUTRAL ? " except the held throttle." : " — the car should NOT move.") +
      "\nWatch the car after each step: lights on/off? any sound? wheels speed up/slow down?\n",
  );

  const values = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0xff];
  for (const idx of [12, 13]) {
    console.log(`\n=== byte ${idx} ===`);
    for (const v of values) {
      if (quitting) return;
      console.log(`  byte${idx} = 0x${v.toString(16).padStart(2, "0")} (${v})`);
      await hold(2500, () => {
        const b12 = idx === 12 ? v : 0;
        const b13 = idx === 13 ? v : 0;
        send(buildCtrl(NEUTRAL, thr, NEUTRAL, b12, b13));
      });
    }
    await hold(700, () => send(buildCtrl())); // reset between bytes
  }

  console.log("\nSweep done.");
  if (thr !== NEUTRAL) {
    console.log("If the wheels spun in the positive control but their speed never");
    console.log("changed across the sweep, bytes 12/13 don't touch the drivetrain —");
    console.log("no hidden speed/boost control (matching the decompile). A small");
    console.log("steering/centering drift on byte 13 is just trim, not a feature.");
  } else {
    console.log("Idle sweep: nothing we can send triggers a light/beep (the app has no");
    console.log("such command), so 'nothing happened' is expected but NOT proof by");
    console.log("itself. For a real drivetrain test, re-run elevated with HOLD_THROTTLE");
    console.log("set so the positive control can confirm the car is accepting packets.");
  }
  await neutralOff();
  process.exit(0);
}

// ---------------------------------------------------------- camera scan ---
async function scanCam() {
  const replies = [];
  const rx = dgram.createSocket({ type: "udp4", reuseAddr: true });
  rx.on("message", (m, r) =>
    replies.push(`:${CAM_CMD_PORT} <= ${r.address}:${r.port} (${m.length}B) ${hex(m).slice(0, 80)}`),
  );
  rx.bind(CAM_CMD_PORT);

  let vidCount = 0;
  const vid = dgram.createSocket({ type: "udp4", reuseAddr: true });
  vid.on("message", () => vidCount++);
  vid.bind(CAM_VID_PORT);

  const tx = dgram.createSocket("udp4");
  const send = (buf) => tx.send(buf, CAM_CMD_PORT, CAR_IP);

  const cleanup = () => {
    send(CAM_STOP);
    setTimeout(() => {
      rx.close();
      vid.close();
      tx.close();
    }, 300);
  };
  process.on("SIGINT", () => {
    console.log("\nstopping");
    cleanup();
    setTimeout(() => process.exit(0), 400);
  });

  // Positive control: fire the REAL start (0x20 WITH its payload) and confirm
  // video actually flows. Without this, a scan can't tell "command ignored"
  // from "my frame was malformed" — the whole test hinges on the channel being
  // demonstrably alive first.
  console.log("\nPositive control: sending the real START (0x20 + payload)…");
  send(CAM_STOP);
  await sleep(500);
  vidCount = 0;
  send(CAM_START);
  await sleep(2000);
  const ctrl = vidCount;
  console.log(
    `  real START → ${ctrl} video pkts on :${CAM_VID_PORT}  ` +
      (ctrl > 0
        ? "✓ channel alive"
        : "✗ NO VIDEO — camera not streaming. Check the green light, and that\n" +
          "    nothing else (browser/app) is holding the single camera session."),
  );
  send(CAM_STOP);
  await sleep(600);
  if (ctrl === 0) {
    console.log("\nAborting scan — the channel isn't proven alive, so results would");
    console.log("be meaningless. Fix the camera and re-run.");
    cleanup();
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // Scan unknown command IDs using a VALID (START-shaped) frame — same payload
  // as open, only the command byte differs. STOP after each so a command that
  // happens to open a stream doesn't bleed into the next.
  console.log("\nScanning command IDs 0x22..0x3f with a valid (START-shaped) frame.");
  console.log("Anything with replies or video beyond the known 0x20/0x21 is real.\n");
  for (let cmd = 0x22; cmd <= 0x3f; cmd++) {
    vidCount = 0;
    const before = replies.length;
    const frame = Buffer.from(CAM_START);
    frame[2] = cmd; // same open payload, different command byte
    process.stdout.write(`=> cmd 0x${cmd.toString(16)} ... `);
    send(frame);
    await sleep(800);
    const newReplies = replies.slice(before);
    const hit = newReplies.length > 0 || vidCount > 0;
    console.log(`${newReplies.length} reply(ies), ${vidCount} video pkts${hit ? "   <-- LOOK" : ""}`);
    for (const r of newReplies) console.log("     " + r);
    send(CAM_STOP);
    await sleep(250);
  }

  console.log("\nScan done. Any line marked <-- LOOK is a command the firmware");
  console.log("actually reacts to. Sending STOP.");
  cleanup();
  setTimeout(() => process.exit(0), 500);
}

// ------------------------------------------------------------------- raw ---
function sendRaw(h) {
  if (!/^[0-9a-fA-F]{32}$/.test(h)) {
    console.error("raw needs exactly 32 hex chars (16 bytes). Example:\n  " + hex(BASE));
    process.exit(1);
  }
  const p = Buffer.from(h, "hex");
  const sock = dgram.createSocket("udp4");
  console.log(`sending ${hex(p)} to ${CAR_IP}:${CTRL_PORT} (10× at 50 Hz)`);
  let n = 0;
  const t = setInterval(() => {
    sock.send(p, CTRL_PORT, CAR_IP);
    if (++n >= 10) {
      clearInterval(t);
      sock.close();
      process.exit(0);
    }
  }, 20);
}

// ------------------------------------------------------------------ main ---
const mode = process.argv[2];
switch (mode) {
  case "selftest":
    selftest();
    break;
  case "bytes":
    sweepBytes();
    break;
  case "cam":
    scanCam();
    break;
  case "raw":
    sendRaw(process.argv[3] || "");
    break;
  default:
    console.log(
      "usage: node probe.mjs <bytes|cam|raw <hex>|selftest>\n" +
        "  bytes    sweep control bytes 12 & 13, watch the car\n" +
        "  cam      scan the camera command channel :23459\n" +
        "  raw HEX  send one raw 16-byte control packet (32 hex chars)\n" +
        "  selftest offline packet-builder check (no car needed)\n" +
        "\nRun on a machine joined to the car's WiFi. See the header of this\n" +
        "file for the checksum note and HOLD_THROTTLE / CAR_IP env vars.",
    );
}
