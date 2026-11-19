// Link to the BLE board (firmware "scrl-ble-board": the NanoH2 and the hypery ESP32 boards).
//
// ScrlLink has the same API as the TSL6 link (ble.js), so the pages work with both. It gives the pages a status in the
// TSL6 layout and takes the TSL6 commands that the board can do (lib/scrl-tsl6.js). It refuses every other command.
// The things that only the board has are on link.board and the methods below it.
//
// The board needs Bluetooth pairing. Its first protected read starts it: the phone asks for the 6-digit passkey.
// This app never sees the passkey at pairing.
import { LinkBase, platformChunk } from "./ble.js";
import * as SC from "../lib/scrl.js";
import { h2Status, h2SettingsWrite, H2_DEFAULTS } from "../lib/scrl-tsl6.js";
import { h2SetBoardSettings, h2SetIntervalMax } from "../lib/h2-menus.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Error text with the DOMException name and code. Bluefy can throw a bare number, or an Error with only "2".
function errText(e) {
  if (e == null || typeof e !== "object") return `${e} (${typeof e})`;
  const name = e.name && e.name !== "Error" ? `${e.name} ` : "";
  const code = e.code !== undefined && e.code !== 0 ? ` [code ${e.code}]` : "";
  return `${name}${e.message || String(e)}${code}`;
}
// Run one step of the session. On an error: log the bytes that the board sent (Status and Settings hold no secret),
// then throw an Error that starts with the step name. e.step holds the name.
async function step(name, fn, bytes) {
  try { return await fn(); } catch (e) {
    const err = new Error(`${name}: ${errText(e)}`);
    err.step = e && e.step ? `${name}: ${e.step}` : name;
    if (bytes) err.bytes = `${bytes.length} bytes: ${dec.decode(bytes).slice(0, 600)}`;
    throw err;
  }
}
const enc = new TextEncoder(), dec = new TextDecoder();
const O = SC.OTA;

function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { /* storage blocked */ }
  return null;
}

// True for a device that the chooser returned and that is the board (by its advertised name).
export const isH2Name = name => /^SCRL-/.test(name || "");

