// Mock BLE board for UI wiring tests: open the app with ?mock=h2.
// It answers from the same notes as the codec (lib/scrl.js), so it proves nothing about the real board.
//   ?mock=h2&pair     the first Status reads fail, as during a pairing
//   ?mock=h2&lock     bus-off lock            ?mock=h2&pending   unconfirmed image
//   ?mock=h2&cut=N    writes longer than N bytes are cut         ?mock=h2&lo   Scroll Ack off, Listen-Only
//   ?mock=h2&nopair   the pairing never works: the board drops the link
//   ?mock=h2&board=ID the board type (default nanoh2-minican)    ?mock=h2&can=mcp2515   its CAN controller (default twai)
import * as SC from "../lib/scrl.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();

export class MockH2Transport {
  constructor() {
    const q = new URLSearchParams(location.search);
    this.q = q; this.up = false; this.down = false; this.subs = {}; this.onDisconnect = () => {};
    const on = !q.has("lo");
    this.settings = { enabled: on, mode: 0, pattern: 0, delay_ms: 600, gap_ms: 100, interval_ms: 2500, op_mode: on ? 1 : 0 };
    this.passkey = ""; this.refused = 0;
    this.lock = q.has("lock"); this.pending = q.has("pending"); this.authFails = q.has("pair") ? 3 : 0;
    this.cut = Number(q.get("cut")) || 0;
    this.board = SC.BOARDS[q.get("board")] ? q.get("board") : "nanoh2-minican";
    this.chip = SC.BOARDS[this.board].chip;
    this.can = q.get("can") || "twai";
    this.boot = Date.now(); this.sent = 1284; this.fw = "0.1.0"; this.rx = 0; this.ota = null; this.lines = [];
    this.say("BOOT reset reason 1, power-on count 42");
    this.say("CAN  started Active");
    setInterval(() => this.tick(), 1000);
  }
  get name() { return "SCRL-MOCK"; }
  detach() { this.onDisconnect = () => {}; }
  get connected() { return this.up; }
  uptime() { return Math.floor((Date.now() - this.boot) / 1000); }
  say(text) {
    const t = Date.now() - this.boot;
    const line = `${Math.floor(t / 1000)}.${String(t % 1000).padStart(3, "0")} ${text}`;
    this.lines.push(line); if (this.lines.length > 64) this.lines.shift();
    if (this.up && this.subs.log) this.subs.log(enc.encode(line));
  }
  flags() {
    const F = SC.FLAG, s = this.settings;
    const active = s.op_mode === 1 && !this.lock && !this.pending && !this.ota;
    let f = F.HW4_SEEN | F.PINS_CHECKED | F.CAN_RUNNING;
    if (active) f |= F.ACTIVE | F.TX_ALLOWED;
    if (s.enabled) f |= F.ENABLED;
    if (s.enabled && active && s.mode === 1) f |= F.TIMER_ARMED;
    if (this.lock) f |= F.BUS_OFF_LOCK;
    if (this.pending) f |= F.IMAGE_PENDING;
    if (this.ota) f |= F.BLE_OTA;
    if (this.uptime() < 300) f |= F.PAIRING_OPEN;
    return f;
  }
  tick() {
    if (this.down) return;
    this.rx += 2000;
    const f = this.flags();
    if ((f & SC.FLAG.TX_ALLOWED) && (f & SC.FLAG.ENABLED) && this.uptime() % 3 === 0) {
      this.sent += 2;
      this.say("SCRL 0x3C2 left tick -1 (first) TX can0");
      this.say("SCRL 0x3C2 left tick +1 (second) TX can0");
    }
    if (this.up && this.subs.live) this.subs.live(this.liveBytes());
  }
  liveBytes() {
    const b = new Uint8Array(19), f = this.flags();
    b[0] = 0; b[1] = (f & SC.FLAG.ENABLED) ? ((f & SC.FLAG.TX_ALLOWED) ? 8 : 2) : 1; b[2] = 6; b[3] = 1; b[4] = f & 0xFF;
    new DataView(b.buffer).setUint32(5, this.sent, true);
    b[11] = 1; b[13] = 20 + (this.uptime() % 30);
    return b;
  }
  statusText() {
    const f = this.flags(), block = SC.BLOCKS[this.liveBytes()[1]];
    return `{"scroll_ack_sent_count":${this.sent},"scroll_ack_diag":{"phase":"Armed","block":"${block}","native_age_ms":1,` +
      `"das_age_ms":20,"das_ap_state":6,"das_hands_on":1,"vehicle_bus":"can0","tx_allowed":${!!(f & 1)},"pairs_aborted":0,` +
      `"timer_armed":${!!(f & 2)}},"op":${this.settings.op_mode},"flags":${f},"rx":[${this.rx},${this.rx / 200},${this.rx / 40},0,` +
      `${this.rx / 20},${this.rx / 20},${this.rx / 10},0],"tx":[${this.sent},0,0],"boff":${this.lock ? 3 : 0},"rst":${this.pending ? 3 : 1},` +
      `"pwr":42,"up":${this.uptime()},"rxpin":2}`;
  }
  async pick() {}
  async open() { await sleep(250); if (this.down) throw new Error("the board does not advertise"); this.up = true; this.subs = {}; this.refused = 0; }
  drop(downMs) {
    this.up = false; this.subs = {}; this.ota = null;
    if (downMs) { this.down = true; setTimeout(() => { this.down = false; }, downMs); }
    setTimeout(() => this.onDisconnect(), 0);
  }
  close() { if (this.up) this.drop(0); }
  async read(name) {
    await sleep(40);
    if (!this.up) throw new Error("GATT Server is disconnected");
    if (name === "info") {
      return enc.encode(`{"fw":"${this.fw}","build":"4d298926","built":"Nov 15 2026 15:33:32","idf":"v5.5.6","board":"${this.board}","chip":"${this.chip}","can":"${this.can}","id":"74dafe000001","rst_log":[${this.pending ? 3 : 1},1,1,9]}`);
    }
    if (this.q.has("nopair")) { if (++this.refused >= 3) this.drop(0); throw new Error("GATT Error: insufficient authentication"); }
    if (this.authFails > 0) { this.authFails--; throw new Error("GATT Error: insufficient authentication"); }
    if (name === "status") return enc.encode(this.statusText());
    if (name === "live") return this.liveBytes();
    if (name === "settings") { const s = this.settings; return enc.encode(JSON.stringify({ enabled: s.enabled, mode: s.mode, pattern: s.pattern, delay_ms: s.delay_ms, gap_ms: s.gap_ms, interval_ms: s.interval_ms, op_mode: s.op_mode })); }
    throw new Error("read not permitted");
  }
  async subscribe(name, cb) {
    await sleep(20);
    if (!this.up) throw new Error("GATT Server is disconnected");
    this.subs[name] = cb;
    if (name === "log") for (const l of this.lines) cb(enc.encode(l));
  }
  otaEvent(event, status) {
    const b = new Uint8Array(6); b[0] = event; b[1] = status;
    new DataView(b.buffer).setUint32(2, this.ota ? this.ota.got : 0, true);
    if (this.subs.otaCtrl) this.subs.otaCtrl(b);
  }
  async write(name, bytes, noResponse) {
    await sleep(noResponse ? 2 : 30);
    if (!this.up) throw new Error("GATT Server is disconnected");
    if (name === "settings") return this.writeSettings(dec.decode(bytes));
    if (name === "command") return this.command(bytes);
    if (name === "otaCtrl") return this.otaCtrl(bytes);
    if (name === "otaData") return this.otaData(bytes);
    throw new Error("write not permitted");
  }
  writeSettings(text) {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error("GATT Error: value not allowed"); }
    const s = { ...this.settings };
    for (const [k, v] of Object.entries(j)) {
      if (!SC.SETTING_KEYS.includes(k)) throw new Error("GATT Error: value not allowed");
      if (k === "enabled") { if (v !== true && v !== false && v !== 0 && v !== 1) throw new Error("GATT Error: value not allowed"); s.enabled = !!v; continue; }
      if (!Number.isInteger(v) || v < 0 || (k === "op_mode" && v > 1)) throw new Error("GATT Error: value not allowed");
      s[k] = v;
    }
    if (s.mode > 1) s.mode = 0;
    if (s.pattern > 3) s.pattern = 0;
    s.delay_ms = Math.min(s.delay_ms, 5000); s.gap_ms = Math.min(s.gap_ms, 2000);
    s.interval_ms = Math.min(Math.max(s.interval_ms, 1000), 10000);
    if (j.op_mode === 1 && this.lock) { this.lock = false; }
    this.settings = s;
    this.say(`SET  on=${+s.enabled} mode=${s.mode} pat=${s.pattern} dly=${s.delay_ms} gap=${s.gap_ms} int=${s.interval_ms} op=${s.op_mode}`);
  }
  command(b) {
    const C = SC.CMD;
    if (b[0] === C.SET_PASSKEY) {
      const text = dec.decode(b.subarray(1));
      if (!SC.isPasskey(text)) throw new Error("GATT Error: value not allowed");
      this.passkey = text;
      this.say("CMD  passkey changed");
      return;
    }
    if (b.length !== 1) throw new Error("GATT Error: invalid attribute length");
    if (b[0] === C.RESET_COUNTERS) { this.sent = 0; this.rx = 0; this.say("CMD  counters reset"); }
    else if (b[0] === C.REBOOT) { this.say("CMD  restart"); setTimeout(() => { this.boot = Date.now(); this.drop(1500); }, 300); }
    else if (b[0] === C.FORGET_BONDS) { this.say("BLE  bonds deleted"); setTimeout(() => this.drop(0), 100); }
    else if (b[0] === C.FACTORY_RESET) { this.settings = { enabled: false, mode: 0, pattern: 0, delay_ms: 600, gap_ms: 100, interval_ms: 2500, op_mode: 0 }; setTimeout(() => { this.boot = Date.now(); this.drop(1500); }, 300); }
    else if (b[0] === C.CONFIRM_IMAGE) { if (this.pending) { this.pending = false; this.say("UPD  image confirmed"); } }
    else throw new Error("GATT Error: value not allowed");
  }
  async otaCtrl(b) {
    const O = SC.OTA, E = SC.OTA_ERR;
    if (b[0] === O.OP_BEGIN) {
      let st = E.OK;
      if (b.length !== 37) st = E.REQUEST; else if (this.ota) st = E.STATE; else if (this.pending) st = E.PENDING;
      const size = new DataView(b.buffer, b.byteOffset).getUint32(1, true);
      if (st === E.OK && (size < 24 || size > O.SLOT_SIZE)) st = E.SIZE;
      if (st === E.OK) { this.ota = { size, sha: b.slice(5, 37), got: 0, credit: 0, parts: [] }; this.say(`UPD  started, ${size} bytes to ota_1`); }
      this.otaEvent(O.EVT_BEGIN, st);
    } else if (b[0] === O.OP_END && b.length === 1) {
      const o = this.ota;
      let st = E.OK;
      if (!o) st = E.STATE; else if (o.got !== o.size) st = E.SIZE;
      else {
        const all = new Uint8Array(o.size); let p = 0; for (const part of o.parts) { all.set(part, p); p += part.length; }
        const sha = await SC.sha256(all);
        if (!sha.every((v, i) => v === o.sha[i])) st = E.SHA;
        else {
          // As the firmware: the chip and the board ID must match this board.
          const c = SC.checkImage(all, { id: this.board, chip: this.chip, can: this.can });
          if (c.errors.length) { st = E.IMAGE; this.say(`UPD  image is for board "${c.info.board || "?"}", this is "${this.board}"`); }
          else { this.fw = c.info.version || this.fw; this.nextCan = c.info.can || this.can; }
        }
      }
      this.otaEvent(O.EVT_END, st);
      this.ota = null;
      if (st === E.OK) { this.say("UPD  image written to ota_1 - restart"); setTimeout(() => { this.pending = true; this.can = this.nextCan || this.can; this.boot = Date.now(); this.lines = []; this.drop(2000); this.say("UPD  new image runs from ota_1 - confirm it within 10 min"); }, 600); }
    } else if (b[0] === O.OP_ABORT && b.length === 1) {
      const st = this.ota ? E.ABORTED : E.STATE;
      this.otaEvent(O.EVT_STOPPED, st);
      this.ota = null;
    } else this.otaEvent(O.EVT_STOPPED, E.REQUEST);
  }
  otaData(b) {
    const o = this.ota, O = SC.OTA;
    if (!o || !b.length) return;
    if (this.cut && b.length > this.cut) b = b.subarray(0, this.cut);
    if (b.length > o.size - o.got) { this.otaEvent(O.EVT_STOPPED, SC.OTA_ERR.SIZE); this.ota = null; return; }
    o.parts.push(b.slice()); o.got += b.length;
    if (o.got - o.credit >= O.CREDIT_STEP || o.got === o.size) { o.credit = o.got; this.otaEvent(O.EVT_CREDIT, 0); }
  }
}
