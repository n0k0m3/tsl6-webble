// BLE link to the TSL6 runtime: framing, chunked writes, request/reply, frame dispatch.
// Framing, chunk sizes and the 20-byte fallback are the same as the earlier flasher page (tested on the car).
import { hex } from "../lib/tsl6-settings.js";
import { inBoot } from "../lib/tsl6-flash.js";

export const SVC = "0000fff0-0000-1000-8000-00805f9b34fb";
export const SAFE_CHUNK = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function encode(cmd, payload = new Uint8Array(0)) {
  const n = payload.length;
  const f = new Uint8Array(6 + n);
  f.set([0x55, 0x7f, cmd, n >> 8, n & 0xff]);
  f.set(payload, 5);
  let s = 0;
  for (let i = 2; i < 5 + n; i++) s += f[i];
  f[5 + n] = s & 0xff;
  return f;
}

export class Decoder {
  constructor(onBad) { this.buf = []; this.last = 0; this.onBad = onBad || (() => {}); }
  feed(data, now = Date.now()) {
    if (now - this.last >= 500) this.buf = []; // same 500 ms reset as the vendor app
    this.last = now;
    for (const b of data) this.buf.push(b);
    const out = [];
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === 0x55 && this.buf[i + 1] === 0x7f) { start = i; break; }
      if (start < 0) { this.buf = this.buf.at(-1) === 0x55 ? [0x55] : []; return out; }
      this.buf.splice(0, start);
      if (this.buf.length < 6) return out;
      const n = (this.buf[3] << 8) | this.buf[4];
      if (n > 4096) { this.buf.splice(0, 2); continue; }
      if (this.buf.length < 6 + n) return out;
      const f = this.buf.splice(0, 6 + n);
      let s = 0;
      for (let i = 2; i < 5 + n; i++) s += f[i];
      if ((s & 0xff) !== f[5 + n]) { this.onBad(f); continue; }
      out.push({ cmd: f[2], payload: new Uint8Array(f.slice(5, 5 + n)) });
    }
  }
}

// A status read before the BLE password has bytes 18-39 set to 0 (runtime V1.0.00).
export function isBlankStatus(p) {
  if (p.length < 40) return false;
  for (let i = 18; i < 40; i++) if (p[i] !== 0) return false;
  return true;
}

// The page cannot read the link MTU. iOS/macOS ask for MTU 185 (182 per write); others reach 247 (244).
export function platformChunk() {
  const ua = (globalThis.navigator && navigator.userAgent) || "";
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(ua) ? 180 : 240;
}

function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { /* storage blocked */ }
  return null;
}

