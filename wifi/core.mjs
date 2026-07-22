// Pure WiFi core for the WLtoys 6401 auto-connect feature — NO I/O, NO spawn.
//
// WHY a pure core: the car AP join logic (scan → filter → derive pw → connect →
// reconnect) is identical on Linux (nmcli) and macOS (networksetup); only the
// tool invocation differs. These functions are the shared, side-effect-free heart
// both platform backends (T2 wifi/connect.mjs) call, so all the tricky string /
// exit-code logic is unit-tested once with synthetic tool output — no real car,
// no radio, no root. Keep this file dependency-free (like drive.mjs's own core):
// no node builtins needed here, pure JS in/out only.
//
// Car AP facts (spec W1 / Known hardware facts): SSID is "WL FPV CAR <8+ digits>"
// (e.g. "WL FPV CAR 75899112"), WPA2 password = the LAST 8 digits of that SSID,
// gateway 172.16.11.1. Security: validate every scanned SSID against matchCarSsid
// BEFORE deriving a pw or handing the string to a spawned connect — the SSID comes
// from untrusted scan output; argv arrays + this pattern gate neutralize injection.

// matchCarSsid(ssid) -> boolean. True iff `ssid` is a car AP SSID. Trim first (nmcli
// / networksetup can surface leading/trailing space), then test case-insensitively:
// literal "WL FPV CAR " + at least 8 digits, whole string. "\d{8,}" enforces the
// spec's ≥8-digit rule (the pw is the last 8, so <8 digits is not a real car SSID).
export function matchCarSsid(ssid) {
  if (typeof ssid !== "string") return false;
  return /^wl fpv car \d{8,}$/i.test(ssid.trim());
}

// derivePw(ssid) -> string: the car's WPA2 password = the LAST 8 digits of the SSID.
// Strip every non-digit (tolerates case/spacing) then take the trailing 8. If fewer
// than 8 digits exist, returns what's there — callers gate with matchCarSsid() first,
// so a well-formed car SSID always yields exactly 8. NEVER log the return value.
export function derivePw(ssid) {
  return String(ssid ?? "").replace(/\D/g, "").slice(-8);
}

// splitTerse(line) -> string[]: escape-aware split of ONE `nmcli -t` (terse) line on
// the REAL ':' field delimiters. In `-t` mode (default -e yes) nmcli escapes a literal
// colon as "\:" and a literal backslash as "\\"; spaces are NOT delimiters and NOT
// escaped, so "WL FPV CAR 75899112" appears verbatim inside a field. Do NOT split on
// space (the classic terse-parse bug). Walk char-by-char: "\" consumes the next char
// literally (\: -> :, \\ -> \), an UNescaped ":" ends a field, anything else appends.
// Verified algorithm from docs/research/linux-wifi-nmcli.md.
export function splitTerse(line) {
  const out = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      cur += line[++i] ?? ""; // "\:" -> ":"   "\\" -> "\"
    } else if (c === ":") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// parseSsidList(stdout) -> string[]: turn `nmcli -g SSID device wifi list` output (one
// RAW SSID per line — -g emits a single field with NO escaping/colorizing) into the
// unique set of CAR SSIDs. Trim each line, drop blanks, keep only matchCarSsid hits,
// dedupe (the same AP shows once per band/BSSID). Order preserved (first-seen). The
// caller decides 0 -> message / 1 -> auto-join / ≥2 -> picker (spec W1.4-1.6).
export function parseSsidList(stdout) {
  const seen = new Set();
  const out = [];
  for (const raw of String(stdout ?? "").split("\n")) {
    const ssid = raw.trim();
    if (!ssid || !matchCarSsid(ssid) || seen.has(ssid)) continue;
    seen.add(ssid);
    out.push(ssid);
  }
  return out;
}

// classifyNmcliExit(code) -> "ok" | "badpw" | "retry" | "fatal": map an nmcli process
// exit code to a W4-reconnect action (docs/research exit-code table). Distinguishing 4
// (activation failed — the wrong-password signature; bail, don't loop forever) from
// 3/10 (timeout / AP-not-found — car slow/off/out-of-range; retry with backoff) is the
// whole point. 8 (NM not running) and 2 (bad argv — our bug) are fatal, clear message.
// 0 = success (incl. idempotent re-activate). Anything else -> retry (safe default).
export function classifyNmcliExit(code) {
  switch (code) {
    case 0:
      return "ok";
    case 4:
      return "badpw"; // activation failed / secrets required -> bail
    case 3: // --wait timeout (car slow/gone)
    case 10: // connection/AP does not exist (car off / out of range)
      return "retry";
    case 8: // NetworkManager not running
    case 2: // invalid input / wrong nmcli invocation (our bug)
      return "fatal";
    default:
      return "retry";
  }
}
