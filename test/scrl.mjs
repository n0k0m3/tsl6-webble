// Tests for the BLE board support: the board codec (public/lib/scrl.js), the adapter to the TSL6 pages
// (public/lib/scrl-tsl6.js, public/lib/h2-menus.js) and the type filter in public/lib/tsl6-settings.js.
// No vendor code and no firmware repo needed:  node test/scrl.mjs
//
// test/fixtures/scrl-protocol.json holds what the firmware of the board defines and does (tools/scrl-fixture.mjs
// writes it from the firmware repo). So these tests check the app against the real firmware code, not a copy.
import fs from "node:fs";
import assert from "node:assert/strict";
import * as SC from "../public/lib/scrl.js";
import * as M from "../public/lib/h2-menus.js";
import * as A from "../public/lib/scrl-tsl6.js";
import * as T from "../public/lib/tsl6-settings.js";
import { decodeLiveState, meInfo, ROW_BY_ID, STATUS_ROWS } from "../public/lib/tsl6-status.js";
import { promptDiag } from "../public/lib/tsl6-gauge.js";
import { boardWrites, passkeyTexts } from "./scrl-cases.mjs";
import * as CP from "../public/lib/scrl-capture.js";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/scrl-protocol.json", import.meta.url), "utf8"));
const V = FX.vectors;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`ok ${n} - ${name}`); };
const fromHex = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));

// ---------------------------------------------------------------- codec against the firmware
await test("flags, commands, update constants, UUIDs and the slot size match the firmware", () => {
  assert.deepEqual(SC.FLAG, FX.flags);
  assert.deepEqual(SC.CMD, FX.cmd);
  assert.deepEqual(SC.OTA_ERR, FX.ota_err);
  assert.equal(SC.OTA_ERR_TEXT.length, Object.keys(FX.ota_err).length);
  for (const [k, v] of Object.entries(FX.ota)) assert.equal(SC.OTA[k], v, k);
  assert.deepEqual(SC.UUIDS, FX.uuids);
  assert.equal(SC.OTA.SLOT_SIZE, FX.slot_size);
  assert.deepEqual(SC.PHASES, V.phases);
  assert.deepEqual(SC.BLOCKS, V.blocks);
  for (const b of V.blocks) assert.ok(SC.BLOCK_TEXT[b], `text for ${b}`);
  assert.equal(SC.LIVE_LEN, V.live_len);
  assert.equal(SC.STATUS_MAX, V.status_max);
});

await test("parseStatus and parseLive read the output of the firmware packers", () => {
  const st = SC.parseStatus(V.status_json);
  assert.deepEqual(st, {
    sent: 0x01020304, phase: "SecondPending", block: "gap", nativeAge: 2, dasAge: 40, apState: 6, handsOn: 3,
    vehicleBus: "can0", lastTxAllowed: true, pairsAborted: 7, timerArmed: true, opMode: 1,
    flags: SC.FLAG.TX_ALLOWED | SC.FLAG.ACTIVE | SC.FLAG.ENABLED | SC.FLAG.HW4_SEEN,
    rx: { all: 1000, x3c2: 10, x39b: 20, x370: 0, x257: 30, x318: 40, x129: 50, dropped: 1 },
    tx: { ok: 8, failed: 2, refused: 3 }, busOff: 1, resetReason: 1, powerOn: 42, uptime: 3600, rxPin: 2,
  });
  assert.equal(SC.parseStatus(V.big_status_json).rx.dropped, 4294967295);
  assert.throws(() => SC.parseStatus(V.status_json.slice(0, 200)));
  assert.deepEqual(SC.parseLive(fromHex(V.live_hex)), {
    phase: 2, block: 14, apState: 6, handsOn: 3, flagsLow: 0x25, sent: 0x01020304, pairsAborted: 7,
    nativeAge: 2, dasAge: 40, feedMv: 0, boardMa: 0,
  });
  assert.equal(SC.parseLive(fromHex(V.big_live_hex)).pairsAborted, 65535);
  assert.throws(() => SC.parseLive(fromHex(V.live_hex).subarray(0, 18)), /19/);
  assert.equal(SC.mergeFlags(0xFFFF, 0), 0xFF00, "a Live record does not clear the high flag bits");
});

await test("the firmware settings reader accepts each write that the app can send", () => {
  const writes = boardWrites(V.default_settings_json, V.limits.interval_max);
  assert.ok(writes.length > 60);
  for (const [current, write] of writes) {
    const fx = FX.writes.find(w => w.current === current && w.write === write);
    assert.ok(fx, `no firmware answer for ${write}: run tools/scrl-fixture.mjs`);
    assert.equal(fx.result, 0, write);
    const want = { ...JSON.parse(current), ...JSON.parse(write) };
    assert.deepEqual(fx.settings, want, `${write} on ${current}`);
    assert.equal(fx.op_mode_named, "op_mode" in JSON.parse(write), `op_mode named: ${write}`);
  }
  assert.equal(FX.writes.length, writes.length, "the fixture has no stale writes");
});

