// TSL6 live-data codec: battery info (D0-D2), CAN debug (C0) and BLE host pairing (F0).
// Layouts come from the vendor Mini App pages batteryInfo, debug and bleHost.
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// Every payload below is the frame payload (after 55 7F TYPE LEN_H LEN_L), without the checksum.
// Scales and labels are the vendor's. They are not checked against the car.

export const TYPE = {
  BATTERY: 0xd0, // 208. Request (all tabs) and pack reply
  BATTERY_CELLS: 0xd1, // 209. Cell voltage reply
  BATTERY_DCDC: 0xd2, // 210. DC-DC converter reply
  DEBUG: 0xc0, // 192. CAN debug: mode, filter, send, and received frames
  BLE_HOST: 0xf0, // 240. Module acts as a BLE central for BLE buttons
};

// ------------------------------------------------------------------ small helpers

const u8 = p => (p instanceof Uint8Array ? p : Uint8Array.from(p));
const u16le = (u, o) => (u[o] | (u[o + 1] << 8)) >>> 0;
const u32le = (u, o) => (u[o] | (u[o + 1] << 8) | (u[o + 2] << 16) | (u[o + 3] << 24)) >>> 0;

// Read `width` bits that start at bit `bit` of a little-endian bit stream that starts at byte `byte`.
function bitsLE(u, byte, bit, width) {
  let v = 0;
  for (let k = 0; k < width; k++) {
    const b = bit + k;
    if ((u[byte + (b >> 3)] >> (b & 7)) & 1) v += 2 ** k;
  }
  return v;
}

