// macOS gamepad helper for wltoys-steam-deck.
//
// Emits the SAME fixed 8-byte joydev event records that drive.mjs's feedJoyBytes
// parser already reads on Linux (/dev/input/jsN), so the Node side stays byte-for-
// byte unchanged across OSes:
//
//   bytes 0-3  timestamp   (ignored by feedJoyBytes)
//   bytes 4-5  value       little-endian Int16
//   byte  6    type        0x02 = axis, 0x01 = button, |0x80 = synthetic "init"
//   byte  7    number      axis / button index
//
// Uses Apple's GameController framework — the sanctioned high-level input path.
// Unlike raw IOKit HID it does NOT trigger the "Input Monitoring" TCC prompt.
// Requires an embedded Info.plist carrying a CFBundleIdentifier, or
// GCController.controllers() stays permanently empty (see build-mac.sh).
//
// Element -> project index mapping (GCExtendedGamepad; sticks -1..1, triggers 0..1):
//   STEER_AXIS    0  leftThumbstick.xAxis   (right = +1)          as-is
//   THROTTLE_AXIS 1  leftThumbstick.yAxis   NEGATED (Apple up=+1) -y
//   LT_AXIS       2  leftTrigger.value      (0..1)                as-is
//   RT_AXIS       5  rightTrigger.value     (0..1)                as-is
//   TRIM_AXIS     6  dpad.xAxis             (left=-1 / right=+1)  as-is
//   (dpad Y)      7  dpad.yAxis             NEGATED               -y
//   A/B/X/Y       0/1/2/3   buttonA/B/X/Y
//   LB/RB         4/5       leftShoulder/rightShoulder
//   View          6         buttonOptions (Xbox "View" / PS "Share", may be nil)
//   Menu          7         buttonMenu

import GameController
import Foundation

let out = FileHandle.standardOutput

// Encode 8-byte joydev records into a reusable frame buffer, then flush the whole
// frame in ONE write. A GCExtendedGamepad value-change fires all 14 mapped
// elements at once (6 axes + 8 buttons); emitting them per-record meant 14
// write() syscalls per frame at the pad's ~60-125 Hz poll rate. Coalescing to one
// write per frame cuts that ~14x AND hands drive.mjs a clean 8-byte-aligned chunk
// (so its parser skips the concat/subarray path). Same bytes, same order.
var frame = Data()

// Append one 8-byte joydev record. `value` is clamped to the Int16 range and
// stored little-endian at bytes 4-5.
func emit(_ value: Int, _ type: UInt8, _ number: UInt8) {
    var b = [UInt8](repeating: 0, count: 8)
    let v = Int16(max(-32767, min(32767, value)))
    let uv = UInt16(bitPattern: v)
    b[4] = UInt8(uv & 0xFF)
    b[5] = UInt8(uv >> 8)
    b[6] = type
    b[7] = number
    frame.append(contentsOf: b)
}

// Write the accumulated frame in one syscall, then reset (keeping capacity so no
// reallocation per frame).
func flush() {
    if frame.isEmpty { return }
    try? out.write(contentsOf: frame)
    frame.removeAll(keepingCapacity: true)
}

// Axis: scale the element's native float (sticks -1..1, triggers 0..1) to Int16.
// `initial` sets the 0x80 flag so feedJoyBytes records this as the axis rest value.
func ax(_ f: Float, _ n: UInt8, initial: Bool = false) {
    emit(Int((f * 32767).rounded()), initial ? 0x82 : 0x02, n)
}
func bt(_ pressed: Bool, _ n: UInt8, initial: Bool = false) {
    emit(pressed ? 1 : 0, initial ? 0x81 : 0x01, n)
}

// The six mapped axes, in one shot. Left-stick Y and dpad Y are negated because
// Apple reports up = +1 while Linux joydev reports up = -1; negating keeps
// drive.mjs's `net = -deadzone(axes[THROTTLE_AXIS])` meaning "up = forward".
func axisFrame(_ g: GCExtendedGamepad, initial: Bool) {
    ax(g.leftThumbstick.xAxis.value, 0, initial: initial)
    ax(-g.leftThumbstick.yAxis.value, 1, initial: initial)
    ax(g.leftTrigger.value, 2, initial: initial)
    ax(g.rightTrigger.value, 5, initial: initial)
    ax(g.dpad.xAxis.value, 6, initial: initial)
    ax(-g.dpad.yAxis.value, 7, initial: initial)
}

// The eight mapped buttons. buttonOptions can be nil on some pads — guard it.
func buttonFrame(_ g: GCExtendedGamepad) {
    bt(g.buttonA.isPressed, 0)
    bt(g.buttonB.isPressed, 1)
    bt(g.buttonX.isPressed, 2)
    bt(g.buttonY.isPressed, 3)
    bt(g.leftShoulder.isPressed, 4)
    bt(g.rightShoulder.isPressed, 5)
    bt(g.buttonOptions?.isPressed ?? false, 6)
    bt(g.buttonMenu.isPressed, 7)
}

func attach(_ g: GCExtendedGamepad) {
    // INIT BURST — mirror joydev's on-open synthetic events so drive.mjs seeds
    // axisRest[] correctly. This is critical for macOS triggers (which rest at 0):
    // without it axisRest defaults to -1, span becomes 2, and a resting trigger
    // reads as HALF throttle. Each axis carries its current (rest) value; each
    // button is emitted released.
    axisFrame(g, initial: true)
    for n: UInt8 in 0...7 { bt(false, n, initial: true) }
    flush() // one write for the whole init burst

    // Live updates — event-driven (fires on state change, lower latency than
    // polling and ample for drive.mjs's 50 Hz sampling loop). One write per frame.
    g.valueChangedHandler = { gp, _ in
        axisFrame(gp, initial: false)
        buttonFrame(gp)
        flush()
    }
}

// De-dupe: a controller present before launch is delivered both by
// GCController.controllers() and by the DidConnect notification once the run
// loop spins — attach it (and its init burst) exactly once.
var attached = Set<ObjectIdentifier>()

func connect(_ c: GCController) {
    guard let g = c.extendedGamepad else { return }
    let id = ObjectIdentifier(c)
    if attached.contains(id) { return }
    attached.insert(id)
    attach(g)
}

let center = NotificationCenter.default
center.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { note in
    if let c = note.object as? GCController { connect(c) }
}
center.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { note in
    if let c = note.object as? GCController { attached.remove(ObjectIdentifier(c)) }
    // Safety: a pad vanishing mid-drive must not latch the last throttle value.
    // Emit a neutral frame — all mapped axes to rest 0, all buttons released.
    for n: UInt8 in [0, 1, 2, 5, 6, 7] { ax(0, n) }
    for n: UInt8 in 0...7 { bt(false, n) }
    flush() // one write for the neutral safety frame
}

// Register the connect observer BEFORE the run loop, then also attach any pad
// already connected at launch (belt-and-suspenders per Apple forum 667832).
for c in GCController.controllers() { connect(c) }

GCController.startWirelessControllerDiscovery {}   // wake sleeping Bluetooth pads
RunLoop.main.run()                                  // pump connect/value events