await test("a settings save names op_mode only when it changes (a bus-off lock must stay)", () => {
  const board = { ...SC.parseSettings(V.default_settings_json), enabled: true, op_mode: 1 };
  assert.deepEqual(SC.settingsDiff(board, { ...board, gap_ms: 300 }), { gap_ms: 300 });
  for (const [v] of M.h2Times()) assert.ok(!("op_mode" in A.h2SettingChange("time", v)));
  for (const [v] of M.H2_GAP) assert.ok(!("op_mode" in A.h2SettingChange("jg", v)));
  for (const [v] of M.h2Order()) assert.ok(!("op_mode" in A.h2SettingChange("jj", v)));
});

await test("the firmware passkey reader takes the command of the app", () => {
  for (const text of passkeyTexts) {
    const fx = FX.passkeys.find(p => p.text === text);
    assert.ok(fx && fx.ok, text);
    assert.equal(fx.passkey, Number(text));
    assert.equal(SC.passkeyCommand(text)[0], SC.CMD.SET_PASSKEY);
  }
  for (const bad of ["", "12345", "1234567", "12345a", "１２３４５６"]) assert.throws(() => SC.passkeyCommand(bad));
});

await test("update: BEGIN bytes, events, window and cut detection", () => {
  const sha = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const b = SC.otaBegin(0x000AD320, sha);
  assert.deepEqual([...b.subarray(0, 5)], [0x01, 0x20, 0xD3, 0x0A, 0x00]);
  assert.deepEqual([...b.subarray(5)], [...sha]);
  assert.deepEqual(SC.parseOtaEvent(fromHex("0406ffffffff")), { event: 4, status: 6, offset: 4294967295 });
  assert.ok(SC.mayWrite(4096 - 240, 240, 0) && !SC.mayWrite(4096 - 239, 240, 0));
  assert.ok(SC.creditIsWhole(2160, 240, 700000) && !SC.creditIsWhole(2100, 240, 700000) && SC.creditIsWhole(709408, 240, 709408));
  assert.deepEqual(SC.CHUNK_STEPS.map(SC.nextChunk), [240, 180, 100, 20, 0]);
  // iPhone and iPad send OTA data with response, and only to firmware that takes it (Info "otaw", 0.4.2).
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Bluefy";
  const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
  const DESK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36";
  assert.equal(SC.otaWriteMode({ otaw: 1 }, DESK), "command");
  assert.equal(SC.otaWriteMode({}, DESK), "command");
  assert.equal(SC.otaWriteMode({ otaw: 1 }, IPHONE), "response");
  assert.equal(SC.otaWriteMode({ fw: "0.4.1" }, IPHONE), "");
  assert.equal(SC.otaWriteMode(null, IPHONE), "");
  assert.equal(SC.otaWriteMode({ otaw: 1 }, IPAD, 5), "response", "iPadOS shows a Mac user agent with touch");
  assert.equal(SC.otaWriteMode({ otaw: 1 }, IPAD, 0), "command", "a real Mac");
  assert.equal(SC.otaWriteMode({ otaw: "1" }, IPHONE), "", "otaw must be the number 1");
});

await test("the board table and the board descriptor match the firmware", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SC.BOARDS).map(([id, b]) => [id, b.chip])), FX.boards);
  for (const chip of Object.values(FX.boards)) assert.ok(chip in SC.CHIP_IDS, `chip ID for ${chip}`);
  assert.equal(SC.IMG.BOARD_MAGIC, FX.board_desc.MAGIC);
  assert.equal(SC.IMG.BOARD_VERSION, FX.board_desc.VERSION);
  assert.equal(SC.IMG.BOARD_AT, FX.board_desc.OFFSET);
});

await test("boardOf and boardName: new Info, firmware 0.1.0 Info, no Info", () => {
  assert.deepEqual(SC.boardOf({ board: "lilygo-t2can", chip: "esp32s3", can: "mcp2515" }), { id: "lilygo-t2can", chip: "esp32s3", can: "mcp2515" });
  assert.deepEqual(SC.boardOf({ board: "nanoh2-minican", chip: "esp32h2" }), { id: "nanoh2-minican", chip: "esp32h2", can: "twai" });
  assert.equal(SC.boardOf(null), null);
  assert.equal(SC.boardName({ board: "esp32-mcp2515" }), "ESP32 + MCP2515");
  assert.equal(SC.boardName({ fw: "0.1.0" }), "M5Stack NanoH2");
  assert.equal(SC.boardName({ board: "some-new-board" }), "some-new-board");
  assert.equal(SC.boardName(null), "BLE board");
  assert.equal(SC.boardName(null, true), "BLE模块");
  assert.equal(SC.boardListenOnly({ board: "esp32-generic-twai-sniffer" }), true);
  assert.equal(SC.boardListenOnly({ board: "esp32-generic-twai" }), false);
  assert.equal(SC.boardListenOnly(null), false);
});

