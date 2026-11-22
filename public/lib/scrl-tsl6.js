// Adapter between the H2 board and the TSL6 pages of this app.
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
//
// The Car and Settings pages read a TSL6 status payload and send TSL6 commands. For the board, this file
//   - builds a status payload in the TSL6 layout from the board's Info, Status and Settings,
//   - turns an A3 settings write into the board settings that it changes,
//   - gives the live prompt state in the shape that the Car tab draws.
// Only the board fields (h2Fields()) and the rows in H2_ROWS mean something. Every other bit is 0.
// A command or a change that the board does not have is refused: the adapter fails closed.

import { H2_GAP, H2_CUSTOM, h2Order, h2Fields, h2Has, h2FeatureMax, h2Times, H2_FEATURES, h2HasTsl6, h2HasEngine, h2Tsl6Field, H2_TSL6_FACTORY } from "./h2-menus.js";
import { BY_ID, FIELDS, decodeSettings } from "./tsl6-settings.js";
import { FLAG } from "./scrl.js";

export const H2_STATUS_LEN = 76;
// Bytes 36-39 hold the BLE password on a TSL6. A blank status (bytes 18-39 = 0) means "password needed", and an A3
// write needs printable bytes there. The board has no password (the phone pairs), so the bytes hold a fixed mark.
const MARK = [0x48, 0x32, 0x2d, 0x2d]; // "H2--"

const hexBytes = s => (String(s || "").match(/[0-9a-f]{2}/gi) || []).map(x => parseInt(x, 16));
const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
// Status bytes of the 28 "tsl6" bytes: 24-35, then 59-74.
const TSL6_AT = [...Array(12).keys()].map(i => 24 + i).concat([...Array(16).keys()].map(i => 59 + i));
// The TSL6 fields that the board's engine takes (none without "tsl6").
const tsl6Fields = () => FIELDS.filter(f => !h2Fields().includes(f.id) && h2Tsl6Field(f));
const fieldMask = f => (((1 << f.width) - 1) << f.shift) & 0xFF;

// Menu value of each board field, or H2_CUSTOM when no menu entry holds the board value.
export function h2MenuValues(settings) {
  const ms = settings.mode === 0 ? settings.delay_ms : settings.interval_ms;
  const t = h2Times().find(([, mode, v]) => mode === settings.mode && v === ms);
  const g = H2_GAP.find(([, v]) => v === settings.gap_ms);
  const o = h2Order().find(([, pattern]) => pattern === settings.pattern);
  const out = { time: t ? t[0] : H2_CUSTOM, jg: g ? g[0] : H2_CUSTOM, jj: o ? o[0] : 1 };
  // Ported features: the board value is the TSL6 value.
  for (const [id] of H2_FEATURES) if (h2Has(id)) out[id] = settings[id];
  return out;
}

// Board settings that one menu value changes. Throws for a value that the board menu does not have.
export function h2SettingChange(id, raw) {
  if (id === "time") {
    const e = h2Times().find(([v]) => v === raw);
    if (!e) throw new Error(`time: the board has no value ${raw}`);
    return e[1] === 0 ? { mode: 0, delay_ms: e[2] } : { mode: 1, interval_ms: e[2] };
  }
  if (id === "jg") {
    const e = H2_GAP.find(([v]) => v === raw);
    if (!e) throw new Error(`jg: the board has no value ${raw}`);
    return { gap_ms: e[1] };
  }
  if (id === "jj") {
    const e = h2Order().find(([v]) => v === raw);
    if (!e) throw new Error(`jj: the board has no value ${raw}`);
    return { pattern: e[1] };
  }
  const max = h2FeatureMax(id);
  if (max !== undefined && h2Has(id)) {
    if (!Number.isInteger(raw) || raw < 0 || raw > max) throw new Error(`${id}: the board has no value ${raw}`);
    return { [id]: raw };
  }
  throw new Error(`${id}: not a setting of the board`);
}

// A status payload in the TSL6 layout. info = the board's Info JSON, status = parseStatus() result,
// settings = parseSettings() result, flags = the merged 16 flag bits.
export function h2Status({ info, status, settings, flags }) {
  const u = new Uint8Array(H2_STATUS_LEN);
  u[3] = 1; // "runtime running"
  // Bytes 4-17 are the UID14 of a TSL6. The Device tab shows 4-15 as the ID and 12-17 (reversed) as the MAC.
  u.set([0x53, 0x43, 0x52, 0x4c, 0x2d, 0x48, 0x32, 0x00], 4); // "SCRL-H2"
  const mac = hexBytes(info && info.id);
  if (mac.length === 6) u.set(mac.slice().reverse(), 12);
  // Live state. Bit 0 of byte 19 is "AP assist active": Scroll Ack is on.
  if (flags & FLAG.ENABLED) u[19] |= 1;
  // Bit 0 of byte 23 is "CAN1 connected": the controller runs and frames arrive.
  if ((flags & FLAG.CAN_RUNNING) && status && status.rx.all > 0) u[23] |= 1;
  // Settings. With the TSL6 engine, its bytes first; the board's own fields then replace their bits.
  if (h2HasTsl6()) hexBytes(settings.tsl6).forEach((b, i) => { u[TSL6_AT[i]] = b; });
  const m = h2MenuValues(settings);
  for (const id of h2Fields()) {
    const f = BY_ID[id];
    u[f.byte] = (u[f.byte] & ~fieldMask(f)) | ((m[id] << f.shift) & fieldMask(f));
  }
  // A board without "rand" (firmware 0.2.0) always uses random times.
  if (!h2Has("rand")) u[BY_ID.rand.byte] |= 1 << BY_ID.rand.shift;
  u.set(MARK, 36);
  return u;
}

