// Tests for the H2 board support: the board codec (public/lib/scrl.js), the adapter to the TSL6 pages
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
  const writes = boardWrites(V.default_settings_json);
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
  for (const [v] of M.H2_TIME) assert.ok(!("op_mode" in A.h2SettingChange("time", v)));
  for (const [v] of M.H2_GAP) assert.ok(!("op_mode" in A.h2SettingChange("jg", v)));
  for (const [v] of M.H2_ORDER) assert.ok(!("op_mode" in A.h2SettingChange("jj", v)));
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
});

async function fakeImage({ chip = 0x0010, project = "scrl-ble-board", size = 1024 } = {}) {
  const b = new Uint8Array(size);
  b[0] = 0xE9; b[1] = 1; b[12] = chip & 0xFF; b[13] = chip >> 8; b[23] = 1;
  new DataView(b.buffer).setUint32(32, 0xABCD5432, true);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
  put(32 + 16, "9.9.9"); put(32 + 48, project); put(32 + 80, "12:00:00"); put(32 + 96, "Jan  1 2026"); put(32 + 112, "v5.5.6");
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
});

// ---------------------------------------------------------------- adapter to the TSL6 pages
const info = { id: "74dafe000001", fw: "0.1.0" };
const defaults = SC.parseSettings(V.default_settings_json);
const flagsOn = SC.FLAG.ENABLED | SC.FLAG.CAN_RUNNING | SC.FLAG.HW4_SEEN | SC.FLAG.ACTIVE;
const statusOf = (settings, flags = flagsOn) => A.h2Status({ info, status: { rx: { all: 5 } }, settings, flags });

await test("type filter: the board has exactly its own fields, and no TSL6 type changes", () => {
  assert.deepEqual(T.FIELDS.filter(f => T.appliesTo(f, M.H2_TYPE)).map(f => f.id).sort(), [...M.H2_FIELDS].sort());
  for (const type of [...T.TSL_TYPES, 9]) {
    for (const f of T.FIELDS) assert.equal(T.appliesTo(f, type), !f.types || f.types.includes(type), `${f.id} for type ${type}`);
    assert.ok(!T.TSL_TYPES.includes(M.H2_TYPE));
  }
  for (const id of M.H2_ROWS) assert.ok(ROW_BY_ID[id], `Car tab row ${id}`);
  // No type list of a Car tab row names the board: the Car tab uses the allow list H2_ROWS for it.
  for (const r of STATUS_ROWS) assert.ok(!r.types || !r.types.includes(M.H2_TYPE), r.id);
});

await test("board menus: each value fits its field, and has an English and a Chinese label", () => {
  for (const id of M.H2_FIELDS) {
    const f = T.BY_ID[id], max = (1 << f.width) - 1;
    const opts = M.h2Options(id, undefined);
    assert.ok(opts.length >= 4, id);
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
  // The timer intervals stay inside the board limits.
  for (const [, mode, ms] of M.H2_TIME) assert.ok(ms >= SC.LIMITS[mode === 0 ? "delay_ms" : "interval_ms"][0] && ms <= SC.LIMITS[mode === 0 ? "delay_ms" : "interval_ms"][1]);
  for (const [, ms] of M.H2_GAP) assert.ok(ms <= SC.LIMITS.gap_ms[1]);
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
  // Every bit outside the board fields, the live bytes and the fixed marks is 0.
  const z = Uint8Array.from(statusOf(defaults, 0));
  for (const id of M.H2_FIELDS) { const f = T.BY_ID[id]; z[f.byte] &= ~(((1 << f.width) - 1) << f.shift); }
  z[T.BY_ID.rand.byte] &= ~(1 << T.BY_ID.rand.shift);
  for (let i = 24; i < 36; i++) assert.equal(z[i], 0, `settings byte ${i}`);
  for (let i = 40; i < 76; i++) assert.equal(z[i], 0, `byte ${i}`);
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
  for (const start of [defaults, { ...defaults, enabled: true, op_mode: 1, mode: 1, interval_ms: 7500, gap_ms: 2000, pattern: 3 }]) {
    for (const [v, mode, ms] of M.H2_TIME) {
      const cur = A.h2MenuValues(start).time;
      const { change, next } = save(start, "time", v);
      assert.deepEqual(change, v === cur ? {} : (mode === 0 ? { mode: 0, delay_ms: ms } : { mode: 1, interval_ms: ms }));
      assert.equal(A.h2MenuValues(next).time, v);
    }
    for (const [v, ms] of M.H2_GAP) {
      const { change } = save(start, "jg", v);
      assert.deepEqual(change, v === A.h2MenuValues(start).jg ? {} : { gap_ms: ms });
    }
    for (const [v, pattern] of M.H2_ORDER) {
      const { change } = save(start, "jj", v);
      assert.deepEqual(change, v === A.h2MenuValues(start).jj ? {} : { pattern });
    }
  }
});

await test("board values that no menu holds stay when another field is saved", () => {
  const custom = { ...defaults, mode: 0, delay_ms: 700, gap_ms: 137, interval_ms: 3333 };
  assert.deepEqual(A.h2MenuValues(custom), { time: M.H2_CUSTOM, jg: M.H2_CUSTOM, jj: 1 });
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
    if (M.H2_FIELDS.includes(f.id) || f.layout76 === false) continue;
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

console.log(`\nall ${n} tests passed`);
