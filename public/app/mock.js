// Mock TSL6 module for UI wiring tests (open the app with ?mock).
// It answers from the same specs as the codecs, so it proves nothing about the real module.
// All IDs and the VIN are synthetic.
import { LinkBase, Decoder, encode } from "./ble.js";
import { STATUS_ROWS } from "../lib/tsl6-status.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const HANDLERS = {};
// Subsystem files call this: handler(payload, mock) returns a reply payload, an array of [type, payload], or null.
export function registerMock(type, handler) { HANDLERS[type] = handler; }

function initialStatus() {
  const p = new Uint8Array(76);
  p[0] = 0; p[1] = 0x12; p[2] = 0x10;
  p[3] = 0x01 | (4 << 4);                          // runtime running, Tesla model 4 (Model Y)
  for (let i = 0; i < 12; i++) p[4 + i] = 0xa0 + i; // synthetic module ID
  p[16] = p[4]; p[17] = p[5];
  p[18] = 0x0c;                                    // charge port open, driver massage on (as in the owner capture)
  p[22] = 1;                                       // make 1 = Tesla
  p[23] = 0b011;                                   // CAN1 and CAN2 connected
  p.set([0x00, 0x00, 0x03, 0x11, 0x11, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00], 24);
  p.set([0x31, 0x32, 0x33, 0x34], 36);             // default password 1234
  p[40] = 1;
  const vin = "TESTVIN0000000001";
  for (let i = 0; i < 17; i++) p[41 + i] = vin.charCodeAt(i);
  return p;
}

