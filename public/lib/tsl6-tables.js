// TSL6 table codec: shortcut table (AB), BLE button table (BA), "try" command (BB),
// the vendor write check (re-send on a wrong echo) and a local backup file.
// Layouts come from the vendor Mini App pages btn, blebtn and backup, and from
// the runtime V1.0.00 disassembly (public/runtime.bin).
// Pure functions: no BLE, no DOM. Works in the browser and in Node.

import { hex, settingsEchoMatches } from "./tsl6-settings.js";

export const CMD = { STATUS: 0xa0, SETTINGS: 0xa3, SHORTCUTS: 0xab, BLE_BUTTONS: 0xba, TRY: 0xbb, FAIL: 0xbd };

export const TABLE_LEN = 256;
// The runtime accepts an AB or BA write only if the payload has 256 bytes and byte 255 is 0x5A.
// A 256-byte write with another byte 255 gets the reply BD 00 ("operation failed").
// A write with another length gets no reply.
export const MAGIC_OFFSET = 255;
export const MAGIC = 0x5a;

export const SHORTCUT_SLOTS = 127; // bytes 0-253, one (trigger, action) pair per 2 bytes
export const BLE_SLOTS = 42;       // bytes 0-251, 6 bytes per button
export const BLE_ENTRY_LEN = 6;

// Requests. The module replies with the 256-byte table.
export const READ_TABLE = Uint8Array.of(0x02); // AB 02 and BA 02
// BA 01 starts BLE button pairing. The module echoes BA 01, then sends BA with 6 bytes
// when a button is pressed (see parseBleNotify).
export const BLE_PAIR_START = Uint8Array.of(0x01);

// Factory shortcut table of runtime V1.0.00 (function at 0x12A9C), as (trigger, action) pairs.
// The ids are numbers only. Their names come from the vendor function list (not in this repo).
export const FACTORY_SHORTCUTS = [
  [0x02, 0x14], [0x43, 0x0b], [0x44, 0x0c], [0x45, 0x0d], [0x0a, 0x2c], [0x0c, 0x2b], [0x0e, 0x46],
  [0x10, 0x05], [0x11, 0x07], [0x1e, 0x50], [0x1f, 0x5f], [0x20, 0x1e], [0x21, 0x2a],
];

// Action ids that the runtime V1.0.00 action dispatcher (0x1516E, jump table 0x19710) handles.
// Other ids do nothing. 0 means "no action".
const ACTION_RANGES = [[1, 37], [40, 75], [78, 102], [104, 120], [122, 156], [159, 160], [170, 175],
  [178, 192], [200, 209], [225, 245], [247, 253]];
export function isRuntimeAction(id) {
  return ACTION_RANGES.some(([a, b]) => id >= a && id <= b);
}

// Default labels of the vendor pages (shown when the function list has no entry).
export const LABELS = {
  triggerNone: { en: "Select a trigger", zh: "请选择快捷指令" },
  actionNone: { en: "No action (default)", zh: "无操作(默认)" },
  bleButton: { en: "BLE button", zh: "蓝牙按钮" },
  pressNone: { en: "No action", zh: "无操作" },
  click: { en: "Single click", zh: "单击" },
  dblClick: { en: "Double click", zh: "双击" },
};

// ---------------------------------------------------------------- helpers

function bytes(p) {
  return p instanceof Uint8Array ? p : Uint8Array.from(p);
}

