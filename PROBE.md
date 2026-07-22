# Probing the car for hidden features

Decompiling the WL Tech FPV CAR app (v1.0.10) proved the app only ever sends the
control packet (steer/throttle/trim + two more bytes) and video open/close/I-frame
— **no** light, speed-mode, boost, drift, or horn command exists in it. So the
car's LED + 3 speed modes (per the manual) are driven by the **2.4 GHz physical
remote**, not WiFi.

`probe.mjs` tests the one thing a decompile can't: whether the **car firmware**
reacts to anything the app never sends. Run it on a machine joined to the car's
WiFi (same setup as the driver).

```bash
node probe.mjs selftest   # offline: verify the packet builder (no car needed)
node probe.mjs bytes      # sweep control bytes 12 & 13, watch the car
node probe.mjs cam        # scan the camera command channel :23459
node probe.mjs raw <hex>  # send one raw 16-byte control packet (32 hex chars)
```

### `bytes` — sweep the unused control bytes
Holds steering/throttle/trim neutral and walks bytes 12 and 13 through their range,
~2.5 s per value. **Watch the car** at each step: lights on/off, any sound, wheels
twitching. Byte 13 is the app's second trim, so expect trim-like behavior there;
byte 12 is always 0 in the app — if it does anything, that's a genuine find.

To catch a *speed* effect you need throttle applied. **Elevate the car (wheels off
the ground)** and re-run with a held throttle so you can watch wheel speed:
```bash
HOLD_THROTTLE=b0 node probe.mjs bytes
```

The checksum here covers wire bytes 9–13 (what the app actually does) — a naïve
3-byte checksum would make the firmware silently drop every fuzzed packet and
give you a false "nothing happened".

### `cam` — scan the camera command channel
The app uses only command `0x20` (open) and `0x21` (close) on :23459. This first
fires the **real** START as a positive control and confirms video actually flows
(if it doesn't, it aborts — check the green light and that no browser/app is
holding the single camera session). Then it probes IDs `0x22`–`0x3f` with a valid
START-shaped frame and flags any that produce replies or video with `<-- LOOK`.
Needs the camera streaming, so click **Allow** on the macOS firewall prompt.

### Manual test: does a remote-set speed mode persist into WiFi?
No script needed — the firmware, not the app, decides this:

1. Car on, **physical remote on**, select **High** speed on the remote. Drive a
   bit and note the top speed.
2. Without power-cycling the car, turn the remote **off**, join the car's WiFi,
   and drive with `run.sh`. Compare top speed.
   - Same as High → the speed mode is car-side state and **persists** (set it on
     the remote, then drive over WiFi at that speed).
   - Drops to default → WiFi driving always uses a fixed mode.