// Common link API. Subclasses supply open(), close(), rawWrite(bytes) and call this.receive(bytes).
export class LinkBase extends EventTarget {
  constructor() {
    super();
    this.connected = false;
    this.name = "";
    this.id = "";
    this.status = null;          // last status payload (A0/A1/A3 reply)
    this.boot = null;            // last bootloader status (boot mode); status is null then
    this.authed = false;         // true after A8 01
    this.chunk = +store("tsl6.chunk") || platformChunk();
    this.decoder = new Decoder(f => this.log(`bad checksum, frame dropped: ${hex(f, " ")}`, "warn"));
    this.waiters = [];
    this.queue = Promise.resolve();
    this.verbose = true;
  }
  log(msg, cls = "") { this.dispatchEvent(new CustomEvent("log", { detail: { msg, cls, t: new Date() } })); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { const h = e => fn(e.detail); this.addEventListener(type, h); return () => this.removeEventListener(type, h); }

  receive(bytes) {
    for (const fr of this.decoder.feed(bytes)) this.onFrame(fr);
  }

  onFrame(fr) {
    // B0/C0 are streams; 57 is one reply per flash page.
    if (this.verbose && fr.cmd !== 0xb0 && fr.cmd !== 0xc0 && fr.cmd !== 0x57) this.log(`rx ${fr.cmd.toString(16).toUpperCase()} (${fr.payload.length}) ${hex(fr.payload, " ")}`);
    if (fr.cmd === 0xa8) {
      const v = fr.payload[0];
      if (v === 0xff) { this.authed = false; this.emit("password", { reason: "asked" }); }
      else if (v === 1) { this.authed = true; this.emit("auth", { ok: true }); }
      else if (v === 0) { this.authed = false; this.emit("auth", { ok: false }); }
    }
    // A bootloader status (byte 3 bit 0 = 0) is not a runtime status. The pages never see it as S.status.
    if ((fr.cmd === 0xa0 || fr.cmd === 0xa1 || fr.cmd === 0xa3) && inBoot(fr.payload)) {
      this.boot = fr.payload;
      this.status = null;
      this.emit("boot", fr.payload);
    } else if ((fr.cmd === 0xa0 || fr.cmd === 0xa1 || fr.cmd === 0xa3) && fr.payload.length >= 18) {
      this.boot = null;
      this.status = fr.payload;
      // Runtime V1.0.00 fills bytes 18-39 only on a link that passed A8. A non-blank status means "authenticated".
      if (!isBlankStatus(fr.payload) && !this.authed) { this.authed = true; this.emit("auth", { ok: true }); }
      this.emit("status", fr.payload);
    }
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.cmds.includes(fr.cmd) && (!w.accept || w.accept(fr))) { this.waiters.splice(i, 1); w.resolve(fr); break; }
    }
    this.emit("frame", fr);
    this.emit(`frame:${fr.cmd}`, fr);
  }

  setChunk(n) { this.chunk = n; store("tsl6.chunk", String(n)); }

  // Frames go out one at a time, in order.
  send(cmd, payload = new Uint8Array(0)) {
    const frame = encode(cmd, payload);
    const job = this.queue.then(() => this.writeFrame(frame));
    this.queue = job.catch(() => {});
    return job;
  }

  async writeFrame(frame) {
    if (!this.connected) throw new Error("not connected");
    if (this.verbose && frame[2] !== 0xb0 && frame[2] !== 0xd0 && frame[2] !== 0x57) this.log(`tx ${hex(frame, " ")}`);
    try {
      for (let i = 0; i < frame.length; i += this.chunk) await this.rawWrite(frame.slice(i, i + this.chunk));
    } catch (e) {
      if (!this.connected || this.chunk <= SAFE_CHUNK) throw e;
      this.log(`write failed (${e.message}): bytes per write ${this.chunk} -> ${SAFE_CHUNK}`, "warn");
      this.setChunk(SAFE_CHUNK);
      await sleep(600); // let the module's parser time out (500 ms) before the full resend
      return this.writeFrame(frame);
    }
  }

  // Send and wait for a reply frame. Resolves with {cmd, payload} or null after all tries.
  async request(cmd, payload = new Uint8Array(0), { timeout = 2000, tries = 1, reply = [cmd], accept = null } = {}) {
    for (let a = 1; a <= tries; a++) {
      let w;
      const got = new Promise(resolve => { w = { cmds: reply, accept, resolve }; this.waiters.push(w); });
      await this.send(cmd, payload);
      const res = await Promise.race([got, sleep(timeout).then(() => null)]);
      if (res) return res;
      this.waiters = this.waiters.filter(x => x !== w);
      if (tries > 1) this.log(`${cmd.toString(16).toUpperCase()}: no reply (try ${a}/${tries}; notifications so far: ${this.rawCount ?? "n/a"})`, "warn");
    }
    return null;
  }

  async readStatus() {
    const r = await this.request(0xa0, new Uint8Array(0), { timeout: 2000, tries: 3, reply: [0xa0, 0xa1, 0xa3] });
    return r ? r.payload : null;
  }

  // Runtime V1.0.00 (disassembly): a match sets the link flag and sends a status frame; it sends no "A8 01".
  // A mismatch replies "A8 00". So success = A8 01 or a non-blank status; failure = A8 00 or no reply.
  async sendPassword(key) {
    if (!/^[\x20-\x7e]{4}$/.test(key)) throw new Error("the password must be 4 ASCII characters");
    const r = await this.request(0xa8, Uint8Array.from(key, c => c.charCodeAt(0)), {
      timeout: 2500, reply: [0xa8, 0xa0, 0xa1, 0xa3],
      accept: f => (f.cmd === 0xa8 ? f.payload[0] !== 0xff : f.payload.length >= 18 && !isBlankStatus(f.payload)),
    });
    const ok = !!r && (r.cmd !== 0xa8 || r.payload[0] === 1);
    if (ok && !this.authed) { this.authed = true; this.emit("auth", { ok: true }); }
    if (ok) store(`tsl6.key.${this.id}`, key);
    // Keep the boolean result; .reason tells "wrong" (A8 00) from "timeout" (no reply).
    this.lastPasswordResult = ok ? "ok" : r ? "wrong" : "timeout";
    return ok;
  }
  savedPassword() { return store(`tsl6.key.${this.id}`) || ""; }
  forgetPassword() { try { localStorage.removeItem(`tsl6.key.${this.id}`); } catch { /* storage blocked */ } }

  dropLink() {
    this.connected = false;
    this.authed = false;
    this.status = null;
    this.boot = null;
    for (const w of this.waiters.splice(0)) w.resolve(null);
    this.emit("state", { connected: false });
  }
}