async function fakeImage({ chip = 0x0010, project = "scrl-ble-board", size = 1024, board = "nanoh2-minican", can = "twai", desc = true } = {}) {
  const b = new Uint8Array(size);
  b[0] = 0xE9; b[1] = 1; b[12] = chip & 0xFF; b[13] = chip >> 8; b[23] = 1;
  const dv = new DataView(b.buffer);
  dv.setUint32(32, 0xABCD5432, true);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(32 + 16, "9.9.9"); put(32 + 48, project); put(32 + 80, "12:00:00"); put(32 + 96, "Jan  1 2026"); put(32 + 112, "v5.5.6");
  if (desc) { dv.setUint32(288, SC.IMG.BOARD_MAGIC, true); dv.setUint32(292, 1, true); put(296, board); put(328, can); }
  b.set(await SC.sha256(b.subarray(0, size - 32)), size - 32);
  return b;
}
await test("image check: a good image passes, each wrong image fails", async () => {
  const good = await fakeImage();
  assert.deepEqual(SC.checkImage(good).errors, []);
  assert.ok(await SC.appendedHashOk(good));
  const flipped = good.slice(); flipped[500] ^= 1;
  assert.ok(!(await SC.appendedHashOk(flipped)));
  assert.match(SC.checkImage(await fakeImage({ chip: 0x000D })).errors.join(), /chip ID/);
  assert.match(SC.checkImage(await fakeImage({ project: "hello_world" })).errors.join(), /hello_world/);
  assert.match(SC.checkImage(await fakeImage({ size: SC.OTA.SLOT_SIZE + 16 })).errors.join(), /app slot/);
  assert.match(SC.checkImage(new Uint8Array(100)).errors.join(), /too small/);
  assert.match(SC.checkImage(await fakeImage({ desc: false })).errors.join(), /no board ID/);
  assert.deepEqual(SC.checkImage(good).info.board, "nanoh2-minican");
});

await test("image check against the connected board: chip, board ID, CAN controller", async () => {
  const t2 = { id: "lilygo-t2can", chip: "esp32s3", can: "twai" };
  const t2img = await fakeImage({ chip: 0x0009, board: "lilygo-t2can" });
  assert.deepEqual(SC.checkImage(t2img, t2).errors, []);
  assert.deepEqual(SC.checkImage(t2img, t2).warnings, []);
  // An H2 image on the T-2CAN: wrong chip.
  assert.match(SC.checkImage(await fakeImage(), t2).errors.join(), /chip ID is 0x10 \(esp32h2\).*needs 0x9 \(esp32s3\)/);
  // Same chip, other board: the firmware refuses it, so the app does not send it.
  const waveshare = await fakeImage({ chip: 0x0009, board: "waveshare-s3-can" });
  assert.match(SC.checkImage(waveshare, t2).errors.join(), /for the board "waveshare-s3-can".*This board is "lilygo-t2can"/);
  // The can1 build on a can0 board: allowed, with a warning about the wires.
  const can1 = SC.checkImage(await fakeImage({ chip: 0x0009, board: "lilygo-t2can", can: "mcp2515" }), t2);
  assert.deepEqual(can1.errors, []);
  assert.match(can1.warnings.join(), /MCP2515.*now uses TWAI.*move the Vehicle CAN wires/);
  // Without a board: any known chip passes, an unknown chip fails.
  assert.deepEqual(SC.checkImage(t2img).errors, []);
  assert.match(SC.checkImage(await fakeImage({ chip: 0x000D })).errors.join(), /No board of this firmware/);
});

// ---------------------------------------------------------------- adapter to the TSL6 pages
const info = { id: "74dafe000001", fw: "0.1.0" };
const defaults = SC.parseSettings(V.default_settings_json);
const flagsOn = SC.FLAG.ENABLED | SC.FLAG.CAN_RUNNING | SC.FLAG.HW4_SEEN | SC.FLAG.ACTIVE;
const statusOf = (settings, flags = flagsOn) => A.h2Status({ info, status: { rx: { all: 5 } }, settings, flags });
// Firmware 0.2.0 settings: no ported features.
const oldDefaults = Object.fromEntries(SC.SETTING_KEYS.map(k => [k, defaults[k]]));
M.h2SetBoardSettings(defaults);

await test("the firmware reports the ported features, and the app knows each one", () => {
  assert.deepEqual(M.H2_FEATURES.map(([id]) => id).filter(id => id in defaults), M.H2_FEATURES.map(([id]) => id),
    "every app feature is in the firmware defaults");
  for (const k of Object.keys(defaults)) assert.ok(SC.SETTING_KEYS.includes(k) || k === "tsl6" || M.h2FeatureMax(k) !== undefined, `app knows ${k}`);
  assert.deepEqual(M.h2Fields(), ["time", "jg", "jj", "lr", "rand"]);
  assert.equal(M.h2Order(), M.H2_ORDER_TSL6);
});

