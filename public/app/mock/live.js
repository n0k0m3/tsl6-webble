// Mock for the live-data pages: battery info (D0-D2), CAN debug (C0) and BLE host pairing (F0).
// Synthetic data only. It follows the private spec, so it proves nothing about the real module.
import { registerMock, registerTicker } from "../mock.js";

// Every D0, C0 and F0 request that reaches the mock, for UI tests: [{t, type, hex}].
const record = (globalThis.__tsl6MockLive = globalThis.__tsl6MockLive || []);
const hexs = p => Array.from(p, b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
function note(type, p) {
  record.push({ t: Date.now(), type, hex: hexs(p) });
  if (record.length > 500) record.splice(0, record.length - 500);
}
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// ------------------------------------------------------------------ battery (D0 request; D0, D1, D2 replies)
const CELLS = 96;
const cellRaw = Array.from({ length: CELLS }, () => rnd(40420, 40520)); // x 0.0001 V
let cellGroup = 0;

function packPayload() {
  const p = new Uint8Array(29);
  const dv = new DataView(p.buffer);
  const amps = rnd(-300, 300);                     // raw x -0.1 A
  dv.setUint16(0, 37500 + rnd(-20, 20), true);     // 375.00 V
  dv.setInt16(2, amps, true);
  dv.setUint32(4, 12345678, true);                 // discharged 12345.678 kWh
  dv.setUint32(8, 13024680, true);                 // charged 13024.680 kWh
  dv.setUint16(12, 2000, true);                    // remaining 40.00 kWh
  dv.setUint16(14, 2500, true);                    // full 50.00 kWh
  dv.setUint16(16, 250, true);                     // reserve 2.50 kWh
  const max = Math.round(Math.max(...cellRaw) / 20), min = Math.round(Math.min(...cellRaw) / 20); // x 0.002 V
  const cells = max | (min << 12);
  p[18] = cells & 0xff; p[19] = (cells >> 8) & 0xff; p[20] = (cells >> 16) & 0xff;
  // Bytes 21-28: one 64-bit LE bit field. factory cap 10 / range 10 / heat 2 / temp 9 / car SOC 7 / odometer 26.
  let bits = 600n;                                 // 60.0 kWh
  bits |= 200n << 10n;                             // 200 mi
  bits |= 0n << 20n;                               // not heating
  bits |= 130n << 22n;                             // 25.0 degC
  bits |= 70n << 31n;                              // 70 %
  bits |= 1234567n << 38n;                         // 123456.7 km
  for (let i = 0; i < 8; i++) p[21 + i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  return p;
}
function cellPayload() {
  const g = cellGroup;
  cellGroup = (cellGroup + 1) % (CELLS / 3);
  const p = new Uint8Array(8);
  const dv = new DataView(p.buffer);
  p[0] = g; p[1] = 0;
  for (let k = 0; k < 3; k++) {
    const i = 3 * g + k;
    cellRaw[i] = Math.min(40600, Math.max(40380, cellRaw[i] + rnd(-3, 3)));
    dv.setUint16(2 + 2 * k, cellRaw[i], true);
  }
  return p;
}
function dcdcPayload() {
  const p = new Uint8Array(8);
  const dv = new DataView(p.buffer);
  dv.setUint16(0, 1405 + rnd(-3, 3), true);        // out 14.05 V (x 0.01)
  dv.setUint16(2, 3893 + rnd(-2, 2), true);        // in 389.3 V (x 0.1)
  dv.setUint16(4, 255 + rnd(-20, 20), true);       // out 25.5 A (x 0.1)
  return p;
}
registerMock(0xd0, p => {
  note(0xd0, p);
  switch (p[0]) {
    case 2: return [[0xd0, packPayload()]];
    case 3: return [[0xd1, cellPayload()]];
    case 4: return [[0xd2, dcdcPayload()]];
    default: return null;                          // 00 stop, 01 start: no reply
  }
});

// ------------------------------------------------------------------ CAN debug (C0)
const BUS_IDS = [0x118, 0x132, 0x257, 0x3f5, 0x2e5, 0x39d];
let dbgMode = 0;                                   // 0 off, 1 all, 2 paused, 3 filter
let dbgIds = [];
registerMock(0xc0, p => {
  note(0xc0, p);
  if (p.length === 1) { dbgMode = p[0]; return null; }
  if (p.length >= 4 && p.length % 2 === 0 && p[0] === 0xff && p[1] === 0xff) {
    dbgIds = [];
    for (let i = 2; i < p.length; i += 2) dbgIds.push(p[i] | (p[i + 1] << 8));
    dbgMode = 3;
    return null;
  }
  return null;                                     // a CAN send: recorded, nothing echoed
});

// ------------------------------------------------------------------ BLE host (F0)
const NEARBY = [
  { mac: [0xc0, 0xff, 0xee, 0x00, 0x00, 0x01], addrType: 0, name: "MOCK-BTN-A", rssi: -62 },
  { mac: [0xc0, 0xff, 0xee, 0x00, 0x00, 0x02], addrType: 1, name: "MOCK-BTN-B", rssi: -78 },
  { mac: [0xc0, 0xff, 0xee, 0x00, 0x00, 0x03], addrType: 1, name: "", rssi: -91 },
];
const macKey = m => m.join(",");
const paired = new Map([[macKey([0xc0, 0xff, 0xee, 0x00, 0x00, 0x09]),
  { mac: [0xc0, 0xff, 0xee, 0x00, 0x00, 0x09], addrType: 0, name: "MOCK-KNOB", rssi: -128, battery: 64 }]]);
let scanning = false, scanUntil = 0;
const nameBytes = s => { const b = new Uint8Array(24); b.set(new TextEncoder().encode(s).slice(0, 24)); return b; };

function listPayload() {
  const recs = [...paired.values()];
  const t = [recs.length];
  for (const d of recs) t.push(d.rssi & 0xff, d.battery, d.addrType, ...d.mac, ...nameBytes(d.name));
  t.push(0, 0, 0, 0x5a);
  return Uint8Array.from([4, scanning ? 1 : 0, ...t]);
}
function scanPayload(d) {
  return Uint8Array.from([3, 1, (d.rssi + rnd(-3, 3)) & 0xff, d.addrType, ...d.mac, ...nameBytes(d.name)]);
}
const statusPayload = code => Uint8Array.of(6, scanning ? 1 : 0, code);

registerMock(0xf0, (p, m) => {
  note(0xf0, p);
  if (p.length < 15) return null;
  const sub = p[14], body = p.slice(15);
  switch (sub) {
    case 1: scanning = true; scanUntil = Date.now() + 15000; return null;
    case 2: scanning = false; return null;
    case 4: return listPayload();
    case 5: {
      const mac = Array.from(body.slice(1, 7));
      const d = NEARBY.find(x => macKey(x.mac) === macKey(mac));
      setTimeout(() => {
        if (!m.connected) return;
        if (paired.size >= 4) return m.reply(0xf0, statusPayload(5));
        paired.set(macKey(mac), { mac, addrType: body[0], name: d ? d.name : "", rssi: -60, battery: d ? 90 : 0 });
        m.reply(0xf0, statusPayload(1));
      }, 1200);
      return statusPayload(0);
    }
    case 7: {
      paired.delete(macKey(Array.from(body.slice(1, 7))));
      return statusPayload(4);
    }
    default: return null;
  }
});

// ------------------------------------------------------------------ streams
let ticks = 0;
registerTicker(m => {
  if (!m.connected) { dbgMode = 0; scanning = false; return; }
  ticks++;
  // CAN debug: one or two frames per 100 ms tick.
  if (dbgMode === 1 || dbgMode === 3) {
    const ids = dbgMode === 1 ? BUS_IDS : dbgIds;
    for (let n = rnd(1, 2); n > 0 && ids.length; n--) {
      const id = ids[rnd(0, ids.length - 1)];
      const data = Array.from({ length: rnd(1, 8) }, () => rnd(0, 255));
      m.reply(0xc0, Uint8Array.from([id >> 8, id & 0xff, ...data]));
    }
  }
  // BLE host: a scan result every 500 ms while scanning. The scan stops by itself after 15 s.
  if (scanning && Date.now() > scanUntil) scanning = false;
  if (scanning && ticks % 5 === 0) {
    const free = NEARBY.filter(d => !paired.has(macKey(d.mac)));
    if (free.length) m.reply(0xf0, scanPayload(free[rnd(0, free.length - 1)]));
  }
  // Paired devices: the mock "connects" each one after pairing.
  if (ticks % 10 === 0) for (const d of paired.values()) if (d.rssi !== -128) d.rssi = rnd(-75, -55);
});