// ---------------------------------------------------------------- Web Bluetooth transport
// One GATT operation runs at a time. Bluefy does not report characteristic properties, so they are never read.
export class GattTransport {
  constructor(device) {
    this.device = device; this.chr = {}; this.queue = Promise.resolve(); this.gen = 0; this.onDisconnect = () => {};
    this.onGone = () => this.onDisconnect();
    device.addEventListener("gattserverdisconnected", this.onGone);
  }
  get name() { return this.device.name || "BLE board"; }
  get connected() { return !!(this.device.gatt && this.device.gatt.connected); }
  async open() {
    const U = SC.UUIDS;
    this.gen++;
    this.queue = Promise.resolve();
    // Each call names itself in its error: some browsers (Bluefy) give only a number as the message.
    const server = await step("connect", () => this.device.gatt.connect());
    const svc = await step("service", () => server.getPrimaryService(U.service));
    for (const name of Object.keys(U)) {
      if (name !== "service") this.chr[name] = await step(`characteristic ${name}`, () => svc.getCharacteristic(U[name]));
    }
  }
  op(fn) { const job = this.queue.then(fn); this.queue = job.catch(() => {}); return job; }
  read(name) {
    return this.op(async () => { const v = await this.chr[name].readValue(); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); });
  }
  write(name, bytes, noResponse = false) {
    return this.op(async () => {
      const c = this.chr[name];
      if (noResponse && typeof c.writeValueWithoutResponse === "function") await c.writeValueWithoutResponse(bytes);
      else if (!noResponse && typeof c.writeValueWithResponse === "function") await c.writeValueWithResponse(bytes);
      else await c.writeValue(bytes);
    });
  }
  subscribe(name, cb) {
    const gen = this.gen;
    return this.op(async () => {
      const c = this.chr[name];
      c.addEventListener("characteristicvaluechanged", e => {
        // The browser can hand the same characteristic object to a later connection. Only the current one reads it.
        if (gen !== this.gen || e.target !== this.chr[name]) return;
        const v = e.target.value;
        cb(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      await c.startNotifications();
    });
  }
  close() { if (this.connected) this.device.gatt.disconnect(); }
  // A new link replaces this one. Stop its listeners too: the browser can give the new link the same
  // characteristic objects, and then each notification would arrive two times.
  detach() { this.gen++; this.device.removeEventListener("gattserverdisconnected", this.onGone); this.onDisconnect = () => {}; }
}

// ---------------------------------------------------------------- link
export class ScrlLink extends LinkBase {
  constructor(transport) {
    super();
    this.kind = "h2";
    this.t = transport;
    this.name = transport.name;
    this.chunk = +store("tsl6.h2chunk") || platformChunk(); // bytes per write of the firmware update
    this.board = { info: null, status: null, statusAt: 0, settings: null, live: null, flags: 0 };
    this.updating = false; this.expectRestart = false; this.pollTimer = 0;
    this.otaWaiters = []; this.otaCredit = 0; this.otaStopped = null;
    transport.onDisconnect = () => this.onGone();
  }
  setChunk(n) { this.chunk = n; store("tsl6.h2chunk", String(n)); }
  has(flag) { return (this.board.flags & flag) !== 0; }

  // ---- connection
  async open() {
    this.emit("state", { connecting: true });
    this.t0 = Date.now();
    await step("GATT connect", () => this.t.open());
    this.log(`board: GATT connected, characteristics found ${this.since()}`);
    if (this.retired) throw new Error("this link was replaced by a new connection");
    await this.session();
  }
  async reconnect() { return this.open(); }
  // Time since the connect started, for the log: the board drops a link that is not authenticated after 30 s.
  since() { return `(+${((Date.now() - (this.t0 || Date.now())) / 1000).toFixed(1)} s)`; }

  // After the GATT connection: Info is open. The first Status read starts the pairing. The board drops a link that
  // is not authenticated after 30 s, so read at once and try again until the read works or the link drops.
  async session() {
    const t = this.t, B = this.board;
    B.info = null; B.status = null; B.live = null; B.flags = 0;
    try { B.info = JSON.parse(dec.decode(await t.read("info"))); this.log(`board: Info read ${this.since()}`); }
    catch (e) { this.log(`board: Info read failed ${this.since()}: ${errText(e)}`, "warn"); }
    h2SetIntervalMax(SC.intervalMax(B.info));
    // A paired phone gets the answer at once. Show the pairing hint only when the read fails or takes long.
    let hinted = false;
    const hint = () => { if (!hinted) { hinted = true; this.emit("pairing", {}); } };
    const slow = setTimeout(hint, 2000);
    let first = null, lastErr = null;
    const until = Date.now() + 45000;
    while (!first && t.connected && Date.now() < until) {
      try { first = await t.read("status"); } catch (e) {
        lastErr = e;
        this.log(`board: Status read failed ${this.since()}: ${errText(e)}`, "warn");
        hint();
        await sleep(1500);
      }
    }
    clearTimeout(slow);
    if (!first) {
      const e = new Error(t.connected ? `no secure link (${lastErr ? lastErr.message : "no answer"})` : "the board dropped the link");
      e.pairing = true;
      throw e;
    }
    // Each later step names itself in its error: the connect dialog and the log then show the step that failed.
    this.log(`board: Status read, ${first.length} bytes ${this.since()}`);
    await step("Status data", () => this.takeStatus(first), first);
    let raw = null;
    await step("Settings read", async () => { raw = await t.read("settings"); });
    this.log(`board: Settings read ${this.since()}`);
    await step("Settings data", () => { B.settings = SC.parseSettings(dec.decode(raw)); h2SetBoardSettings(B.settings); }, raw);
    // The subscriptions need the authenticated link, so they come after the first good read.
    await step("Live subscribe", () => t.subscribe("live", b => { try { this.takeLive(SC.parseLive(b)); } catch (e) { this.log(`board: ${e.message}`, "warn"); } }));
    await step("Log subscribe", () => t.subscribe("log", b => this.log(`board: ${dec.decode(b)}`)));
    await step("Update subscribe", () => t.subscribe("otaCtrl", b => { try { this.onOtaEvent(SC.parseOtaEvent(b)); } catch (e) { this.log(`board: ${e.message}`, "warn"); } }));
    this.connected = true;
    this.authed = true;
    this.log(`connected: ${this.name} (${SC.boardName(B.info)}${B.info && B.info.fw ? `, firmware ${B.info.fw}` : ""})`, "ok");
    this.emit("state", { connected: true });
    this.pushStatus(true);
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { if (this.connected && !this.updating) this.refresh().catch(() => {}); }, 5000);
  }

  onGone() {
    clearInterval(this.pollTimer);
    for (const w of this.otaWaiters.splice(0)) w.resolve(null);
    if (this.expectRestart) { this.connected = false; return; } // the update reconnects
    if (this.connected) this.log("disconnected", "warn");
    this.dropLink();
  }
  close() { this.expectRestart = false; this.t.close(); }
  // A new connection replaces this link.
  retire() {
    this.retired = true;
    clearInterval(this.pollTimer);
    this.t.detach?.();
    this.connected = false;
    for (const w of this.waiters.splice(0)) w.resolve(null);
  }

  // ---- board state
  takeStatus(bytes) {
    const B = this.board;
    B.status = SC.parseStatus(dec.decode(bytes));
    B.statusAt = Date.now();
    // This read is the newest data: take all 16 flag bits from it. A Live record that comes later (once per
    // second) then replaces the low byte. The last Live record is older than this read and must not win.
    B.flags = B.status.flags;
  }
  takeLive(live) {
    const B = this.board;
    B.live = live;
    B.flags = SC.mergeFlags(B.status ? B.status.flags : 0, live.flagsLow);
    this.pushStatus(false);
  }
  // Give the pages a new status only when its bytes change: the Car tab rebuilds on each status event.
  pushStatus(force) {
    const B = this.board;
    if (B.status && B.settings) {
      const p = h2Status(B);
      const same = this.status && p.length === this.status.length && p.every((v, i) => v === this.status[i]);
      if (force || !same) { this.status = p; this.emit("status", p); }
    }
    this.emit("board", B);
  }
  // Read Status and Settings again.
  async refresh() {
    this.takeStatus(await this.t.read("status"));
    this.board.settings = SC.parseSettings(dec.decode(await this.t.read("settings")));
    h2SetBoardSettings(this.board.settings);
    this.pushStatus(true);
    return this.status;
  }
  async readStatus() {
    if (!this.connected) return null;
    try { return await this.refresh(); } catch (e) { this.log(`board: status read failed: ${e.message}`, "bad"); return null; }
  }

  // ---- TSL6 commands that the board can do
  frame(cmd, payload) {
    const fr = { cmd, payload: payload instanceof Uint8Array ? payload : Uint8Array.from(payload || []) };
    this.emit("frame", fr);
    this.emit(`frame:${cmd}`, fr);
    return fr;
  }
  async exec(cmd, payload = new Uint8Array(0)) {
    if (!this.connected) throw new Error("not connected");
    switch (cmd) {
      case 0xa0: { const p = await this.refresh(); return this.frame(0xa0, p); }
      case 0xa1: // AP assist on/off = Scroll Ack on/off
        await this.writeSettings({ enabled: payload[0] === 1 });
        return this.frame(0xa1, payload);
      case 0xa3: { // settings write: only the fields that the board has
        const change = h2SettingsWrite(this.status, payload);
        if (Object.keys(change).length) await this.writeSettings(change); else await this.refresh();
        return this.frame(0xa0, this.status);
      }
      case 0xa4: // restore defaults: the settings only. The bonds and the passkey stay.
        await this.writeSettings(SC.settingsDiff(this.board.settings, H2_DEFAULTS));
        return this.frame(0xa4, payload);
      case 0xa5: // restart
        await this.command(SC.CMD.REBOOT);
        return this.frame(0xa5, payload);
      case 0xb0: // gauge stream: the board has none. The Car tab reads the Live record.
        return null;
      default:
        throw new Error(`the board has no command ${cmd.toString(16).toUpperCase()}`);
    }
  }
  async send(cmd, payload) { await this.exec(cmd, payload); }
  async request(cmd, payload) { return this.exec(cmd, payload); }
  // The board has no BLE password. The phone pairs with it.
  async sendPassword() { return true; }
  savedPassword() { return ""; }
  forgetPassword() {}

  // ---- board-only actions
  // Write board settings (only the given keys), then read back what the board holds: it clamps and can refuse.
  async writeSettings(change) {
    if (Object.keys(change).length) {
      this.log(`board: settings write ${JSON.stringify(change)}`);
      await this.t.write("settings", enc.encode(JSON.stringify(change)));
    }
    await this.refresh();
    return this.board.settings;
  }
  async command(code) {
    this.log(`board: command ${code.toString(16).padStart(2, "0").toUpperCase()}`);
    await this.t.write("command", Uint8Array.of(code));
  }
  // The log line never holds the digits: the Log page offers a copy of the log.
  async setPasskey(text) {
    this.log("board: set-passkey command");
    await this.t.write("command", SC.passkeyCommand(text));
  }
  async confirmImage() {
    await this.command(SC.CMD.CONFIRM_IMAGE);
    await this.refresh();
    return !this.has(SC.FLAG.IMAGE_PENDING);
  }
  // Seconds until an unconfirmed image goes back to the old one.
  pendingLeft() {
    const B = this.board;
    if (!B.status) return 0;
    const up = B.status.uptime + Math.floor((Date.now() - B.statusAt) / 1000);
    return Math.max(0, O.CONFIRM_MS / 1000 - up);
  }

  // ---- firmware update (protocol: scrl_ota.h in the firmware)
  onOtaEvent(ev) {
    const i = this.otaWaiters.findIndex(w => w.accept(ev));
    if (i >= 0) this.otaWaiters.splice(i, 1)[0].resolve(ev);
    else if (ev.event === O.EVT_CREDIT) this.otaCredit = Math.max(this.otaCredit, ev.offset);
    else if (ev.event === O.EVT_STOPPED) this.otaStopped = ev;
  }
  // Arm the waiter before the write: the board notifies from inside its write handler.
  waitOta(accept, timeout) {
    let w;
    const got = new Promise(resolve => { w = { accept, resolve }; this.otaWaiters.push(w); });
    return Promise.race([got, sleep(timeout).then(() => { this.otaWaiters = this.otaWaiters.filter(x => x !== w); return null; })]);
  }

  // Send an image. image = { bytes, sha }. hooks: onText(text), onProgress(sent, size), aborted() -> bool.
  // Resolves { pending } after the board is back. Throws an Error with the reason; e.smaller is true when the
  // next try must use fewer bytes per write (the link then already has the smaller size in .chunk).
  async update(image, hooks = {}) {
    const say = t => { this.log(`board update: ${t}`); if (hooks.onText) hooks.onText(t); };
    const t = this.t, size = image.bytes.length, chunk = this.chunk;
    if (this.updating) throw new Error("an update runs");
    this.updating = true; this.otaCredit = 0; this.otaStopped = null;
    let begun = false; // the board accepted BEGIN and END is not sent: an error must send ABORT
    const smaller = () => {
      const next = SC.nextChunk(chunk);
      if (next) this.setChunk(next);
      return next;
    };
    const fail = (text, { cut = false } = {}) => {
      const e = new Error(text);
      if (cut) { const next = smaller(); e.smaller = !!next; e.nextChunk = next; }
      throw e;
    };
    try {
      say("the board prepares the update");
      let wait = this.waitOta(e => e.event === O.EVT_BEGIN || e.event === O.EVT_STOPPED, 20000);
      await t.write("otaCtrl", SC.otaBegin(size, image.sha));
      let ev = await wait;
      if (!ev) fail("the board did not answer the start request");
      if (ev.status !== SC.OTA_ERR.OK) fail(SC.otaErrText(ev.status));
      begun = true;
      if (hooks.onBegun) hooks.onBegun();

      let sent = 0;
      while (sent < size) {
        if (hooks.aborted && hooks.aborted()) fail("you aborted the update");
        if (this.otaStopped) fail(SC.otaErrText(this.otaStopped.status));
        const n = Math.min(chunk, size - sent);
        if (!SC.mayWrite(sent, n, this.otaCredit)) {
          // The window is full. Wait for the next CREDIT, or stop when the board is silent.
          ev = await this.waitOta(e => e.event === O.EVT_CREDIT || e.event === O.EVT_STOPPED, 10000);
          if (!ev) fail(`the board sent no credit for 10 s. A write of ${chunk} bytes can be too long for this link`, { cut: true });
          if (ev.event === O.EVT_STOPPED) fail(SC.otaErrText(ev.status));
          this.otaCredit = Math.max(this.otaCredit, ev.offset);
        }
        if (!SC.creditIsWhole(this.otaCredit, chunk, size)) fail(`the link cut a write of ${chunk} bytes`, { cut: true });
        if (!SC.mayWrite(sent, n, this.otaCredit)) continue;
        try {
          await t.write("otaData", image.bytes.subarray(sent, sent + n), true);
        } catch (e) {
          // A browser can refuse a write that is too long for the link.
          if (!t.connected) fail("the board disconnected");
          fail(`the browser refused a write of ${n} bytes (${e.message})`, { cut: true });
        }
        sent += n;
        if (hooks.onProgress) hooks.onProgress(sent, size);
      }
      if (hooks.onSent) hooks.onSent();
      // The last CREDIT has the full size: every byte is in the flash.
      const deadline = Date.now() + 15000;
      while (this.otaCredit < size) {
        if (this.otaStopped) fail(SC.otaErrText(this.otaStopped.status));
        if (Date.now() > deadline) fail(`the board has ${this.otaCredit} of ${size} bytes: writes of ${chunk} bytes were cut or lost`, { cut: true });
        ev = await this.waitOta(e => e.event === O.EVT_CREDIT || e.event === O.EVT_STOPPED, 2000);
        if (ev && ev.event === O.EVT_STOPPED) fail(SC.otaErrText(ev.status));
        if (ev) this.otaCredit = Math.max(this.otaCredit, ev.offset);
      }
      say("the board checks the image");
      this.expectRestart = true; // the board restarts about 1.5 s after a good END
      wait = this.waitOta(e => e.event === O.EVT_END || e.event === O.EVT_STOPPED, 60000);
      begun = false; // from here the board ends the update by itself, good or bad
      await t.write("otaCtrl", Uint8Array.of(O.OP_END));
      ev = await wait;
      if (ev && ev.status !== SC.OTA_ERR.OK) fail(SC.otaErrText(ev.status));
      if (!ev && t.connected) fail("the board did not answer the end request");
      return await this.afterUpdate(say);
    } catch (e) {
      this.expectRestart = false;
      // Whatever went wrong after BEGIN: the board must leave the update now, not after its 30 s timeout.
      if (begun && t.connected) { try { await t.write("otaCtrl", Uint8Array.of(O.OP_ABORT)); } catch { /* the link is gone */ } }
      this.log(`board update stopped: ${e.message}`, "bad");
      if (!t.connected && this.connected) this.dropLink();
      throw e;
    } finally {
      this.updating = false;
      if (this.connected) this.refresh().catch(() => {});
    }
  }
  // The board restarts into the new image. Connect to the same device again, without a new chooser.
  async afterUpdate(say) {
    say("the board restarts into the new image");
    const t = this.t;
    const gone = Date.now() + 8000;
    while (t.connected && Date.now() < gone) await sleep(200);
    t.close();
    this.connected = false;
    this.emit("state", { connecting: true });
    await sleep(1500);
    const until = Date.now() + 40000;
    let lastErr = null;
    while (Date.now() < until) {
      try {
        this.t0 = Date.now();
        await t.open();
        this.expectRestart = false;
        await this.session();
        return { pending: this.has(SC.FLAG.IMAGE_PENDING) };
      } catch (e) { lastErr = e; t.close(); await sleep(2000); }
    }
    this.expectRestart = false;
    this.dropLink();
    throw new Error(`the board did not come back (${lastErr ? lastErr.message : "no answer"}). Connect again, then confirm the image. Without a confirm it goes back to the old image after 10 minutes`);
  }
}