await test("the TSL6 engine (firmware 0.5.0): the factory bytes, the rows and the status bytes", () => {
  assert.equal(defaults.tsl6, M.H2_TSL6_FACTORY, "the firmware factory bytes are the app's");
  assert.ok(M.h2HasTsl6());
  const shown = T.FIELDS.filter(f => T.appliesTo(f, M.H2_TYPE)).map(f => f.id);
  for (const f of T.FIELDS) {
    const want = M.h2Fields().includes(f.id) || (["car", "lab"].includes(f.group) && !M.H2_TSL6_HIDDEN.includes(f.id) && (!f.types || f.types.includes(6)));
    assert.equal(shown.includes(f.id), want, f.id);
  }
  for (const id of ["mianSwitch", "KERS", "stoppingMode", "beep", "led", "automdr"]) assert.ok(!shown.includes(id), `${id} not shown`);
  for (const id of ["fsd", "autoSportMode", "airAutoArid", "steerAssistanceLighting", "pluseHorn"]) assert.ok(shown.includes(id), `${id} shown`);
  // The engine bytes go to status bytes 24-35 and 59-74. The board's own fields keep their bits.
  const bytes = Array.from({ length: 28 }, (_, i) => (i * 37 + 11) & 0xFF);
  const s = { ...defaults, tsl6: bytes.map(b => b.toString(16).padStart(2, "0")).join("") };
  const p = statusOf(s);
  const at = i => (i < 12 ? 24 + i : 59 + i - 12);
  for (let i = 0; i < 28; i++) {
    let keep = 0xFF;
    for (const id of M.h2Fields()) { const f = T.BY_ID[id]; if (f.byte === at(i)) keep &= ~(((1 << f.width) - 1) << f.shift); }
    assert.equal(p[at(i)] & keep, bytes[i] & keep, `byte ${at(i)}`);
  }
  const v = T.decodeSettings(p);
  assert.deepEqual(M.h2Fields().map(id => v[id]), M.h2Fields().map(id => A.h2MenuValues(s)[id]), "board fields from the board settings");
});

await test("an A3 write of a TSL6 engine row sends the 28 bytes; a hidden row is refused", () => {
  const base = statusOf(defaults);
  const set = (id, raw) => T.encodeSettings(base, { [id]: raw }, M.H2_TYPE, id);
  for (const [id, raw] of [["fsd", 1], ["autoSportMode", 3], ["airAutoArid", 2], ["pluseHorn", 1]]) {
    const out = A.h2SettingsWrite(base, set(id, raw));
    assert.deepEqual(Object.keys(out), ["tsl6"], id);
    const after = statusOf({ ...defaults, tsl6: out.tsl6 });
    assert.equal(T.decodeSettings(after)[id], raw, `${id} reads back`);
    assert.ok(T.settingsEchoMatches(set(id, raw), after), `${id}: the echo matches`);
  }
  // fsd = 1 also sets apAutoOpenType = 0 (vendor rule): one write.
  // A board row alone sends no "tsl6".
  assert.deepEqual(Object.keys(A.h2SettingsWrite(base, set("jg", 3))), ["gap_ms"]);
  for (const [id, raw] of [["mianSwitch", 1], ["KERS", 1], ["stoppingMode", 1], ["beep", 5], ["led", 1]]) {
    assert.throws(() => A.h2SettingsWrite(base, set(id, raw)), /not a setting/, id);
  }
});

await test("the firmware takes the tsl6 writes of the app", () => {
  const w = FX.writes.filter(x => JSON.parse(x.write).tsl6);
  assert.ok(w.length >= 6);
  for (const x of w) {
    assert.equal(x.result, 0, x.write);
    assert.equal(SC.parseSettings(JSON.stringify(x.settings)).tsl6, JSON.parse(x.write).tsl6);
  }
  assert.throws(() => SC.parseSettings(JSON.stringify({ ...defaults, tsl6: "00" })), /bad tsl6/);
  assert.throws(() => SC.parseSettings(JSON.stringify({ ...defaults, tsl6: 5 })), /bad tsl6/);
});

await test("a board without ported features (firmware 0.2.0) keeps the old menus", () => {
  M.h2SetBoardSettings(oldDefaults);
  try {
    assert.deepEqual(M.h2Fields(), [...M.H2_FIELDS]);
    assert.equal(M.h2Order(), M.H2_ORDER_OLD);
    assert.throws(() => A.h2SettingChange("lr", 1), /not a setting/);
    const p = statusOf(oldDefaults);
    assert.equal(T.decodeSettings(p).rand, 1, "random times");
    assert.deepEqual(SC.settingsDiff(oldDefaults, A.H2_DEFAULTS), {}, "restore defaults names no feature");
    assert.deepEqual(T.FIELDS.filter(f => T.appliesTo(f, M.H2_TYPE)).map(f => f.id).sort(), [...M.H2_FIELDS].sort());
  } finally {
    M.h2SetBoardSettings(defaults);
  }
});

await test("type filter: the board has exactly its own fields, and no TSL6 type changes", () => {
  // A board without the TSL6 engine (firmware 0.4.x). With the engine, see the TSL6 engine test above.
  const { tsl6, ...noEngine } = defaults;
  M.h2SetBoardSettings(noEngine);
  try {
    assert.ok(!M.h2HasTsl6());
    assert.deepEqual(T.FIELDS.filter(f => T.appliesTo(f, M.H2_TYPE)).map(f => f.id).sort(), M.h2Fields().sort());
  } finally {
    M.h2SetBoardSettings(defaults);
  }
  for (const type of [...T.TSL_TYPES, 9]) {
    for (const f of T.FIELDS) assert.equal(T.appliesTo(f, type), !f.types || f.types.includes(type), `${f.id} for type ${type}`);
    assert.ok(!T.TSL_TYPES.includes(M.H2_TYPE));
  }
  for (const id of M.H2_ROWS) assert.ok(ROW_BY_ID[id], `Car tab row ${id}`);
  // No type list of a Car tab row names the board: the Car tab uses the allow list H2_ROWS for it.
  for (const r of STATUS_ROWS) assert.ok(!r.types || !r.types.includes(M.H2_TYPE), r.id);
});

