// Mock for the ambient light tables (B9). Synthetic data only.
// URL switches (with ?mock):
//   rgb=nomodule  every B9 request gets the 1-byte FF reply (no ambient light module)
//   rgb=badecho   a write gets an echo with one changed byte
//   rgb=slow      every reply comes after 1200 ms
//   rgb=silent    a write gets no reply
// window.__rgbMock.rx records each B9 payload that the mock gets (for UI tests).
import { registerMock, registerTicker } from "../mock.js";
import { encodeTable, TABLE_LEN, OP } from "../../lib/tsl6-rgb.js";

const MODE = new URLSearchParams(location.search).get("rgb") || "";
const TAIL = Uint8Array.of(0, 0, 0, 0);

// Trigger ids exist in data/funlist.json (153/154/155 = blind-spot events).
const tables = [
  encodeTable([
    { cmd: 0, run: 0, addr: 3, color: [0x77, 0xff, 0x44], bright: 3, breathe: 0, blink: 0, effect: 1 },
    { cmd: 153, run: 0, addr: 1, color: [0xe8, 0x33, 0x22], bright: 3, breathe: 1, blink: 8, effect: 1 },
    { cmd: 154, run: 0, addr: 1, color: [0xff, 0x00, 0xff], bright: 3, breathe: 0, blink: 0, effect: 0 },
    { cmd: 155, run: 1, addr: 2, color: [0x22, 0x66, 0xff], bright: 14, breathe: 2, blink: 0, effect: 1 },
  ], TAIL),
  encodeTable([
    { cmd: 0, run: 0, addr: 2, color: [0xff, 0xff, 0xff], bright: 0, breathe: 3, blink: 5, effect: 0 },
  ], TAIL),
];

const rec = { rx: [], link: null };
if (typeof window !== "undefined") window.__rgbMock = rec;
registerTicker(m => { rec.link = m; });

registerMock(0xb9, (p, mock) => {
  rec.rx.push(Array.from(p));
  let out;
  if (MODE === "nomodule") out = Uint8Array.of(0xff);
  else if (p.length === 2 && p[0] === OP.READ && p[1] <= 1) out = Uint8Array.from(tables[p[1]]);
  else if (p.length === 2 + TABLE_LEN && p[0] === OP.WRITE && p[1] <= 1) {
    if (MODE === "silent") return null;
    tables[p[1]] = Uint8Array.from(p.subarray(2));
    out = Uint8Array.from(tables[p[1]]);
    if (MODE === "badecho") out[TABLE_LEN - 1] ^= 0x5a;
  } else if (p.length === 3 && p[0] === OP.TRY && p[1] <= 1) {
    mock.log(`mock: B9 try tab ${p[1]} rule ${p[2]}`);
    return null; // the reply to Try is not known; the mock sends none
  } else if (p.length === 2 && p[0] === OP.CLEAR && p[1] <= 1) {
    const t = new Uint8Array(TABLE_LEN);
    t.set(tables[p[1]].subarray(0, 7)); // the mock keeps rule 0 (unknown on the real module)
    t.set(tables[p[1]].subarray(252), 252);
    tables[p[1]] = t;
    out = Uint8Array.from(t);
  } else {
    mock.log(`mock: B9 payload not understood (${p.length} bytes)`, "warn");
    return null;
  }
  if (MODE === "slow") { setTimeout(() => mock.connected && mock.reply(0xb9, out), 1200); return null; }
  return out;
});