// Web Bluetooth link.
export class WebLink extends LinkBase {
  constructor() { super(); this.device = null; this.chr = null; this.onDisc = () => { this.log("disconnected", "warn"); this.dropLink(); }; }

  static available() { return !!(globalThis.navigator && navigator.bluetooth); }

  // device: a device that the app already picked (the chooser also lists the H2 board, see app.js connect()).
  async open({ all = false, device = null } = {}) {
    const opts = all
      ? { acceptAllDevices: true, optionalServices: [SVC] }
      : { filters: [{ services: [SVC] }, { namePrefix: "TSL" }, { namePrefix: "FFKJ" }], optionalServices: [SVC] };
    this.device = device || await navigator.bluetooth.requestDevice(opts);
    this.device.addEventListener("gattserverdisconnected", this.onDisc);
    return this.attach();
  }

  async attach() {
    const d = this.device;
    this.name = d.name || "(no name)";
    this.id = d.id;
    this.emit("state", { connecting: true });
    const server = await d.gatt.connect();
    if (this.retired) throw new Error("this link was replaced by a new connection");
    const svc = await server.getPrimaryService(SVC);
    const chars = await svc.getCharacteristics();
    const short = c => { const u = String(c.uuid).toLowerCase(); return u.length > 8 ? u.slice(4, 8) : u.padStart(4, "0").slice(-4); }; // Bluefy gives "fff1", others the full UUID
    this.chr = chars.find(c => short(c) === "fff1") || chars.find(c => c.properties && c.properties.notify) || chars[0];
    const p = this.chr.properties;
    const props = p ? ["read", "write", "writeWithoutResponse", "notify", "indicate"].filter(k => p[k]).join(",") : "none reported";
    this.log(`service has ${chars.length} characteristic(s); using ${this.chr.uuid} (properties: ${props})`);
    this.rawCount = 0;
    this.chr.addEventListener("characteristicvaluechanged", e => {
      // The browser can hand the same characteristic object to a later link. Only the current link reads it.
      if (this.retired || e.target !== this.chr) return;
      const v = e.target.value;
      this.rawCount++;
      const bytes = v && v.buffer ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v || []);
      if (this.rawCount <= 3) this.log(`notify #${this.rawCount}: ${bytes.length} bytes`);
      this.receive(bytes);
    });
    await this.chr.startNotifications();
    this.log("notifications started");
    this.connected = true;
    this.log(`connected: ${this.name}`, "ok");
    this.emit("state", { connected: true });
  }

  async reconnect() { if (this.device) return this.attach(); throw new Error("no device"); }

  async rawWrite(part) {
    const c = this.chr;
    const p = c.properties;
    if ((!p || p.write) && typeof c.writeValueWithResponse === "function") await c.writeValueWithResponse(part);
    else if (typeof c.writeValueWithoutResponse === "function") await c.writeValueWithoutResponse(part);
    else await c.writeValue(part);
  }

  // A retired link shares the device with the new link, so it must not disconnect it.
  close() { if (!this.retired && this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }

  // A new connection replaces this link: it stops reading notifications and disconnect events,
  // and a reconnect that is still running fails. (Only for a link that is not connected.)
  retire() {
    this.retired = true;
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this.onDisc);
    this.connected = false;
    for (const w of this.waiters.splice(0)) w.resolve(null);
  }
}