await test("board menus: each value fits its field, and has an English and a Chinese label", () => {
  for (const id of M.h2Fields()) {
    const f = T.BY_ID[id], max = (1 << f.width) - 1;
    const opts = M.h2Options(id, undefined);
    assert.ok(opts.length >= (M.h2FeatureMax(id) === undefined ? 4 : M.h2FeatureMax(id) + 1), id);
    assert.equal(new Set(opts.map(o => o[0])).size, opts.length, `${id}: no value twice`);
    for (const [v, en, zh] of opts) {
      assert.ok(Number.isInteger(v) && v >= 0 && v <= max, `${id} value ${v} fits ${f.width} bits`);
      assert.ok(en && zh, `${id} ${v} has both labels`);
      assert.notEqual(v, M.H2_CUSTOM, `${id}: the custom mark is not a menu value`);
    }
    assert.equal(opts.filter(o => /\(default\)/.test(o[1])).length, 1, `${id} marks one default`);
    assert.deepEqual(T.optionsFor(f, {}, M.H2_TYPE).map(o => o[0]), opts.map(o => o[0]));
  }
  assert.ok(M.h2Options("time", M.H2_CUSTOM).some(o => o[0] === M.H2_CUSTOM), "a custom value shows as the current value");
  // The timer intervals stay inside the board limits of the firmware.
  const lim = SC.limitsFor({ imax: V.limits.interval_max });
  for (const [, mode, ms] of M.H2_TIME) assert.ok(ms >= lim[mode === 0 ? "delay_ms" : "interval_ms"][0] && ms <= lim[mode === 0 ? "delay_ms" : "interval_ms"][1]);
  for (const [, ms] of M.H2_GAP) assert.ok(ms <= lim.gap_ms[1]);
});

await test("the app limits are the firmware limits, and an old board keeps 10 s", () => {
  const L = V.limits;
  assert.deepEqual(SC.limitsFor({ imax: L.interval_max }).interval_ms, [L.interval_min, L.interval_max]);
  assert.deepEqual([SC.LIMITS.delay_ms[1], SC.LIMITS.gap_ms[1]], [L.delay_max, L.gap_max]);
  assert.equal(SC.intervalMax(null), 10000, "no Info");
  assert.equal(SC.intervalMax({ fw: "0.3.1" }), 10000, "Info without imax");
  assert.equal(SC.intervalMax({ imax: "35000" }), 10000, "imax must be a number");
  assert.equal(SC.intervalMax({ imax: 500 }), 10000, "imax below 10 s is ignored");
  assert.equal(SC.intervalMax({ imax: 35000 }), 35000);
});

await test("the TSL6 timer values 15-35 s need a board that reports a longer interval", () => {
  const long = [5, 6, 7, 8];
  const values = () => M.h2Options("time", undefined).map(o => o[0]);
  try {
    M.h2SetIntervalMax(SC.intervalMax(null));
    assert.ok(long.every(v => !values().includes(v)), "old board: no 15-35 s values");
    assert.equal(A.h2MenuValues({ ...defaults, mode: 1, interval_ms: 32500 }).time, M.H2_CUSTOM, "no Info: a long interval is a custom value");
    for (const v of long) assert.throws(() => A.h2SettingChange("time", v), /no value/);
    M.h2SetIntervalMax(SC.intervalMax({ imax: V.limits.interval_max }));
    assert.ok(long.every(v => values().includes(v)), "new board: 15-35 s values");
    assert.deepEqual(long.map(v => A.h2SettingChange("time", v)),
      [17500, 22500, 27500, 32500].map(ms => ({ mode: 1, interval_ms: ms })));
    const labels = M.h2Options("time", undefined, { rand: 1 }).filter(o => long.includes(o[0])).map(o => o[1]);
    assert.deepEqual(labels, ["Every 14-21 s, while AP is active", "Every 18-27 s, while AP is active",
      "Every 22-33 s, while AP is active", "Every 26-39 s, while AP is active"]);
    assert.equal(A.h2MenuValues({ ...defaults, mode: 1, interval_ms: 32500 }).time, 8);
  } finally {
    M.h2SetIntervalMax(SC.intervalMax(null));
  }
});

