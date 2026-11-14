// Mock of the shortcut table (AB), the BLE button table (BA) and the "try" command (BB).
// It answers as the runtime V1.0.00 handlers do (see the private spec tables.md). Synthetic data only.
// Fault injection for tests: ?mock&fault=echo|bd|mute (one time), or set mockTables.fault from a test.
//   echo: the next table write gets a wrong echo once.  bd: the next table write gets BD 00.
//   mute: the next table write gets no reply (the table is still stored).
import { registerMock, registerTicker } from "../mock.js";
import { emptyTable, FACTORY_SHORTCUTS, TABLE_LEN, MAGIC_OFFSET, MAGIC, BLE_SLOTS, BLE_ENTRY_LEN } from "../../lib/tsl6-tables.js";

const ab = emptyTable();
FACTORY_SHORTCUTS.forEach(([t, a], n) => { ab[2 * n] = t; ab[2 * n + 1] = a; });
// One pair with ids that the function list does not have (trigger 47, action 57).
ab[2 * FACTORY_SHORTCUTS.length] = 47;
ab[2 * FACTORY_SHORTCUTS.length + 1] = 57;
const ba = emptyTable();

export const mockTables = {
  ab, ba,
  fault: new URLSearchParams(location.search).get("fault"),
  pairing: false,
  nextId: 1,
  tries: [],          // BB action ids received
  autoPress: true,    // a known button "press" every 20 s while buttons exist
};

function takeFault() { const f = mockTables.fault; mockTables.fault = null; return f; }

// A 256-byte write: check the magic byte, store, echo the table.
function tableWrite(type, store, p) {
  if (p[MAGIC_OFFSET] !== MAGIC) return [[0xbd, Uint8Array.of(0)]];
  const f = takeFault();
  if (f === "bd") return [[0xbd, Uint8Array.of(0)]];
  store.set(p);
  if (f === "mute") return null;
  if (f === "echo") { const bad = Uint8Array.from(store); bad[0] ^= 0xff; return [[type, bad]]; }
  return [[type, Uint8Array.from(store)]];
}

registerMock(0xab, p => {
  if (p.length === 1) return p[0] === 2 ? Uint8Array.from(ab) : null;
  if (p.length === TABLE_LEN) return tableWrite(0xab, ab, p);
  return null;
});

// Battery 2900 mV, little-endian. Bit 7 of byte 5 is the vendor "flag".
function learnedMessage(flag) {
  const n = mockTables.nextId++;
  return Uint8Array.of(0xc0, 0xff, 0xee, n & 0xff, 0x54, 0x0b | (flag ? 0x80 : 0));
}

registerMock(0xba, (p, mock) => {
  if (p.length === 1 && p[0] === 1) {
    mockTables.pairing = true;
    // A "button press" in pairing mode 1.2 s later. Every second new button has the flag bit.
    setTimeout(() => {
      if (!mockTables.pairing || !mock.connected) return;
      mockTables.pairing = false;
      mock.reply(0xba, learnedMessage(mockTables.nextId % 2 === 0));
    }, 1200);
    return Uint8Array.of(1);
  }
  if (p.length === 1 && p[0] === 2) { mockTables.pairing = false; return Uint8Array.from(ba); }
  if (p.length === TABLE_LEN) { mockTables.pairing = false; return tableWrite(0xba, ba, p); }
  return null;
});

registerMock(0xbb, p => { mockTables.tries.push(p[0]); return Uint8Array.of(1); });

// Send a 7-byte "known button pressed" message for the button in slot n.
export function mockPress(mock, n = 0, double = false) {
  const o = n * BLE_ENTRY_LEN;
  if (n >= BLE_SLOTS || !(ba[o + 2] | ba[o + 3] | ba[o + 4] | ba[o + 5])) return false;
  mock.reply(0xba, Uint8Array.of(ba[o + 2], ba[o + 3], ba[o + 4], ba[o + 5], 0x20, 0x0b, double ? 1 : 0));
  return true;
}

let ticks = 0, dbl = false;
registerTicker(mock => {
  if (!mockTables.autoPress || ++ticks % 200) return;
  if (mock.auth && mockPress(mock, 0, dbl)) dbl = !dbl;
});
