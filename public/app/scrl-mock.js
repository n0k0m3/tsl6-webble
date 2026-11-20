// Mock BLE board for UI wiring tests: open the app with ?mock=h2.
// It answers from the same notes as the codec (lib/scrl.js), so it proves nothing about the real board.
//   ?mock=h2&pair     the first Status reads fail, as during a pairing
//   ?mock=h2&lock     bus-off lock            ?mock=h2&pending   unconfirmed image
//   ?mock=h2&cut=N    writes longer than N bytes are cut         ?mock=h2&lo   Scroll Ack off, Listen-Only
//   ?mock=h2&nopair   the pairing never works: the board drops the link
//   ?mock=h2&board=ID the board type (default nanoh2-minican)    ?mock=h2&can=mcp2515   its CAN controller (default twai)
//   ?mock=h2&bad=settings   the Settings JSON has a number for "enabled"   ?mock=h2&bad=log   the Log subscribe fails
//   ?mock=h2&nocap    firmware before 0.4.0: no Capture characteristic   ?mock=h2&capdrop=N   the link drops N s into a capture
//   ?mock=h2&capdup   each capture packet arrives two times (seen with a real phone, 2026-11-20)
// The capture frames are made up (synthetic IDs and data). They are not from a car.
import * as SC from "../lib/scrl.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder(), dec = new TextDecoder();