// Status of a board with the engine link (firmware 0.6.0): the A0 status of its TSL6 engine, with the board's own
// fields on top. The engine has the TSL6 layout already (UID14 = "SCRL-H2" and the MAC, live state, settings). The
// board adds the settings that its Scroll Ack keeps (time, jg, jj, lr, rand) and "AP assist active" (byte 19 bit 0):
// the board sends the ticks, the TSL6 tick of the engine stays off.
export function h2EngineStatus(engine, { settings, flags }) {
  const u = new Uint8Array(H2_STATUS_LEN);
  u.set(engine.subarray(0, Math.min(engine.length, H2_STATUS_LEN)));
  const m = h2MenuValues(settings);
  for (const id of h2Fields()) {
    const f = BY_ID[id];
    u[f.byte] = (u[f.byte] & ~fieldMask(f)) | ((m[id] << f.shift) & fieldMask(f));
  }
  if (!h2Has("rand")) u[BY_ID.rand.byte] |= 1 << BY_ID.rand.shift;
  u[19] = (u[19] & ~1) | (flags & FLAG.ENABLED ? 1 : 0);
  return u;
}

// The board settings that an A3 write changes on a board with the engine link: only the board's own fields. The
// whole write also goes to the engine, which takes every bit as a TSL6 does.
export function h2BoardFieldsWrite(base, payload) {
  if (payload.length !== H2_STATUS_LEN || base.length !== H2_STATUS_LEN) throw new Error("settings write: wrong length");
  const before = decodeSettings(base), after = decodeSettings(payload);
  const out = {};
  for (const id of h2Fields()) if (before[id] !== after[id]) Object.assign(out, h2SettingChange(id, after[id]));
  return out;
}

// What an A3 write changes on the board. base = the status that the page built the write from.
// Returns the board settings to write ({} = nothing). Throws when the write changes a bit that the board does not
// have: the board must never get a change that the page did not show.
export function h2SettingsWrite(base, payload) {
  if (payload.length !== H2_STATUS_LEN || base.length !== H2_STATUS_LEN) throw new Error("settings write: wrong length");
  const before = decodeSettings(base), after = decodeSettings(payload);
  const out = {};
  const fields = h2Fields();
  for (const id of fields) {
    if (before[id] === after[id]) continue;
    Object.assign(out, h2SettingChange(id, after[id]));
  }
  // TSL6 engine fields: the board takes the 28 bytes as they are. The bits of the board's own fields go with them
  // (the engine does not send ticks), and every bit that the page does not show keeps its board value.
  const engine = tsl6Fields();
  if (engine.some(f => before[f.id] !== after[f.id])) out.tsl6 = toHex(TSL6_AT.map(i => payload[i]));
  // Compare the bytes with the allowed fields masked out. Bytes 18-23 are live state: the page sets them to 0.
  const strip = p => {
    const u = Uint8Array.from(p);
    for (let i = 18; i < 24; i++) u[i] = 0;
    for (const f of [...fields.map(id => BY_ID[id]), ...engine]) u[f.byte] &= ~fieldMask(f);
    return u;
  };
  const a = strip(base), b = strip(payload);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`settings write: byte ${i} is not a setting of the board`);
  return out;
}

// Board defaults for "Restore defaults": Scroll Ack off and Listen-Only, as after a factory reset. The bonds and
// the passkey stay. settingsDiff() writes a ported feature only when the board has it.
export const H2_DEFAULTS = Object.freeze({ enabled: false, mode: 0, pattern: 0, delay_ms: 600, gap_ms: 100, interval_ms: 2500, op_mode: 0,
  lr: 0, rand: 1, tsl6: H2_TSL6_FACTORY });

// Live prompt state for the Car tab, in the shape of promptDiag() in lib/tsl6-gauge.js (the TSL6 prompt build
// sends it in the gauge stream). The board sends it in its Live record, so the page needs no gauge stream.
// live = parseLive() result, flags = the merged flag bits. Phase: see PROMPT_PHASE in lib/tsl6-gauge.js.
export function h2PromptDiag(live, flags) {
  if (!live || !(flags & FLAG.HW4_SEEN)) return { phase: 0, handsOn: 0, apState: 0, sent: 0, noData: true }; // no 0x39B frame yet
  const prompt = live.handsOn === 3;
  // Board phases: 0 Armed, 1 Delay, 2 SecondPending, 3 EpisodeDone.
  let phase = 0;
  if (prompt && live.apState !== 6) phase = 3;              // prompt seen, but AP is not active
  else if (live.phase === 1) phase = 1;                     // prompt seen, the tick comes soon
  else if (live.phase === 2 || live.phase === 3) phase = 2; // ticks sent, wait for the prompt to clear
  return { phase, handsOn: live.handsOn, apState: live.apState, sent: live.sent, noData: false };
}
