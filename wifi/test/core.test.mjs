// Unit tests for wifi/core.mjs — the pure auto-connect core (AC1.1, part AC2.1).
// No real car / radio: every case feeds synthetic SSID strings and nmcli output.
import test from "node:test";
import assert from "node:assert/strict";
import { matchCarSsid, derivePw, splitTerse, parseSsidList, classifyNmcliExit } from "../core.mjs";

test("matchCarSsid: canonical car SSID matches", () => {
  assert.equal(matchCarSsid("WL FPV CAR 75899112"), true);
});

test("matchCarSsid: case-insensitive", () => {
  assert.equal(matchCarSsid("wl fpv car 12345678"), true);
});

test("matchCarSsid: leading/trailing space tolerated (trim)", () => {
  assert.equal(matchCarSsid(" WL FPV CAR 75899112 "), true);
});

test("matchCarSsid: no digits -> reject", () => {
  assert.equal(matchCarSsid("WL FPV CAR"), false);
});

test("matchCarSsid: unrelated network -> reject", () => {
  assert.equal(matchCarSsid("Some Home WiFi"), false);
});

test("matchCarSsid: only 7 digits -> reject (needs >=8)", () => {
  assert.equal(matchCarSsid("WL FPV CAR 1234567"), false);
});

test("matchCarSsid: 10 digits -> match (>=8)", () => {
  assert.equal(matchCarSsid("WL FPV CAR 1234567890"), true);
});

test("matchCarSsid: non-string input -> false (no throw)", () => {
  assert.equal(matchCarSsid(undefined), false);
  assert.equal(matchCarSsid(null), false);
  assert.equal(matchCarSsid(12345678), false);
});

test("derivePw: last 8 digits of a canonical SSID", () => {
  assert.equal(derivePw("WL FPV CAR 75899112"), "75899112");
});

test("derivePw: 10-digit SSID -> LAST 8 digits", () => {
  assert.equal(derivePw("WL FPV CAR 1234567890"), "34567890");
});

test("derivePw: case + odd spacing don't break it", () => {
  assert.equal(derivePw("  wl fpv car 75899112  "), "75899112");
});

test("splitTerse: 'yes:WL FPV CAR 75899112' -> two fields, space preserved", () => {
  assert.deepEqual(splitTerse("yes:WL FPV CAR 75899112"), ["yes", "WL FPV CAR 75899112"]);
});

test("splitTerse: escaped colon '\\:' is literal, not a delimiter", () => {
  // one field containing a real colon: "WL FPV CAR:x"
  assert.deepEqual(splitTerse("WL FPV CAR\\:x"), ["WL FPV CAR:x"]);
});

test("splitTerse: escaped colon inside a two-field line", () => {
  assert.deepEqual(splitTerse("yes:WL FPV CAR\\:x"), ["yes", "WL FPV CAR:x"]);
});

test("splitTerse: escaped backslash '\\\\' -> single literal backslash", () => {
  assert.deepEqual(splitTerse("a\\\\b"), ["a\\b"]);
});

test("splitTerse: no delimiters -> single field verbatim", () => {
  assert.deepEqual(splitTerse("WL FPV CAR 75899112"), ["WL FPV CAR 75899112"]);
});

test("parseSsidList: filters to unique car SSIDs, drops non-car/blank/dupes", () => {
  const stdout = [
    "WL FPV CAR 75899112",
    "Some Home WiFi",
    "",
    "WL FPV CAR 75899112", // duplicate
  ].join("\n");
  assert.deepEqual(parseSsidList(stdout), ["WL FPV CAR 75899112"]);
});

test("parseSsidList: keeps multiple distinct car SSIDs, first-seen order", () => {
  const stdout = [
    "WL FPV CAR 75899112",
    "Neighbor 5G",
    "WL FPV CAR 12345678",
    "  WL FPV CAR 75899112  ", // trims to a dupe of the first
    "",
  ].join("\n");
  assert.deepEqual(parseSsidList(stdout), ["WL FPV CAR 75899112", "WL FPV CAR 12345678"]);
});

test("parseSsidList: empty / no car SSIDs -> empty array", () => {
  assert.deepEqual(parseSsidList(""), []);
  assert.deepEqual(parseSsidList("Home\nNeighbor 5G\n"), []);
});

test("classifyNmcliExit: exit-code table (research doc)", () => {
  assert.equal(classifyNmcliExit(0), "ok");
  assert.equal(classifyNmcliExit(4), "badpw");
  assert.equal(classifyNmcliExit(3), "retry");
  assert.equal(classifyNmcliExit(10), "retry");
  assert.equal(classifyNmcliExit(8), "fatal");
  assert.equal(classifyNmcliExit(2), "fatal");
  assert.equal(classifyNmcliExit(99), "retry"); // unknown -> safe default
});