await test("the status in the TSL6 layout passes the checks of the TSL6 pages", () => {
  const p = statusOf({ ...defaults, enabled: true });
  assert.equal(p.length, 76);
  assert.equal(T.writeBlocker(p), null, "the Settings page can write");
  const live = decodeLiveState(p, M.H2_TYPE);
  assert.ok(live.runtimeOk && !live.blank, "not blank: no password prompt");
  assert.equal(live.assistActive, true);
  assert.equal(live.toggles.apAssist, true);
  assert.deepEqual(live.can, [true, false, false]);
  assert.equal(meInfo(p).mac, "74:DA:FE:00:00:01");
  const v = T.decodeSettings(p);
  assert.deepEqual([v.time, v.jg, v.jj, v.mianSwitch], [0, 1, 1, 0], "defaults: prompt 0.6 s, gap 0.1 s, down then up, module on");
  const off = decodeLiveState(statusOf(defaults, 0), M.H2_TYPE);
  assert.equal(off.assistActive, false);
  assert.deepEqual(off.can, [false, false, false]);
  // Every bit outside the board fields, the live bytes and the fixed marks is the TSL6 engine factory value
  // (bytes 24-35 and 59-74), else 0.
  const z = Uint8Array.from(statusOf(defaults, 0));
  const want = new Uint8Array(76);
  fromHex(M.H2_TSL6_FACTORY).forEach((b, i) => { want[i < 12 ? 24 + i : 59 + i - 12] = b; });
  for (const id of M.h2Fields()) {
    const f = T.BY_ID[id], m = ~(((1 << f.width) - 1) << f.shift);
    z[f.byte] &= m; want[f.byte] &= m;
  }
  for (let i = 24; i < 36; i++) assert.equal(z[i], want[i], `settings byte ${i}`);
  for (let i = 40; i < 76; i++) assert.equal(z[i], want[i], `byte ${i}`);
});

// One save as the Settings page does it: encode, translate, let the board apply it, read back, compare the echo.
function save(settings, id, raw) {
  const base = statusOf(settings);
  const payload = T.encodeSettings(base, { [id]: raw }, M.H2_TYPE, id);
  assert.equal(T.writeBlocker(payload), null);
  const change = A.h2SettingsWrite(base, payload);
  const next = { ...settings, ...change };
  assert.ok(T.settingsEchoMatches(payload, statusOf(next)), `echo after ${id}=${raw}`);
  return { change, next };
}
await test("a save from the Settings page changes exactly one board setting, for each menu value", () => {
  // A board with the firmware limits: the 15-35 s timer values are in the menu too.
  M.h2SetIntervalMax(SC.intervalMax({ imax: V.limits.interval_max }));
  assert.equal(M.h2Times().length, M.H2_TIME.length);
  try { saveEachValue(); } finally { M.h2SetIntervalMax(SC.intervalMax(null)); }
});
function saveEachValue() {
  for (const start of [defaults, { ...defaults, enabled: true, op_mode: 1, mode: 1, interval_ms: 7500, gap_ms: 2000, pattern: 3 }]) {
    for (const [v, mode, ms] of M.h2Times()) {
      const cur = A.h2MenuValues(start).time;
      const { change, next } = save(start, "time", v);
      assert.deepEqual(change, v === cur ? {} : (mode === 0 ? { mode: 0, delay_ms: ms } : { mode: 1, interval_ms: ms }));
      assert.equal(A.h2MenuValues(next).time, v);
    }
    for (const [v, ms] of M.H2_GAP) {
      const { change } = save(start, "jg", v);
      assert.deepEqual(change, v === A.h2MenuValues(start).jg ? {} : { gap_ms: ms });
    }
    for (const [v, pattern] of M.h2Order()) {
      const { change } = save(start, "jj", v);
      assert.deepEqual(change, v === A.h2MenuValues(start).jj ? {} : { pattern });
    }
    for (const [id, max] of M.H2_FEATURES) {
      for (let v = 0; v <= max; v++) {
        const { change, next } = save(start, id, v);
        assert.deepEqual(change, v === start[id] ? {} : { [id]: v });
        assert.equal(A.h2MenuValues(next)[id], v);
      }
      assert.throws(() => A.h2SettingChange(id, max + 1), /no value/);
    }
  }
}

await test("the timer labels follow the random-interval setting", () => {
  const timer = opts => opts.filter(([v]) => M.H2_TIME.find(e => e[0] === v)[1] === 1).map(o => o[1]);
  assert.ok(timer(M.h2Options("time", 1, { rand: 1 })).every(t => /\d-\d/.test(t)), "ranges with rand 1");
  assert.ok(timer(M.h2Options("time", 1, { rand: 0 })).every(t => !/\d-\d/.test(t)), "exact with rand 0");
  assert.deepEqual(M.h2Order().map(([v, p]) => [v, M.h2Options("jj", v).find(o => o[0] === v)[1]]),
    [[1, "Down, then up (default)"], [0, "Up, then down"], [2, "Alternate"], [3, "Random"]]);
});

await test("board values that no menu holds stay when another field is saved", () => {
  const custom = { ...defaults, mode: 0, delay_ms: 700, gap_ms: 137, interval_ms: 3333 };
  assert.deepEqual(A.h2MenuValues(custom), { time: M.H2_CUSTOM, jg: M.H2_CUSTOM, jj: 1, lr: 0, rand: 1 });
  const { change, next } = save(custom, "jj", 0);
  assert.deepEqual(change, { pattern: 1 });
  assert.deepEqual([next.delay_ms, next.gap_ms, next.interval_ms], [700, 137, 3333]);
  // The custom mark cannot be written: it is not a board value.
  assert.throws(() => A.h2SettingChange("time", M.H2_CUSTOM));
  assert.throws(() => A.h2SettingChange("jg", M.H2_CUSTOM));
  // Timer mode with a prompt delay that a menu holds: the mode decides.
  assert.equal(A.h2MenuValues({ ...defaults, mode: 1, interval_ms: 2500, delay_ms: 600 }).time, 1);
});