export class MockLink extends LinkBase {
  constructor() {
    super();
    this.id = "mock";
    this.state = initialStatus();
    this.auth = false;
    this.txDecoder = new Decoder();
    this.timer = 0;
    // Bootloader simulation: ?mock&boot starts in boot mode. A runtime 0x55 restarts into it.
    this.mode = new URLSearchParams(location.search).has("boot") ? "boot" : "runtime";
    this.down = false;     // restarting: the module does not advertise
    this.flash = null;     // {started, pages}
  }
  get name() { return this.mode === "boot" ? "TSL6-BOOT (mock)" : "TSL6 (mock)"; }
  set name(_) { /* fixed by the mode */ }
  async open() {
    await sleep(300);
    if (this.down) { const e = new Error("Connection failed (mock module restarting)"); e.name = "NetworkError"; throw e; }
    this.connected = true;
    this.log("connected to the MOCK module", "warn");
    this.emit("state", { connected: true });
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 100);
  }
  close() { clearInterval(this.timer); this.log("mock disconnected", "warn"); this.auth = false; this.dropLink(); }
  async reconnect() { return this.open(); }

  // Status as the runtime builds it: blank (18-39 and 59-74 = 0) before the password.
  statusPayload() {
    const p = Uint8Array.from(this.state);
    if (!this.auth) { p.fill(0, 18, 40); p.fill(0, 59, 75); }
    return p;
  }
  reply(type, payload) { setTimeout(() => this.connected && this.receive(encode(type, payload)), 60); }
  tick() {
    // Count the assist timer down when AP assist is active.
    const s = this.state;
    if (s[19] & 1) {
      let t = s[20] | (s[21] << 8);
      t = t <= 100 ? 2500 : t - 100;
      s[20] = t & 0xff; s[21] = t >> 8;
    }
    for (const f of tickers) f(this);
  }

  async rawWrite(part) {
    await sleep(5);
    for (const fr of this.txDecoder.feed(part)) this.handle(fr.cmd, fr.payload);
  }

  // Module ID as the bootloader reports it. The runtime sends UID14 = id[4:12] + id[0:6] in status bytes 4-17.
  moduleId() { const s = this.state; return Uint8Array.from([...s.slice(12, 16), ...s.slice(4, 12)]); }
  bootStatus() { return Uint8Array.from([0x00, 0x12, 0x10, 0x00, ...this.moduleId()]); }
  restart(mode, { window = false } = {}) {
    setTimeout(() => { clearInterval(this.timer); this.auth = false; this.log("mock module restarts", "warn"); this.dropLink(); }, 200);
    setTimeout(() => { this.mode = mode; this.down = true; }, 400);
    setTimeout(() => { this.down = false; }, 1200);
    // Bootloader mode 1 goes back to the runtime after about 10 s without a valid 0x53.
    if (window) setTimeout(() => { if (this.mode === "boot" && !(this.flash && this.flash.started)) { this.mode = "runtime"; this.log("mock: boot window passed", "warn"); } }, 11200);
  }
  handleBoot(type, p) {
    const uid = Uint8Array.from([...this.state.slice(4, 18)]);
    const uidOk = p.length === 15 && p[0] === 1 && p.slice(1).every((b, i) => b === uid[i]);
    switch (type) {
      case 0xa0: return this.reply(0xa0, this.bootStatus());
      case 0x55: return this.reply(0x55, Uint8Array.of(uidOk ? 0 : 1));
      case 0x53: this.flash = { started: uidOk, pages: 0 }; return this.reply(0x53, Uint8Array.of(uidOk ? 0 : 0xff));
      case 0x57: if (this.flash) this.flash.pages++; return this.reply(0x57, Uint8Array.of(0));
      case 0x45: this.reply(0x45, Uint8Array.of(0)); return this.restart("runtime");
      default: this.log(`mock bootloader: ignores ${type.toString(16).toUpperCase()}`, "warn");
    }
  }

  handle(type, p) {
    if (this.mode === "boot") return this.handleBoot(type, p);
    const s = this.state;
    const gated = ![0xa0, 0xa8, 0xad, 0xae, 0x55, 0x53, 0x57, 0x45].includes(type);
    if (gated && !this.auth) return this.reply(0xa8, Uint8Array.of(0xff));
    switch (type) {
      case 0xa0: return this.reply(0xa0, this.statusPayload());
      case 0xa8: {
        const key = String.fromCharCode(...s.slice(36, 40));
        this.auth = p.length === 4 && String.fromCharCode(...p) === key;
        if (!this.auth) return this.reply(0xa8, Uint8Array.of(0));
        // Runtime V1.0.00 sends a status on a match, not "A8 01". ?mock&a8=01 tests the other reply style.
        if (new URLSearchParams(location.search).get("a8") === "01") return this.reply(0xa8, Uint8Array.of(1));
        return this.reply(0xa0, this.statusPayload());
      }
      case 0xa3:
        if (p.length !== 76) return;
        s.set(p.slice(24, 40), 24); s.set(p.slice(59, 75), 59);
        return this.reply(0xa0, this.statusPayload());
      case 0xa1: s[19] = (s[19] & ~1) | (p[0] & 1); if (p[0]) { s[20] = 0xc4; s[21] = 0x09; } return this.reply(0xa1, this.statusPayload());
      case 0xa6: s[18] = (s[18] & ~1) | (p[0] & 1); return;
      case 0xa7: {
        const v = p[0];
        for (const r of STATUS_ROWS) if (r.kind === "switch" && r.handler === "switchControl" && (v === r.btn || v === r.btn + 1)) {
          const off = { esp: 3, fxp: 18, on: 19 }[r.state[0]];
          s[off] = (s[off] & ~(1 << r.state[1])) | ((v - r.btn) << r.state[1]);
        }
        if (v >= 52 && v <= 71 && v % 2 === 1) return this.reply(0xa7, Uint8Array.of(1, 1)); // seat memory saved
        return;
      }
      case 0xa2: return;
      case 0xa4: s.set([0, 0, 0xff, 0x11, 0x01, 0, 0, 0, 0x01, 0x01, 0], 24); return this.reply(0xa4, new Uint8Array(0));
      case 0xa5: return this.reply(0xa5, new Uint8Array(0));
      case 0xa9: {
        const old = String.fromCharCode(...p.slice(18, 22));
        if (p.length !== 26) return this.reply(0xa9, Uint8Array.of(2));
        if (old !== String.fromCharCode(...s.slice(36, 40))) return this.reply(0xa9, Uint8Array.of(0));
        s.set(p.slice(22, 26), 36);
        return this.reply(0xa9, Uint8Array.of(1));
      }
      case 0xc1: return this.reply(0xc1, Uint8Array.of(0x04, 0x01, 0x00, 0x00));
      case 0x55: {
        // Runtime 0x55: 01 + status bytes 4-17, no password. Replies 55 01 and restarts into the bootloader.
        const ok = p.length === 15 && p[0] === 1 && p.slice(1).every((b, i) => b === s[4 + i]);
        if (!ok) return;
        this.flash = null;
        this.reply(0x55, Uint8Array.of(1));
        return this.restart("boot", { window: true });
      }
      default: {
        const h = HANDLERS[type];
        if (!h) { this.log(`mock: no handler for ${type.toString(16).toUpperCase()}`, "warn"); return; }
        const r = h(p, this);
        if (!r) return;
        if (Array.isArray(r)) for (const [t, pl] of r) this.reply(t, pl);
        else this.reply(type, r);
      }
    }
  }
}

// Periodic jobs that subsystem mocks add (for example a stream).
const tickers = new Set();
export function registerTicker(f) { tickers.add(f); return () => tickers.delete(f); }