export function hex(a, sep = "") {
  return Array.from(a, b => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

function hexToBytes(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}

// ================================================================== battery (D0, D1, D2)

// Tabs of the battery page, in screen order.
export const BATTERY_TABS = [
  { id: "pack", zh: "动力电池", label: "HV battery" },
  { id: "cells", zh: "单体电压", label: "Cell voltages" },
  { id: "dcdc", zh: "DCDC状态", label: "DC-DC status" },
];

// D0 request payloads.
// The vendor sends START once when the page shows, then POLL(tab) on a timer, then STOP when the page hides.
export const BATTERY_START = Uint8Array.of(1);
export const BATTERY_STOP = Uint8Array.of(0);
export function batteryPoll(tab) {
  if (![0, 1, 2].includes(tab)) throw new Error(`battery tab ${tab} out of range 0..2`);
  return Uint8Array.of(tab + 2); // 2 = pack, 3 = cells, 4 = DC-DC
}
// Delay between polls in ms. The first poll goes 500 ms after START.
export function batteryPollMs(tab) {
  return tab === 1 ? 1000 : 500;
}
export const BATTERY_FIRST_POLL_MS = 500;

// D0 reply (pack). Needs 29 bytes.
// Returns raw integer fields and numeric values. batteryPackView() builds the vendor rows.
export function decodeBatteryPack(p) {
  const u = u8(p);
  if (u.length < 29) return { error: `pack reply too short (${u.length} < 29)` };
  const raw = {
    voltage: u16le(u, 0), // x 0.01 V
    current: u16le(u, 2), // signed 16, x -0.1 A
    discharged: u32le(u, 4), // x 0.001 kWh
    charged: u32le(u, 8), // x 0.001 kWh
    energyRemain: u16le(u, 12), // x 0.02 kWh
    energyFull: u16le(u, 14), // x 0.02 kWh
    energyReserve: u16le(u, 16), // x 0.01 kWh
    cellMax: bitsLE(u, 18, 0, 12), // x 0.002 V
    cellMin: bitsLE(u, 18, 12, 12), // x 0.002 V
    // Bytes 21-28 are one little-endian bit field: 10/10/2/9/7/26 bits.
    factoryCap: bitsLE(u, 21, 0, 10), // x 0.1 kWh. 1 = not known ("设置")
    range: bitsLE(u, 21, 10, 10), // x 1.61 km (raw is miles)
    heatState: bitsLE(u, 21, 20, 2), // 2 = heating
    temp: bitsLE(u, 21, 22, 9), // x 0.5 - 40 degC
    socCar: bitsLE(u, 21, 31, 7), // % (used only when remaining energy is 0)
    odometer: bitsLE(u, 21, 38, 26), // x 0.1 km
  };
  // Same float operations as the vendor, so the display text matches.
  // Current: the vendor computes -0.1 x raw and adds 6553.6 below -3276.7.
  // We use the signed value. The result differs only at raw 32767 (vendor shows +3276.9).
  const currentA = raw.current >= 0x8000 ? -0.1 * raw.current + 6553.6 : -0.1 * raw.current;
  return {
    raw,
    voltageV: 0.01 * raw.voltage,
    currentA, // sign meaning (charge or discharge) is not verified
    dischargedKWh: 0.001 * raw.discharged,
    chargedKWh: 0.001 * raw.charged,
    energyRemainKWh: 0.02 * raw.energyRemain,
    energyFullKWh: 0.02 * raw.energyFull,
    energyReserveKWh: 0.01 * raw.energyReserve,
    cellMaxV: 0.002 * raw.cellMax,
    cellMinV: 0.002 * raw.cellMin,
    factoryCapKWh: 0.1 * raw.factoryCap,
    factoryCapKnown: raw.factoryCap !== 1,
    rangeKm: 1.61 * raw.range,
    tempC: 0.5 * raw.temp - 40,
    heating: raw.heatState === 2,
    socCarPct: raw.socCar,
    odometerKm: raw.odometer / 10,
  };
}

// Rows of the pack tab, in screen order, with the vendor's text.
// factoryCapOverride: the user value in kWh (vendor storage key "battFull"). Used when > 0.
// Rows "remaining energy" and "real SOC" are left out when remaining energy is 0
// (or above full energy, which the vendor sets to 0).
export function batteryPackView(pack, factoryCapOverride = 0) {
  if (pack.error) return { error: pack.error, rows: [], odometerText: "0" };
  const rows = [];
  const row = (id, zh, label, text, extra) => rows.push({ id, zh, label, text, ...extra });
  const volts = pack.voltageV, amps = pack.currentA;
  row("voltage", "总电压", "Pack voltage", volts.toFixed(2) + " V");
  row("current", "总电流", "Pack current", amps.toFixed(1) + " A");
  row("power", "总功率", "Pack power", ((volts * amps) / 1e3).toFixed(2) + " KW");
  row("charged", "总充电量", "Total charged", pack.chargedKWh.toFixed(2) + " KWH");
  row("discharged", "总放电量", "Total discharged", pack.dischargedKWh.toFixed(2) + " KWH");
  const cellHi = pack.cellMaxV, cellLo = pack.cellMinV;
  row("cellMax", "单体最高", "Highest cell", cellHi.toFixed(3) + " V");
  row("cellMin", "单体最低", "Lowest cell", cellLo.toFixed(3) + " V");
  row("cellDelta", "电池压差", "Cell difference", (1e3 * (cellHi - cellLo)).toFixed(0) + " mV");

  // Keep this float order: the display text must match the vendor app.
  const reserve = pack.energyReserveKWh;
  const remain = pack.energyRemainKWh > pack.energyFullKWh ? 0 : pack.energyRemainKWh;
  let full = pack.energyFullKWh;
  if (full > pack.factoryCapKWh && pack.factoryCapKnown) full = pack.factoryCapKWh; // capped at the factory capacity
  let soc = ((remain - reserve) / (full - reserve)) * 100;
  soc = soc > 100 ? 100 : soc < 0 ? 0 : soc; // NaN stays NaN, as in the vendor app
  const userCap = Number(factoryCapOverride);
  const cap = userCap > 0 ? userCap : pack.factoryCapKWh;
  row("factoryCap", "出厂容量", "Factory capacity",
    cap === 0.1 ? "设置" : cap.toFixed(2) + " KWH", { tappable: true });
  if (remain > 0) row("energyRemain", "剩余电量", "Remaining energy", remain.toFixed(2) + " KWH");
  row("energyReserve", "保留电量", "Reserved energy", reserve.toFixed(2) + " KWH");
  row("range", "剩余里程", "Range", pack.rangeKm.toFixed(2) + " KM");
  row("socCar", "车机SOC", "Car SOC", (remain === 0 ? pack.socCarPct : soc).toFixed(2) + " %");
  if (remain > 0) row("socReal", "实际SOC", "Real SOC", Math.min((remain / full) * 100, 100).toFixed(2) + " %");
  row("temp", "电池温度", "Battery temperature", pack.tempC.toFixed(1) + " ℃");
  row("heating", "正在预热", "Heating", pack.heating ? "是" : "否", { max: pack.heating, en: pack.heating ? "Yes" : "No" });
  return { rows, odometerText: pack.odometerKm.toFixed(1) }; // header row "总里程" (odometer), unit KM
}

// D1 reply: one group of 3 cells. Needs 8 bytes.
// Byte 0 = group index g (cells 3g+1 .. 3g+3). Byte 1 = not used by the app.
// Bytes 2-7 = three u16 LE, x 0.0001 V. A value that rounds to 0.000 V means "no cell".
export function decodeCellGroup(p) {
  const u = u8(p);
  if (u.length < 8) return { error: `cell reply too short (${u.length} < 8)` };
  const first = 3 * u[0];
  const cells = [];
  for (let k = 0; k < 3; k++) {
    const raw = u16le(u, 2 + 2 * k);
    const volts = Number((1e-4 * raw).toFixed(3)); // the vendor rounds to mV before any math
    cells.push({ index: first + k, raw, volts, present: volts > 0 });
  }
  return { group: u[0], byte1: u[1], first, cells };
}

// Cell tab state. Call resetCells() when the user opens the cell tab (the vendor does this on every tab tap).
// The vendor keeps the highest and lowest value seen since the reset, not the current extremes.
// A cell that later reads 0 keeps its last value.
export function resetCells() {
  return { cells: [], runMax: 0, runMin: 255, reading: -1, maxV: 0, minV: 0, avgV: 0, deltaMV: 0, maxText: "0", minText: "0", avgText: "0", deltaText: "0" };
}

export function applyCellGroup(state, p) {
  const g = decodeCellGroup(p);
  if (g.error) return g;
  state.reading = g.first; // "正在读取 Cell n - n+2"
  for (const c of g.cells) {
    if (!c.present) continue;
    state.cells[c.index] = { cell: c.index + 1, volts: c.volts, text: c.volts.toFixed(3) + " V" };
    if (c.volts > state.runMax) state.runMax = c.volts;
    if (c.volts < state.runMin) state.runMin = c.volts;
  }
  if (state.runMax !== 0 && state.runMin !== 255) {
    state.maxV = state.runMax;
    state.minV = state.runMin;
    state.maxText = state.runMax.toFixed(3);
    state.minText = state.runMin.toFixed(3);
    state.deltaMV = 1e3 * (state.runMax - state.runMin);
    state.deltaText = state.deltaMV.toFixed(0);
    let sum = 0, count = 0;
    state.cells.forEach(c => {
      c.max = c.volts === state.runMax;
      c.min = c.volts === state.runMin;
      sum += c.volts;
      count++;
    });
    if (count > 0) {
      state.avgV = sum / count;
      state.avgText = state.avgV.toFixed(3);
    }
  }
  return g;
}

// D2 reply (DC-DC converter). Needs 8 bytes. Bytes 6-7 are not used by the app.
export function decodeDcdc(p) {
  const u = u8(p);
  if (u.length < 8) return { error: `DC-DC reply too short (${u.length} < 8)` };
  const raw = { outV: u16le(u, 0), inV: u16le(u, 2), outA: u16le(u, 4), unused: u16le(u, 6) };
  return { raw, outV: 0.01 * raw.outV, inV: 0.1 * raw.inV, outA: 0.1 * raw.outA };
}

export function dcdcView(dc) {
  if (dc.error) return { error: dc.error, rows: [] };
  const outVText = dc.outV.toFixed(1), outAText = dc.outA.toFixed(1);
  return {
    rows: [
      { id: "inV", zh: "输入电压", label: "Input voltage", text: dc.inV.toFixed(1) + " V" },
      { id: "outV", zh: "输出电压", label: "Output voltage", text: outVText + " V" },
      { id: "outA", zh: "输出电流", label: "Output current", text: outAText + " A" },
      // Power uses the rounded voltage and current, as the vendor app shows it.
      { id: "outW", zh: "输出功率", label: "Output power", text: (Number(outVText) * Number(outAText)).toFixed(0) + " W" },
    ],
  };
}

// ================================================================== CAN debug (C0)

// C0 request payloads with one byte.
export const DEBUG_MODE = {
  OFF: 0, // sent when the page hides or closes
  ALL: 1, // "接收所有ID数据": forward every received CAN frame (long press on 接收)
  PAUSE: 2, // sent when the page shows, and by the 暂停 (pause) button
};
export function debugMode(mode) {
  if (![0, 1, 2].includes(mode)) throw new Error(`debug mode ${mode} out of range 0..2`);
  return Uint8Array.of(mode);
}

// Forward only these CAN IDs: FF FF, then each ID as u16 LITTLE-endian.
export function debugFilter(ids) {
  if (!ids.length) throw new Error("debug filter needs at least one ID");
  const out = [0xff, 0xff];
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error(`CAN ID ${id} out of range 0..0xFFFF`);
    out.push(id & 0xff, id >> 8);
  }
  return Uint8Array.from(out);
}

// TRANSMITS A FRAME ON THE CAR CAN BUS (bus not known). ID as u16 BIG-endian, then 1-8 data bytes.
// An ID of 0xFFFF collides with the filter marker FF FF.
export function debugSend(id, data) {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new Error(`CAN ID ${id} out of range 0..0xFFFF`);
  if (data.length < 1 || data.length > 8) throw new Error(`CAN data must have 1-8 bytes (got ${data.length})`);
  return Uint8Array.from([id >> 8, id & 0xff, ...data]);
}

const ERR = {
  idBad: { zh: "数据ID输入有误", en: "The ID input is not correct" },
  empty: { zh: "数据不能为空", en: "The data must not be empty" },
  tooLong: { zh: "数据最大8字节", en: "The data is 8 bytes at most" },
  dataBad: { zh: "数据输入有误", en: "The data input is not correct" },
};
const isId = s => /^[0-9a-fA-F]+$/.test(s) && (s.length === 3 || s.length === 4);

// Parse the receive-ID box: "IDs separated by commas", each 3 or 4 hex digits. Same rules as the vendor.
export function parseDebugFilterText(text) {
  const ids = [];
  for (const s of String(text).split(",")) {
    if (!isId(s)) return { error: ERR.idBad };
    ids.push(parseInt(s, 16));
  }
  return { ids, payload: debugFilter(ids) };
}

// Parse the send box: "ID,AA BB CC". Same rules as the vendor. Text after a second comma is ignored.
export function parseDebugSendText(text) {
  const a = String(text).split(",");
  if (a.length === 1) return { error: ERR.empty };
  if (!isId(a[0])) return { error: ERR.idBad };
  const parts = a[1].split(" ");
  if (parts.length > 8) return { error: ERR.tooLong };
  for (const s of parts) if (!/^[0-9a-fA-F]+$/.test(s) || s.length !== 2) return { error: ERR.dataBad };
  const id = parseInt(a[0], 16);
  const data = hexToBytes(parts.join(""));
  return { id, data, payload: debugSend(id, data) };
}

// C0 reply: one received CAN frame. ID u16 BIG-endian, then the data bytes.
export function decodeDebugFrame(p) {
  const u = u8(p);
  if (u.length < 2) return { error: `debug frame too short (${u.length} < 2)` };
  return { id: (u[0] << 8) | u[1], data: u.slice(2) };
}

// Log line as the vendor shows it: "<n>. 0x<ID>,<data>,<gap>ms\r\n".
// n counts from 1 and wraps to 0 at 99999. gap = ms since the previous frame, max 9999.
// The vendor keeps the last 999 lines.
export function formatDebugLine(n, p, gapMs) {
  const u = u8(p);
  return `${n}. 0x${hex(u.slice(0, 2))},${hex(u.slice(2), " ")},${Math.min(gapMs, 9999)}ms\r\n`;
}

// ================================================================== BLE host (F0)

// Every F0 request is UID14 (status payload bytes 4-17) + a sub-command.
// The vendor uses 14 zero bytes when it has no status of 18 bytes or more.
export const BLE_HOST_CMD = { SCAN_START: 1, SCAN_STOP: 2, SCAN_RESULT: 3, LIST: 4, PAIR: 5, STATUS: 6, DELETE: 7 };

export function uid14FromStatus(status) {
  const u = u8(status);
  return u.length >= 18 ? u.slice(4, 18) : new Uint8Array(14);
}

function bleHostReq(uid14, body) {
  if (uid14.length !== 14) throw new Error(`UID14 must have 14 bytes (got ${uid14.length})`);
  const out = new Uint8Array(14 + body.length);
  out.set(uid14, 0);
  out.set(body, 14);
  return out;
}

// MAC text "AA:BB:CC:DD:EE:FF" in wire order (the order in the frame) <-> 6 bytes.
export const macToBytes = mac => Uint8Array.from(mac.split(":").map(h => parseInt(h, 16)));
// The page shows the MAC reversed (WXS formatmac of bleHost.wxml).
export const macDisplay = mac => mac.split(":").reverse().join(":");

export const bleHostScanStart = uid14 => bleHostReq(uid14, [1]);
export const bleHostScanStop = uid14 => bleHostReq(uid14, [2]);
export const bleHostList = uid14 => bleHostReq(uid14, [4]); // polled every 1 s while the page shows
// Pair (connect) a device from the scan list. nameBytes = the raw name bytes of its scan record.
export function bleHostPair(uid14, addrType, mac, nameBytes) {
  return bleHostReq(uid14, [5, addrType, ...macToBytes(mac), ...nameBytes]);
}
// Delete a paired device. The vendor asks "确定要删除此蓝牙设备吗?" first.
export function bleHostDelete(uid14, addrType, mac) {
  return bleHostReq(uid14, [7, addrType, ...macToBytes(mac)]);
}

// Status codes of the F0 sub-command 6 reply. kind: -1 = busy, 1 = success, 0 = error.
export const BLE_HOST_STATUS = [
  { zh: "连接中...", en: "Connecting...", kind: -1 },
  { zh: "连接成功", en: "Connected", kind: 1 },
  { zh: "连接失败", en: "Connection failed", kind: 0 },
  { zh: "连接超时", en: "Connection timed out", kind: 0 },
  { zh: "删除成功", en: "Deleted", kind: 1 },
  { zh: "配对数已最大", en: "Paired-device limit reached", kind: 0 },
  { zh: "连接数已最大", en: "Connection limit reached", kind: 0 },
];

// Name bytes -> text. Invalid UTF-8 gives "" (as the vendor). We drop trailing NUL padding for display.
function decodeName(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
const trimNul = s => s.replace(/\0+$/, "");
const int8 = b => (b << 24) >> 24;

// Decode one F0 reply. Byte 0 = sub-command, byte 1 = flag (scan running when not 0).
export function decodeBleHost(p) {
  const u = u8(p);
  if (u.length < 2) return { error: `F0 reply too short (${u.length} < 2)` };
  const sub = u[0], flag = u[1], t = u.slice(2);
  const out = { sub, flag, scanning: flag !== 0 };
  if (sub === 3) {
    // Scan result: rssi(int8), addrType, MAC(6), name(24, UTF-8, NUL padded).
    const mac = hex(t.slice(2, 8), ":");
    const raw = t.slice(8, 32);
    const s = decodeName(raw);
    return { ...out, kind: "scan", device: { mac, rssi: int8(t[0]), addrType: t[1], name: s === null ? "" : trimNul(s), nameBytes: s === null ? new Uint8Array(0) : raw } };
  }
  if (sub === 4) {
    // Paired list: count, count records, 4-byte trailer whose last byte is 0x5A.
    // Record: rssi(int8; -128 = not connected), battery %, addrType, MAC(6), name(24).
    // The record size is (length - 5) / count; the app reads the first 33 bytes of each.
    if (t[t.length - 1] !== 0x5a) return { ...out, kind: "list", valid: false };
    const count = t[0], body = t.slice(1), size = (t.length - 5) / count;
    const devices = [];
    if (count > 0 && !Number.isInteger(size)) return { ...out, kind: "list", valid: false, error: "record size is not whole" };
    for (let f = 0; count > 0 && f < t.length - 5; f += size) {
      const mac = hex(body.slice(3 + f, 9 + f), ":");
      if (mac === "00:00:00:00:00:00") continue;
      const s = decodeName(body.slice(9 + f, 33 + f));
      const rssi = int8(body[f]);
      devices.push({ mac, rssi, battery: body[f + 1], addrType: body[f + 2], name: s === null ? "" : trimNul(s), connected: rssi !== -128 });
    }
    return { ...out, kind: "list", valid: true, count, recordSize: size, trailer: t.slice(t.length - 4), devices };
  }
  if (sub === 6) {
    const code = t[0];
    return { ...out, kind: "status", code, status: BLE_HOST_STATUS[code] || { zh: "", en: `Unknown status ${code}`, kind: 0 } };
  }
  return { ...out, kind: "unknown", data: t };
}

// Page state: paired list (replaced on each list reply) and scan list (keyed by wire-order MAC).
export function createBleHostState() {
  return { paired: {}, found: {}, scanning: false };
}

// Apply one F0 reply to the page state, as the vendor page does. Returns the decoded reply.
export function applyBleHost(state, p) {
  const r = decodeBleHost(p);
  if (r.kind === "scan") {
    const d = r.device;
    if (!state.paired[d.mac]) {
      const old = state.found[d.mac];
      // The vendor keeps a name it already has.
      const keep = old && old.nameBytes.length > 0;
      state.found[d.mac] = { name: keep ? old.name : d.name, nameBytes: keep ? old.nameBytes : d.nameBytes, rssi: d.rssi, addrType: d.addrType };
      state.scanning = r.scanning;
    }
  } else if (r.kind === "list" && r.valid) {
    state.paired = {};
    for (const d of r.devices) {
      state.paired[d.mac] = { name: d.name, rssi: d.rssi, addrType: d.addrType, battery: d.battery, connected: d.connected };
      delete state.found[d.mac];
    }
    state.scanning = r.scanning;
  }
  return r;
}

// Number of lit bars (0-6) of the signal icon. Same rule as the vendor WXS getRSSIVal.
export function rssiBars(rssi) {
  const c = Math.min(-70, Math.max(-99, rssi));
  const x = ((c + 99) * 6) / 29;
  let n = 0;
  for (let i = 0; i < 6; i++) if (i < x) n++;
  return n;
}