function checkByte(name, v) {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${name}: ${v} is not a byte (0..255)`);
}

export function parseHex(s) {
  const clean = String(s).replace(/[\s:,-]/g, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("bad hex string");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

// A new empty table: all 0, magic byte set.
export function emptyTable() {
  const t = new Uint8Array(TABLE_LEN);
  t[MAGIC_OFFSET] = MAGIC;
  return t;
}

// Reason why the runtime would reject this table as an AB or BA write, or null.
export function tableWriteBlocker(t) {
  if (!t || t.length !== TABLE_LEN) return `the module accepts only ${TABLE_LEN}-byte tables (this one has ${t ? t.length : 0})`;
  if (t[MAGIC_OFFSET] !== MAGIC) return `byte ${MAGIC_OFFSET} must be 0x5A (it is 0x${hex([t[MAGIC_OFFSET]])})`;
  return null;
}

// ---------------------------------------------------------------- AB shortcut table

// Table layout: byte 2n = trigger id, byte 2n+1 = action id, n = 0..126.
// A slot with trigger 0 is empty. Byte 254 is not used (kept). Byte 255 = 0x5A.
// The runtime runs every slot whose trigger matches, in slot order. So one trigger can run many actions.
export function decodeShortcuts(table) {
  const t = bytes(table);
  const out = [];
  for (let i = 0; i + 2 < t.length && i < SHORTCUT_SLOTS * 2; i += 2) {
    if (t[i] !== 0) out.push({ slot: i / 2, trigger: t[i], action: t[i + 1] });
  }
  return out;
}

// Build the AB write payload. entries = [{trigger, action}] in screen order.
// Like the vendor: entries fill slots 0.. in order, the other slots become 0,
// bytes 254-255 are copied from `base` (the last table that the module sent).
export function encodeShortcuts(base, entries) {
  const t = base ? Uint8Array.from(base) : emptyTable();
  if (t.length !== TABLE_LEN) throw new Error(`base table must have ${TABLE_LEN} bytes`);
  if (entries.length > SHORTCUT_SLOTS) throw new Error(`at most ${SHORTCUT_SLOTS} shortcuts`);
  for (let n = 0; n < SHORTCUT_SLOTS; n++) {
    const e = entries[n];
    const trig = e ? e.trigger : 0, act = e ? e.action : 0;
    checkByte("trigger", trig);
    checkByte("action", act);
    t[2 * n] = trig;
    t[2 * n + 1] = act;
  }
  return t;
}

// ---------------------------------------------------------------- BA BLE button table

// Entry layout (6 bytes): [click action, double-click action, id0, id1, id2, id3].
// id0..id3 are the button radio id, in the byte order that the module sends.
// An entry with id 0 is empty. Bytes 252-254 are not used (kept). Byte 255 = 0x5A.
// The vendor app shows the id as a signed 32-bit number, big-endian (id0 is the high byte).
// It uses "id" + that number as the key for names and battery in its local storage.
export function vendorBleId(b, off = 0) {
  return (b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3];
}

function idBytes(e) {
  if (e.idHex !== undefined) {
    const b = parseHex(e.idHex);
    if (b.length !== 4) throw new Error("idHex must be 4 bytes");
    return b;
  }
  const n = e.id;
  if (!Number.isInteger(n)) throw new Error("BLE button needs idHex or a numeric id");
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function decodeBleButtons(table) {
  const t = bytes(table);
  const out = [];
  for (let n = 0; n < BLE_SLOTS && n * BLE_ENTRY_LEN + 5 < t.length; n++) {
    const o = n * BLE_ENTRY_LEN;
    const id = vendorBleId(t, o + 2);
    if (id === 0) continue;
    out.push({ slot: n, click: t[o], dblClick: t[o + 1], id, idHex: hex(t.slice(o + 2, o + 6)) });
  }
  return out;
}

// Build the BA write payload. entries = [{click, dblClick, idHex | id}] in screen order.
// Entries fill slots 0.. in order, the other slots become 0, bytes 252-255 are copied from `base`.
export function encodeBleButtons(base, entries) {
  const t = base ? Uint8Array.from(base) : emptyTable();
  if (t.length !== TABLE_LEN) throw new Error(`base table must have ${TABLE_LEN} bytes`);
  if (entries.length > BLE_SLOTS) throw new Error(`at most ${BLE_SLOTS} BLE buttons`);
  for (let n = 0; n < BLE_SLOTS; n++) {
    const o = n * BLE_ENTRY_LEN, e = entries[n];
    if (!e) { t.fill(0, o, o + BLE_ENTRY_LEN); continue; }
    checkByte("click", e.click);
    checkByte("dblClick", e.dblClick);
    t[o] = e.click;
    t[o + 1] = e.dblClick;
    t.set(idBytes(e), o + 2);
  }
  return t;
}

// Battery percent from 2 bytes, little-endian, in mV. 2200 mV = 0 %, 3200 mV = 100 % (vendor formula).
export function bleBatteryPercent(lo, hi) {
  let mv = (hi << 8) | lo;
  if (mv < 2200) mv = 2200;
  if (mv > 3200) mv = 3200;
  return Math.round((mv - 2200) / 10);
}

// Default actions for a new button: the vendor uses 249 (click) and 248 (double click)
// when bit 7 of byte 5 in the pairing message is 1, otherwise 0 and 0.
export const BLE_FLAG_DEFAULTS = { click: 249, dblClick: 248 };

// Parse a BA message from the module (any length).
//  1 byte:   echo of BA 01 (pairing started). The vendor shows "press the BLE button" when it is 01.
//  6 bytes:  a button was pressed in pairing mode: id (4), battery (2, LE mV). Byte 5 bit 7 is a flag.
//  7 bytes:  a known button was pressed: id (4), battery (2), byte 6 = 0 single click, 1 double click.
//  256 bytes: the table (reply to BA 02 or to a BA write).
export function parseBleNotify(p) {
  const u = bytes(p);
  switch (u.length) {
    case 1:
      return { kind: "pairAck", value: u[0] };
    case 6: {
      const flag = (u[5] & 0x80) !== 0;
      return {
        kind: "learned", id: vendorBleId(u, 0), idHex: hex(u.slice(0, 4)), flag,
        battery: bleBatteryPercent(u[4], u[5] & 0x7f),
        click: flag ? BLE_FLAG_DEFAULTS.click : 0, dblClick: flag ? BLE_FLAG_DEFAULTS.dblClick : 0,
      };
    }
    case 7:
      // The vendor does not clear bit 7 of byte 5 here.
      return {
        kind: "press", id: vendorBleId(u, 0), idHex: hex(u.slice(0, 4)),
        battery: bleBatteryPercent(u[4], u[5]), clickType: u[6], double: u[6] === 1,
      };
    case TABLE_LEN:
      return { kind: "table", table: u };
    default:
      return { kind: "unknown", data: u };
  }
}

// ---------------------------------------------------------------- BB "try"

// BB + 1 byte runs one action id on the car now (the same code that a trigger runs).
// The module replies BB 01. The vendor shows "command sent".
// This is a car action. Ask the user before you send it.
export function tryPayload(actionId) {
  checkByte("action", actionId);
  return Uint8Array.of(actionId);
}

// ---------------------------------------------------------------- function list (vendor server)

// Shape that the vendor pages read (fun=funlist.js on the vendor server, cached as "FunListJs"):
//   { btn: [Group], fun: [Group], ... }   Group = { name, data: [{ val, name, title?, attemp? }] }
// btn = shortcut triggers (also the RGB page commands), fun = actions.
// title = help line under the selected entry. attemp = truthy: the picker shows a "try" button.
export function validateFunList(list) {
  const errors = [];
  for (const key of ["btn", "fun"]) {
    const groups = list && list[key];
    if (!Array.isArray(groups)) { errors.push(`${key} is not an array`); continue; }
    groups.forEach((g, i) => {
      if (typeof g.name !== "string") errors.push(`${key}[${i}].name is not a string`);
      if (!Array.isArray(g.data)) { errors.push(`${key}[${i}].data is not an array`); return; }
      g.data.forEach((d, j) => {
        if (!Number.isInteger(d.val)) errors.push(`${key}[${i}].data[${j}].val is not an integer`);
        if (typeof d.name !== "string") errors.push(`${key}[${i}].data[${j}].name is not a string`);
      });
    });
  }
  return errors;
}

// Name for an id. The vendor takes the last match over all groups. Returns null if none.
export function funName(groups, val) {
  let name = null;
  for (const g of groups || []) for (const d of g.data || []) if (d.val == val) name = d.name;
  return name;
}

// All names for an id except id 0, joined with spaces (the vendor press toast).
export function funNamesAll(groups, val) {
  const out = [];
  for (const g of groups || []) for (const d of g.data || []) if (d.val != 0 && d.val == val) out.push(d.name);
  return out;
}

// ---------------------------------------------------------------- write check (vendor setCheckData/getCheckData)

// After an AB or BA write the module sends the table back. The vendor compares it with what it sent.
// If they differ, it sends the same write again. It sends at most 5 times in total. Then it accepts
// the last reply without a message. This class does the same and reports the result.
// Differences from the vendor (on purpose): replies of another type are ignored, and the final
// result says if the echo matched.
export class WriteCheck {
  constructor(type, payload, maxSends = 5) {
    this.type = type;
    this.payload = Uint8Array.from(payload);
    this.left = maxSends;
    this.sends = 1;
  }

  // Returns { action: "ignore" } | { action: "resend", type, payload } | { action: "done", ok }.
  onReply(type, reply) {
    if (type !== this.type || this.left <= 0) return { action: "ignore" };
    const r = bytes(reply);
    const ok = r.length === this.payload.length && r.every((b, i) => b === this.payload[i]);
    if (--this.left > 0 && !ok) {
      this.sends++;
      return { action: "resend", type: this.type, payload: this.payload };
    }
    this.left = 0;
    return { action: "done", ok };
  }
}

// ---------------------------------------------------------------- local backup file

// The vendor backup page keeps 3 blocks on its server:
//   1. settings page data = the A0 status payload (read with A0 00, restored with A3)
//   2. shortcut data      = the AB table (read with AB 02, restored with an AB write)
//   3. BLE button data    = the BA table (read with BA 02, restored with a BA write)
// This file format keeps the same blocks in a local JSON file.
export const BACKUP_FORMAT = "tsl6-backup";
export const BACKUP_VERSION = 1;

const UID = [4, 18];        // module id (UID14)
const PASSWORD = [36, 40];  // BLE password, ASCII
const VIN_BLOCK = [40, 59]; // 01 + VIN + 1 byte

function printable(b, [a, z]) {
  for (let i = a; i < z; i++) if (b[i] < 0x20 || b[i] > 0x7e) return false;
  return true;
}

// Make a backup object. Each block is a Uint8Array or null.
// redact (default true): set the module id, the BLE password and the VIN block of the
// settings block to 0. A restore takes these bytes from the module that it writes to.
export function makeBackup({ settings = null, shortcuts = null, bleButtons = null, bleNames = {} } = {},
  { redact = true, created = new Date().toISOString() } = {}) {
  let s = settings ? Uint8Array.from(settings) : null;
  if (s && redact) {
    for (const [a, z] of [UID, PASSWORD, VIN_BLOCK]) if (s.length >= z) s.fill(0, a, z);
  }
  for (const [name, t] of [["shortcuts", shortcuts], ["bleButtons", bleButtons]]) {
    const why = t && tableWriteBlocker(t);
    if (why) throw new Error(`${name}: ${why}`);
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    created,
    redacted: !!(s && redact),
    blocks: {
      settings: s ? { cmd: "A0", length: s.length, hex: hex(s) } : null,
      shortcuts: shortcuts ? { cmd: "AB", length: TABLE_LEN, hex: hex(shortcuts) } : null,
      bleButtons: bleButtons ? { cmd: "BA", length: TABLE_LEN, hex: hex(bleButtons) } : null,
    },
    // Button names by idHex. The vendor keeps them only in the phone storage.
    bleNames: { ...bleNames },
  };
}

// Check and decode a backup object (from JSON.parse). Returns { settings, shortcuts, bleButtons, bleNames }.
export function readBackup(obj) {
  if (!obj || obj.format !== BACKUP_FORMAT) throw new Error("not a TSL6 backup file");
  if (obj.version !== BACKUP_VERSION) throw new Error(`backup version ${obj.version} is not supported`);
  const out = { settings: null, shortcuts: null, bleButtons: null, bleNames: { ...(obj.bleNames || {}) } };
  for (const key of ["settings", "shortcuts", "bleButtons"]) {
    const b = obj.blocks && obj.blocks[key];
    if (!b) continue;
    const data = parseHex(b.hex);
    if (b.length !== undefined && b.length !== data.length) throw new Error(`${key}: length does not match`);
    if (key !== "settings") {
      const why = tableWriteBlocker(data);
      if (why) throw new Error(`${key}: ${why}`);
    }
    out[key] = data;
  }
  return out;
}

// The writes that restore a backup, in vendor order (settings, shortcuts, BLE buttons).
// Each step: { block, type, payload, accept(type, reply) -> bool }.
// accept() is true when a reply shows that the module stored the block.
// Settings restore (A3), like the vendor: the backup payload with bytes 0-17 taken from
// the current status. Our additions: bytes 40-58 (VIN block, the runtime ignores them) also come
// from the current status, and with keepPassword (default) or a redacted backup bytes 36-39
// (BLE password) come from the current status, so a restore does not change the password.
// Runtime V1.0.00 answers an A3 write with an A0 frame. The vendor waits for an exact copy,
// which never comes because bytes 18-23 are live values. We compare bytes 24-39 and 59-74.
export function restorePlan(backup, currentStatus, { keepPassword = true, blocks = ["settings", "shortcuts", "bleButtons"] } = {}) {
  const steps = [];
  if (blocks.includes("settings") && backup.settings) {
    const cur = currentStatus ? bytes(currentStatus) : null;
    if (!cur || cur.length < 40) throw new Error("read the module status (with the BLE password) before a settings restore");
    if (cur.length !== backup.settings.length) {
      throw new Error(`backup settings have ${backup.settings.length} bytes, the module sends ${cur.length}`);
    }
    const p = Uint8Array.from(backup.settings);
    p.set(cur.slice(0, 18), 0);
    if (p.length >= VIN_BLOCK[1]) p.set(cur.slice(...VIN_BLOCK), VIN_BLOCK[0]);
    if (keepPassword || !printable(p, PASSWORD)) p.set(cur.slice(...PASSWORD), PASSWORD[0]);
    steps.push({
      block: "settings", type: CMD.SETTINGS, payload: p,
      accept: (type, r) => (type === CMD.STATUS || type === CMD.SETTINGS) && settingsEchoMatches(p, bytes(r)),
    });
  }
  for (const [block, type] of [["shortcuts", CMD.SHORTCUTS], ["bleButtons", CMD.BLE_BUTTONS]]) {
    if (!blocks.includes(block) || !backup[block]) continue;
    const p = Uint8Array.from(backup[block]);
    steps.push({
      block, type, payload: p,
      accept: (t, r) => t === type && r.length === p.length && bytes(r).every((b, i) => b === p[i]),
    });
  }
  return steps;
}