export class MockH2Transport {
  constructor() {
    const q = new URLSearchParams(location.search);
    this.q = q; this.up = false; this.down = false; this.subs = {}; this.onDisconnect = () => {};
    const on = !q.has("lo");
    this.settings = { enabled: on, mode: 0, pattern: 0, delay_ms: 600, gap_ms: 100, interval_ms: 2500, op_mode: on ? 1 : 0 };
    // Ported TSL6 features of firmware 0.3.0. "&nofeat" acts as firmware 0.2.0.
    this.features = q.has("nofeat") ? {} : { lr: 2, rand: 1 }; // highest value of each
    for (const k of Object.keys(this.features)) this.settings[k] = k === "rand" ? 1 : 0;
    // Longest Timer interval (Info "imax", firmware 0.3.2). "&noimax" (or "&nofeat") acts as older firmware: 10 s.
    this.imax = q.has("nofeat") || q.has("noimax") ? 0 : 35000;
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
  has(name) { return name !== "capture" || !(this.q.has("nocap") || this.q.has("nofeat")); }
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
    if (this.cap && this.cap.running) { f |= F.CAPTURE; f &= ~(F.ACTIVE | F.TX_ALLOWED | F.TIMER_ARMED); }
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
    this.capEnd(false);
    this.up = false; this.subs = {}; this.ota = null;
    if (downMs) { this.down = true; setTimeout(() => { this.down = false; }, downMs); }
    setTimeout(() => this.onDisconnect(), 0);
  }
  close() { if (this.up) this.drop(0); }
  async read(name) {
    await sleep(40);
    if (!this.up) throw new Error("GATT Server is disconnected");
    if (name === "info") {
      return enc.encode(`{"fw":"${this.fw}","build":"4d298926","built":"Nov 15 2026 15:33:32","idf":"v5.5.6","board":"${this.board}","chip":"${this.chip}","can":"${this.can}","id":"74dafe000001","rst_log":[${this.pending ? 3 : 1},1,1,9]${this.imax ? `,"imax":${this.imax}` : ""}}`);
    }
    if (this.q.has("nopair")) { if (++this.refused >= 3) this.drop(0); throw new Error("GATT Error: insufficient authentication"); }
    if (this.authFails > 0) { this.authFails--; throw new Error("GATT Error: insufficient authentication"); }
    if (name === "status") return enc.encode(this.statusText());
    if (name === "live") return this.liveBytes();
    if (name === "settings" && this.q.get("bad") === "settings") return enc.encode('{"enabled":1,"mode":0,"pattern":0,"delay_ms":600,"gap_ms":100,"interval_ms":2500,"op_mode":0}');
    if (name === "settings") return enc.encode(JSON.stringify(this.settings));
    throw new Error("read not permitted");
  }
  async subscribe(name, cb) {
    await sleep(20);
    if (!this.up) throw new Error("GATT Server is disconnected");
    if (name === "log" && this.q.get("bad") === "log") throw new Error("GATT Error: Not supported.");
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
      if (k in this.features) {
        const max = this.features[k];
        if (v === true || v === false) { if (max !== 1) throw new Error("GATT Error: value not allowed"); s[k] = +v; continue; }
        if (!Number.isInteger(v) || v < 0 || v > max) throw new Error("GATT Error: value not allowed");
        s[k] = v; continue;
      }
      if (!SC.SETTING_KEYS.includes(k)) throw new Error("GATT Error: value not allowed");
      if (k === "enabled") { if (v !== true && v !== false && v !== 0 && v !== 1) throw new Error("GATT Error: value not allowed"); s.enabled = !!v; continue; }
      if (!Number.isInteger(v) || v < 0 || (k === "op_mode" && v > 1)) throw new Error("GATT Error: value not allowed");
      s[k] = v;
    }
    if (s.mode > 1) s.mode = 0;
    if (s.pattern > (Object.keys(this.features).length ? 5 : 3)) s.pattern = 0;
    s.delay_ms = Math.min(s.delay_ms, 5000); s.gap_ms = Math.min(s.gap_ms, 2000);
    s.interval_ms = Math.min(Math.max(s.interval_ms, 1000), this.imax || 10000);
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
    if (b[0] === C.CAPTURE_START) return this.capStart(b);
    if (b[0] === C.CAPTURE_MARK) {
      if (b.length !== 2) throw new Error("GATT Error: invalid attribute length");
      if (!this.cap || !this.cap.running) throw new Error("GATT Error: value not allowed");
      this.cap.marks.push([this.capNow(), b[1]]);
      return;
    }
    if (b.length !== 1) throw new Error("GATT Error: invalid attribute length");
    if (b[0] === C.CAPTURE_STOP) { this.capEnd(true); return; }
    if (b[0] === C.RESET_COUNTERS) { this.sent = 0; this.rx = 0; this.say("CMD  counters reset"); }
    else if (b[0] === C.REBOOT) { this.say("CMD  restart"); setTimeout(() => { this.boot = Date.now(); this.drop(1500); }, 300); }
    else if (b[0] === C.FORGET_BONDS) { this.say("BLE  bonds deleted"); setTimeout(() => this.drop(0), 100); }
    else if (b[0] === C.FACTORY_RESET) {
      this.settings = { enabled: false, mode: 0, pattern: 0, delay_ms: 600, gap_ms: 100, interval_ms: 2500, op_mode: 0 };
      for (const k of Object.keys(this.features)) this.settings[k] = k === "rand" ? 1 : 0;
      setTimeout(() => { this.boot = Date.now(); this.drop(1500); }, 300); }
    else if (b[0] === C.CONFIRM_IMAGE) { if (this.pending) { this.pending = false; this.say("UPD  image confirmed"); } }
    else throw new Error("GATT Error: value not allowed");
  }
  // ---- capture (packets as in scrl_capture.h, made up frames)
  capNow() { return Date.now() - this.boot; }
  capStart(b) {
    if (b.length < 2 || !this.has("capture") || this.can !== "twai") throw new Error("GATT Error: value not allowed");
    if (!this.subs.capture || (this.cap && this.cap.active)) throw new Error("GATT Error: value not allowed");
    if (b[1] > 2 || (b[1] !== 2 && b.length !== 2)) throw new Error("GATT Error: value not allowed");
    this.cap = { active: true, running: true, mode: b[1], seq: 0, frames: [], marks: [], ids: new Map(), rxAll: 0, n: 0,
      t0: this.capNow(), stateAt: 0, idsAt: this.capNow() };
    this.say(`CAP  started, mode ${b[1]}: Listen-Only until it stops`);
    this.cap.timer = setInterval(() => this.capTick(), 20);
    const drop = Number(this.q.get("capdrop")) || 0;
    if (drop) setTimeout(() => { if (this.cap && this.cap.running) this.drop(0); }, drop * 1000);
  }
  capEnd(sendState) {
    const c = this.cap;
    if (!c || !c.active) return;
    c.running = false;
    clearInterval(c.timer);
    if (sendState) { this.capFlush(); this.capIds(); this.capSend(4, this.capState()); this.say(`CAP  stopped: ${c.rxAll} frames, 0 lost in the ring`); }
    c.active = false;
  }
  // 20 ms of a made-up bus: 0x118 and 0x129 at 100/s, 0x257 at 50/s, 0x3C2 at 10/s, and 0x400-0x40F only in the table.
  capTick() {
    const c = this.cap;
    if (!c || !c.running || !this.up) return;
    const t = this.capNow();
    const plan = [[0x118, 1], [0x129, 1], [0x257, 2], [0x3C2, 5]];
    c.n++;
    for (const [id, every] of plan) {
      if (c.n % every) continue;
      const data = [c.n & 0xFF, (c.n >> 8) & 0xFF, id & 0xFF, 0x10, 0x20, 0x30, 0x40, c.n & 0x0F];
      c.frames.push([t, id, data]);
      this.capSeen(id, t, data);
    }
    for (let k = 0; k < 4; k++) this.capSeen(0x400 + ((c.n * 4 + k) % 16), t, [k, 0, 0, 0, 0, 0, 0, 0]);
    this.capFlush();
    if (t - c.stateAt >= 1000) { c.stateAt = t; this.capSend(4, this.capState()); }
    if (t - c.idsAt >= 5000 || c.n === 1) { c.idsAt = t; this.capIds(); }
    while (c.marks.length) { const [mt, step] = c.marks.shift(); const r = new Uint8Array(8); new DataView(r.buffer).setUint32(0, mt, true); r[4] = step; this.capSend(3, [r]); }
  }
  capSeen(id, t, data) {
    const c = this.cap;
    c.rxAll++;
    const e = c.ids.get(id) || { id, frames: 0, first: t, last: t, data };
    e.frames++; e.last = t; e.data = data;
    c.ids.set(id, e);
  }
  capFlush() {
    const c = this.cap;
    while (c.frames.length) {
      const recs = c.frames.splice(0, 10).map(([t, id, data]) => {
        const r = new Uint8Array(16), v = new DataView(r.buffer);
        v.setUint32(0, t, true); v.setUint16(4, id, true); r[6] = 8; r.set(data, 8);
        return r;
      });
      this.capSend(1, recs);
    }
  }
  capIds() {
    const all = [...this.cap.ids.values()];
    for (let i = 0; i < all.length; i += 7) {
      this.capSend(2, all.slice(i, i + 7).map(e => {
        const r = new Uint8Array(24), v = new DataView(r.buffer);
        v.setUint16(0, e.id, true); r[2] = 8; v.setUint32(4, e.frames, true); v.setUint32(8, e.first, true); v.setUint32(12, e.last, true);
        r.set(e.data, 16);
        return r;
      }));
    }
  }
  capState() {
    const c = this.cap, r = new Uint8Array(20), v = new DataView(r.buffer);
    v.setUint32(0, this.capNow(), true); r[4] = c.running ? 1 : 0; r[5] = c.mode; r[6] = Math.min(255, c.ids.size);
    v.setUint32(8, c.rxAll, true); v.setUint32(12, 0, true); v.setUint32(16, 0, true);
    return [r];
  }
  capSend(type, recs) {
    const c = this.cap;
    const body = recs.reduce((n, r) => n + r.length, 0), b = new Uint8Array(8 + body);
    b[0] = type; b[1] = type === 3 || type === 4 ? 1 : recs.length;
    new DataView(b.buffer).setUint16(2, c.seq & 0xFFFF, true);
    let o = 8; for (const r of recs) { b.set(r, o); o += r.length; }
    c.seq++;
    if (this.up && this.subs.capture) { this.subs.capture(b); if (this.q.has("capdup")) this.subs.capture(b.slice()); }
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