await test("the adapter refuses each change that the board does not have", () => {
  const base = statusOf(defaults);
  for (const f of T.FIELDS) {
    if (M.h2Fields().includes(f.id) || M.h2Tsl6Field(f) || f.layout76 === false) continue; // the TSL6 engine rows: see above
    const cur = (base[f.byte] >> f.shift) & ((1 << f.width) - 1);
    const payload = T.encodeSettings(base, { [f.id]: cur ^ 1 }, 6, f.id);
    if (payload.every((v, i) => v === base[i] || (i >= 18 && i < 24))) continue; // a rule of the codec undid the change
    assert.throws(() => A.h2SettingsWrite(base, payload), /not a setting of the board/, f.id);
  }
  const wrongLen = base.slice(0, 60);
  assert.throws(() => A.h2SettingsWrite(base, wrongLen), /length/);
  // A change of the password bytes or the ID is refused too.
  const pw = Uint8Array.from(base); pw[36] = 0x31;
  assert.throws(() => A.h2SettingsWrite(base, pw));
});

await test("restore defaults writes the board defaults: Scroll Ack off, Listen-Only", () => {
  assert.deepEqual(A.H2_DEFAULTS, defaults);
  const fx = FX.writes.find(w => w.write === JSON.stringify(A.H2_DEFAULTS) && JSON.parse(w.current).op_mode === 1);
  assert.deepEqual(fx.settings, defaults);
});

await test("the live prompt line has the shape of the TSL6 prompt build", () => {
  const F = SC.FLAG.HW4_SEEN;
  const live = (phase, handsOn, apState, sent = 5) => ({ phase, handsOn, apState, sent });
  assert.deepEqual(Object.keys(A.h2PromptDiag(live(0, 1, 6), F)).sort(), [...Object.keys(promptDiag(1)).filter(k => k !== "raw")].sort());
  assert.equal(A.h2PromptDiag(null, F).noData, true);
  assert.equal(A.h2PromptDiag(live(0, 1, 6), 0).noData, true, "no 0x39B frame yet");
  assert.equal(A.h2PromptDiag(live(0, 1, 6), F).phase, 0);
  assert.equal(A.h2PromptDiag(live(1, 3, 6), F).phase, 1);
  assert.equal(A.h2PromptDiag(live(2, 3, 6), F).phase, 2);
  assert.equal(A.h2PromptDiag(live(3, 3, 6), F).phase, 2);
  assert.equal(A.h2PromptDiag(live(0, 3, 2), F).phase, 3, "prompt seen, AP not active");
  assert.equal(A.h2PromptDiag(live(0, 0, 0, 1284), F).sent, 1284, "the full count, and AP state 0 is not 'no data'");
  assert.equal(A.h2PromptDiag(live(0, 0, 0, 0), F).noData, false);
});

// ---------------------------------------------------------------- capture (firmware 0.4.0)
await test("capture packets: the codec reads what the firmware packers make", () => {
  const C = V.capture;
  assert.ok(C, "no capture vectors: run tools/scrl-fixture.mjs");
  assert.deepEqual([C.modes.plan, C.modes.all, C.modes.list, C.list_max], [CP.CAP.MODE_PLAN, CP.CAP.MODE_ALL, CP.CAP.MODE_LIST, CP.CAP.LIST_MAX]);
  assert.deepEqual([FX.cmd.CAPTURE_START, FX.cmd.CAPTURE_STOP, FX.cmd.CAPTURE_MARK], [7, 8, 9], "the codec command bytes");
  assert.ok(SC.OPTIONAL.includes("capture") && SC.UUIDS.capture, "Capture is an optional characteristic");
  const fr = fromHex(C.frames_hex);
  assert.ok(fr.length <= C.mtu - 3, "a packet fits the MTU");
  const p = CP.parseCapturePacket(fr);
  assert.deepEqual([p.type, p.count, p.seq, p.ringLost], [CP.CAP.FRAMES, 2, 0, 0]);
  assert.deepEqual(CP.packetFrames(fr), [[100, 0x3C2, 8, false, "0102030405060708"], [150, 0x118, 4, false, "A0B1C2D3"]],
    "only the plan IDs stream; the extended frame and 0x155 do not");
  const ids = CP.parseCapturePacket(fromHex(C.ids_hex));
  assert.deepEqual(ids.ids.map(e => [e.id, e.frames, e.firstMs, e.lastMs, e.dlc, e.data]),
    [[0x3C2, 1, 100, 100, 8, "0102030405060708"], [0x155, 1, 120, 120, 8, "0102030405060708"], [0x118, 1, 150, 150, 4, "A0B1C2D3"]]);
  assert.equal(ids.seq, 1);
  assert.deepEqual(CP.parseCapturePacket(fromHex(C.mark_hex)).mark, { t: 777, step: 3 });
  assert.deepEqual(CP.parseCapturePacket(fromHex(C.state_hex)).state,
    { t: 1000, running: true, mode: 0, ids: 3, rxAll: 4, rxQueueLost: 5, ext: 1 });
  assert.throws(() => CP.parseCapturePacket(fr.subarray(0, fr.length - 1)), /bytes/);
  assert.throws(() => CP.parseCapturePacket(Uint8Array.of(9, 0, 0, 0, 0, 0, 0, 0)), /type 9/);
});

await test("capture commands", () => {
  assert.deepEqual([...CP.captureStartCommand(CP.CAP.MODE_PLAN)], [7, 0]);
  assert.deepEqual([...CP.captureStartCommand(CP.CAP.MODE_ALL)], [7, 1]);
  assert.deepEqual([...CP.captureStartCommand(CP.CAP.MODE_LIST, [0x3C2, 0x118])], [7, 2, 0xC2, 0x03, 0x18, 0x01]);
  assert.throws(() => CP.captureStartCommand(CP.CAP.MODE_PLAN, [1]));
  assert.throws(() => CP.captureStartCommand(CP.CAP.MODE_LIST, []));
  assert.throws(() => CP.captureStartCommand(CP.CAP.MODE_LIST, [0x800]));
  assert.throws(() => CP.captureStartCommand(3));
  assert.deepEqual([...CP.captureStopCommand()], [8]);
  assert.deepEqual([...CP.captureMarkCommand(21)], [9, 21]);
  assert.throws(() => CP.captureMarkCommand(256));
});

await test("capture recorder: the file has the frames, the marks, the gaps and the ID table", () => {
  const C = V.capture, fr = fromHex(C.frames_hex);
  const rec = new CP.CaptureRecorder({ board: "M5Stack NanoH2", fw: "0.4.0", mode: 0 });
  const state = (seq, qlost) => { const b = fromHex(C.state_hex); b[2] = seq; b[20] = qlost; return b; };
  rec.add(state(0, 5));
  const f1 = fr.slice(); f1[2] = 1; rec.add(f1);
  rec.add(fromHex(C.mark_hex).map((v, i) => (i === 2 ? 2 : v)));     // seq 2, step 3 at 777 ms
  const f2 = fr.slice(); f2[2] = 5; f2[4] = 3;                         // seq 5: 2 packets missing, ring_lost 3
  for (const o of [8, 24]) { f2[o] = 0x10; f2[o + 1] = 0x03; }         // t = 784 ms
  f2[8 + 7] = 1;                                                       // the first record says "lost before me"
  rec.add(f2);
  rec.add(fromHex(C.ids_hex).map((v, i) => (i === 2 ? 6 : v)));
  rec.add(state(7, 9));
  assert.equal(rec.frames, 4);
  assert.equal(rec.packetsMissing, 2);
  assert.equal(rec.ringLost, 3);
  assert.equal(rec.flaggedLost, 1);
  assert.equal(rec.queueLost, 4, "queue loss during this capture only");
  assert.equal(rec.seconds, 0.684);
  const text = rec.toText(n => (n === 3 ? "Left stalk" : ""));
  const lines = text.trim().split("\n");
  assert.match(lines[0], /^# BLE board capture, \d{4}-/);
  assert.match(lines[2], /frames 4, lost in the board ring 3, lost in the CAN queue 4, packets missing 2/);
  const body = lines.slice(3); // after the 3 head lines
  assert.deepEqual(body.slice(0, 8), [
    "(0.100) can0 3C2#0102030405060708",
    "(0.150) can0 118#A0B1C2D3",
    "# step 3 at 0.777: Left stalk",
    "# gap: 2 packet(s) missing here",
    "# frames lost in the board ring before the next frame",
    "(0.784) can0 3C2#0102030405060708",
    "(0.784) can0 118#A0B1C2D3",
    "# ID table: id, frames, period ms, dlc, last data",
  ]);
  assert.ok(lines.includes("# id 155 1 0.0 8 0102030405060708"));
  assert.deepEqual(rec.idTable().map(e => e.id), [0x118, 0x155, 0x3C2], "equal counts sort by ID");
});

await test("capture recorder: a packet that comes two times counts once (seen on a real phone)", () => {
  const C = V.capture, fr = fromHex(C.frames_hex), mk = fromHex(C.mark_hex).map((v, i) => (i === 2 ? 1 : v));
  const rec = new CP.CaptureRecorder({});
  assert.ok(rec.add(fr));
  assert.equal(rec.add(fr.slice()), null, "the repeat is dropped");
  assert.ok(rec.add(mk));
  assert.equal(rec.add(mk.slice()), null);
  const again = fr.slice(); again[2] = 2;                       // same frames, next seq: a new packet
  assert.ok(rec.add(again));
  assert.deepEqual([rec.frames, rec.duplicates, rec.packetsMissing, rec.marks.length], [4, 2, 0, 1]);
  assert.match(rec.toText(), /packets missing 0, duplicate packets dropped 2/);
  assert.equal((rec.toText().match(/^# step 3 /gm) || []).length, 1);
});

console.log(`\nall ${n} tests passed`);
