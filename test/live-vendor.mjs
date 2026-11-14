// Differential test: our live-data codec vs the vendor Mini App pages batteryInfo, debug and bleHost.
// The vendor code is not in this repo. Pass the path to the unpacked, pretty-printed vendor source root
// (the folder that holds app.js and pages/; the test also reads ../app/webview.app.js for the WXS helpers):
//   node test/live-vendor.mjs ~/.cache/tsl6-miniapp/pkg/src
// All fixtures are synthetic.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import * as L from "../public/lib/tsl6-live.js";

let src = process.argv[2];
if (!src) { console.error("usage: node test/live-vendor.mjs <vendor pkg/src folder>"); process.exit(2); }
if (path.basename(src) === "pages") src = path.dirname(src);

// ---------------------------------------------------------------- vendor harness

// Vendor files carry compiled template code after the require() line. Cut it off.
function vendorSource(rel, mod) {
  const code = fs.readFileSync(path.join(src, rel), "utf8");
  const cut = code.indexOf(`\nrequire("${mod}");`);
  if (cut < 0) throw new Error(`no require("${mod}") line in ${rel}`);
  return code.slice(0, cut);
}

// The real vendor app object (hex and UID helpers come from it, not from this repo).
function loadAppDef() {
  let def = null;
  vm.runInNewContext(vendorSource("app.js", "app.js"), {
    define: (_n, factory) => factory(() => ({}), {}, {}),
    App: d => { def = d; },
    console,
  }, { filename: "app.js" });
  return def;
}
const APP_DEF = loadAppDef();

// The WXS module that bleHost.wxml uses (formatmac, getRSSIVal), from the compiled webview chunk.
function loadBleHostWxs() {
  const js = fs.readFileSync(path.join(src, "..", "app", "webview.app.js"), "utf8");
  const m = js.match(/"m_\.\/pages\/bleHost\/bleHost\.wxml:wxs_ble":(np_\d+)/);
  const start = js.indexOf(`function ${m[1]}(){`);
  const endTok = "return nv_module.nv_exports;}";
  const fn = js.slice(start, js.indexOf(endTok, start) + endTok.length);
  return vm.runInNewContext(`${fn};${m[1]}()`, { nv_JSON: JSON });
}

function loadPage(name, opts = {}) {
  const sent = [], msgs = [], modals = [], inputs = [], timers = [], store = { ...(opts.store || {}) };
  const clock = { now: 0 };
  const transport = { tx: (type, buf) => sent.push({ type, buf: Array.from(buf || []) }), connIsOK: () => true };
  const app = Object.assign(Object.create(APP_DEF), {
    msg: (text, kind) => msgs.push({ text, kind }),
    msgClose() {},
    modal: (text, cancel, ok) => { modals.push(text); ok && ok({ confirm: true }); },
    input: (hint, cb) => { inputs.push(hint); cb({ content: opts.inputText ?? "" }); },
    index: { that: { show() {}, setNavigationBar() {} }, bleIsConn: true },
    batteryInfo: { that: null }, debug: { that: null }, bleHost: { that: null },
  });
  const req = n => {
    if (n.includes("toConsumableArray")) return a => Array.from(a);
    if (n.includes("601BF826")) return transport;
    if (n.includes("0FF8F134")) return { deviceinfo: { buf: opts.status || [] } };
    throw new Error("unexpected require " + n);
  };
  let def = null;
  const ctx = {
    define: (_n, factory) => factory(req, {}, {}),
    Page: d => { def = d; },
    getApp: () => app,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    Date: class { valueOf() { return clock.now; } },
    wx: {
      getStorageSync: k => store[k] ?? "",
      setStorageSync: (k, v) => { store[k] = v; },
      setKeepScreenOn() {},
    },
    console,
  };
  vm.runInNewContext(vendorSource(`pages/${name}/${name}.js`, `pages/${name}/${name}.js`), ctx, { filename: `${name}.js` });
  const page = Object.assign(Object.create(def), {
    data: structuredClone(def.data),
    var: structuredClone(def.var),
    setData(d) { if (d !== this.data) Object.assign(this.data, d); },
  });
  page.onLoad({});
  // Run the next queued timer with the page as `this`. Returns its delay.
  const tick = () => { const t = timers.shift(); if (!t) return null; t.fn.call(page); return t.ms; };
  return { page, sent, msgs, modals, inputs, timers, tick, store, clock };
}

// ---------------------------------------------------------------- helpers
let seed = 20261113;
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
const pick = a => a[rnd(a.length)];
const bytes = n => Array.from({ length: n }, () => rnd(256));
const arr = u => Array.from(u);
let checks = 0;
const seen = {}; // coverage counters, printed at the end
const see = k => { seen[k] = (seen[k] || 0) + 1; };
const eq = (a, b, msg) => { try { assert.deepEqual(a, b, msg); } catch (e) { console.error(msg, "\nours:  ", JSON.stringify(a), "\nvendor:", JSON.stringify(b)); throw e; } checks++; };

// ================================================================ battery

// 1. Requests: start, poll per tab, poll delays, stop.
{
  const v = loadPage("batteryInfo");
  v.page.onShow();
  eq(v.sent.shift(), { type: L.TYPE.BATTERY, buf: arr(L.BATTERY_START) }, "battery start");
  eq(v.timers[0].ms, L.BATTERY_FIRST_POLL_MS, "first poll delay");
  for (const tab of [0, 1, 2, 1, 0]) {
    v.page.select({ currentTarget: { dataset: { idx: tab } } });
    v.tick();
    eq(v.sent.shift(), { type: L.TYPE.BATTERY, buf: arr(L.batteryPoll(tab)) }, `poll tab ${tab}`);
    eq(v.timers[0].ms, L.batteryPollMs(tab), `poll delay tab ${tab}`);
  }
  v.page.onHide();
  eq(v.sent.shift(), { type: L.TYPE.BATTERY, buf: arr(L.BATTERY_STOP) }, "battery stop");
  v.tick();
  eq([v.sent.length, v.timers.length], [0, 0], "no poll after hide");
}

// Pack frame generator. Keeps the 32-bit counters below 2^31 and current raw != 32767
// (divergences on purpose, checked in section 5).
function packFrame() {
  const u = bytes(29 + rnd(4));
  u[7] &= 0x7f; u[11] &= 0x7f;
  if (u[2] === 0xff && u[3] === 0x7f) u[2] = 0xfe;
  switch (rnd(6)) {
    case 0: u[21] = 1; u[22] &= 0xfc; break; // factory capacity raw 1 ("设置")
    case 1: u[12] = 0xff; u[13] = 0xff; break; // remaining > full -> remaining 0
    case 2: u[12] = 0; u[13] = 0; break; // remaining 0 -> car SOC from the 7-bit field
    case 3: { // realistic pack
      const put16 = (o, v) => { u[o] = v & 255; u[o + 1] = v >> 8; };
      put16(0, 38000 + rnd(3000)); put16(2, (65536 - rnd(800)) & 0xffff);
      put16(12, 2000 + rnd(500)); put16(14, 2500 + rnd(100)); put16(16, 200 + rnd(100));
      break;
    }
    default: break;
  }
  return u;
}

function vendorRows(list) {
  return Array.from(list, r => ({ zh: r.name, text: r.val, max: !!r.max })); // Array.from: the vendor array is from another realm
}
function ourRows(view) {
  return view.rows.map(r => ({ zh: r.zh, text: r.text, max: !!r.max }));
}

// 2. Pack decode and view, with and without the factory-capacity override.
for (let n = 0; n < 4000; n++) {
  const override = pick([undefined, 0, 51.3, 75, -2, 0.1]);
  const v = loadPage("batteryInfo", { store: override === undefined ? {} : { battFull: override } });
  const f = packFrame();
  v.page.rx(208, Uint8Array.from(f));
  const view = L.batteryPackView(L.decodeBatteryPack(f), override ?? "");
  eq(ourRows(view), vendorRows(v.page.data.list[0]), `pack rows #${n} ${f}`);
  eq(view.odometerText, v.page.data.odometer, `odometer #${n}`);
  for (const r of view.rows) {
    if (r.text === "设置") see("pack: capacity unknown");
    if (r.id === "socReal") see("pack: real SOC row");
    if (r.text.startsWith("NaN")) see("pack: NaN SOC");
  }
  if (!view.rows.some(r => r.id === "energyRemain")) see("pack: no remaining row");
}

// 3. Cell voltages: sequences of D1 frames after the tab tap, including dropouts and falling values.
for (let run = 0; run < 300; run++) {
  const v = loadPage("batteryInfo");
  v.page.onShow();
  v.page.select({ currentTarget: { dataset: { idx: 1 } } });
  const st = L.resetCells();
  const groups = 1 + rnd(40);
  for (let n = 0; n < 120; n++) {
    const f = [rnd(groups), rnd(256)];
    for (let k = 0; k < 3; k++) {
      const mv = pick([0, 0, 3, rnd(65536), 30000 + rnd(12000), 40000 + rnd(500)]);
      f.push(mv & 255, mv >> 8);
    }
    v.page.rx(209, Uint8Array.from(f));
    L.applyCellGroup(st, f);
    const d = v.page.data;
    eq([st.reading, st.maxText, st.minText, st.avgText, st.deltaText],
      [d.index, String(d.maxVol), String(d.minVol), String(d.avgVol), String(d.imbVol)], `cells summary run ${run} #${n}`);
    const vc = [], oc = [];
    d.list[1].forEach((c, i) => vc.push([i, c.name, c.val, !!c.max, !!c.min]));
    st.cells.forEach((c, i) => oc.push([i, `Cell ${c.cell}`, c.text, !!c.max, !!c.min]));
    eq(oc, vc, `cells list run ${run} #${n}`);
  }
}

// 4. DC-DC.
for (let n = 0; n < 3000; n++) {
  const v = loadPage("batteryInfo");
  const f = bytes(8 + rnd(3));
  v.page.rx(210, Uint8Array.from(f));
  eq(ourRows(L.dcdcView(L.decodeDcdc(f))), vendorRows(v.page.data.list[2]), `dcdc #${n}`);
}

// 5. Divergences on purpose (vendor bugs we do not copy).
{
  const f = packFrame();
  f[2] = 0xff; f[3] = 0x7f; // current raw 32767
  const v = loadPage("batteryInfo");
  v.page.rx(208, Uint8Array.from(f));
  eq(v.page.data.list[0][1].val, "3276.9 A", "vendor shows +3276.9 A for raw 32767");
  eq(L.batteryPackView(L.decodeBatteryPack(f)).rows[1].text, "-3276.7 A", "we show -3276.7 A");

  const g = packFrame();
  g[8] = 0; g[9] = 0; g[10] = 0; g[11] = 0x80; // charged = 2^31 x 0.001 kWh
  const w = loadPage("batteryInfo");
  w.page.rx(208, Uint8Array.from(g));
  eq(w.page.data.list[0][3].val, "-2147483.65 KWH", "vendor reads the counter as signed");
  eq(L.batteryPackView(L.decodeBatteryPack(g)).rows[3].text, "2147483.65 KWH", "we read it as unsigned");
}

// 6. Factory capacity tap: any value tap asks for kWh; a number is stored as battFull.
{
  const v = loadPage("batteryInfo", { inputText: "60.5" });
  v.page.ccrlSet({});
  eq([v.inputs.length, v.store.battFull], [1, 60.5], "tap stores battFull");
  const f = packFrame();
  v.page.rx(208, Uint8Array.from(f));
  eq(ourRows(L.batteryPackView(L.decodeBatteryPack(f), 60.5)), vendorRows(v.page.data.list[0]), "override shown");
  const w = loadPage("batteryInfo", { inputText: "abc" });
  w.page.ccrlSet({});
  eq([w.msgs[0].text, w.store.battFull], ["必须输入数字", undefined], "non-number is refused");
}

// ================================================================ debug

const btn = (fun, extra = {}) => ({ type: "tap", currentTarget: { dataset: { fun } }, detail: {}, ...extra });

// 7. Mode commands.
{
  const v = loadPage("debug");
  v.page.onShow();
  v.page.btn(btn("pause"));
  v.page.btn(btn("btnrx", { type: "longpress" }));
  v.page.onHide();
  v.page.onUnload();
  eq(v.sent, [L.DEBUG_MODE.PAUSE, L.DEBUG_MODE.PAUSE, L.DEBUG_MODE.ALL, L.DEBUG_MODE.OFF, L.DEBUG_MODE.OFF]
    .map(m => ({ type: L.TYPE.DEBUG, buf: arr(L.debugMode(m)) })), "debug mode bytes");
  eq(v.msgs[0].text, "接收所有ID数据", "receive-all toast");
}

// 8. Filter and send text parsing (valid and invalid input).
const hexChars = "0123456789abcdefABCDEF";
const tok = () => pick([
  () => Array.from({ length: pick([3, 4, 3, 4, 1, 2, 5]) }, () => pick([...hexChars])).join(""),
  () => Array.from({ length: 2 }, () => pick([...hexChars])).join(""),
  () => pick(["", "g1", "12 ", "7Z", " "]),
])();
for (let n = 0; n < 3000; n++) {
  // receive filter
  const ids = Array.from({ length: 1 + rnd(4) }, () => (rnd(5) ? pick([
    () => rnd(0x800).toString(16).padStart(3, "0"),
    () => rnd(0x10000).toString(16).padStart(4, "0").toUpperCase(),
  ])() : tok())).join(",");
  const r = loadPage("debug");
  r.page.btn(btn("inputrx", { detail: { value: ids } }));
  r.page.btn(btn("btnrx"));
  const o = L.parseDebugFilterText(ids);
  see(o.error ? "filter: refused" : "filter: sent");
  if (o.error) eq([r.sent.length, r.msgs[0].text], [0, o.error.zh], `filter error "${ids}"`);
  else eq(r.sent, [{ type: L.TYPE.DEBUG, buf: arr(o.payload) }], `filter "${ids}"`);

  // send
  const data = Array.from({ length: rnd(11) }, () => (rnd(8) ? hex2() : tok())).join(pick([" ", " ", " ", "  "]));
  const text = pick([
    () => `${rnd(0x800).toString(16).padStart(3, "0")},${data}`,
    () => `${tok()},${data}`,
    () => `${rnd(0x10000).toString(16).padStart(4, "0")},${data},${tok()}`,
    () => data,
  ])();
  const s = loadPage("debug");
  s.page.btn(btn("inputtx", { detail: { value: text } }));
  s.page.btn(btn("btntx"));
  const p = L.parseDebugSendText(text);
  see(p.error ? `send: ${p.error.en}` : "send: sent");
  if (p.error) eq([s.sent.length, s.msgs[0].text], [0, p.error.zh], `send error "${text}"`);
  else eq(s.sent, [{ type: L.TYPE.DEBUG, buf: arr(p.payload) }], `send "${text}"`);
}
function hex2() { return rnd(256).toString(16).padStart(2, "0"); }

// 9. Received frames: log text, gap times, 999-line cap.
{
  const v = loadPage("debug");
  let text = [], last = 0, nLine = 0;
  for (let n = 0; n < 1010; n++) {
    v.clock.now += pick([0, 1, 7, 100, 12000]);
    const f = Uint8Array.from(bytes(2 + rnd(9)));
    v.page.rx(192, f);
    const fr = L.decodeDebugFrame(f);
    assert.equal(fr.id, (f[0] << 8) | f[1]);
    nLine = nLine + 1 >= 99999 ? 0 : nLine + 1;
    text.push(L.formatDebugLine(nLine, f, v.clock.now - last));
    last = v.clock.now;
    if (text.length >= 1000) text.shift();
    if (n % 50 === 0 || n > 995) eq(text.join(""), v.page.data.text, `debug log #${n}`);
  }
  eq(text.length, 999, "log keeps 999 lines");
  v.page.var.textidx = 99997;
  for (const want of [99998, 0, 1]) {
    v.page.rx(192, Uint8Array.of(1, 2, 3));
    eq(v.page.data.text.split("\r\n").at(-2).split(".")[0], String(want), `line number wraps (${want})`);
  }
}

// ================================================================ bleHost

const STATUS = Uint8Array.from([0, 0x12, 0x10, 1, ...Array.from({ length: 14 }, (_, i) => 0xa0 + i), ...new Array(58).fill(0)]);
const UID = L.uid14FromStatus(STATUS);
const MACS = Array.from({ length: 8 }, (_, i) => [0x10 + i, 0x22, 0x33, 0x44, 0x55, 0xc0 + i]);
const name24 = () => {
  const s = pick(["BTN-1", "按钮A", "", "Remote key", "\u{1F697}car"]);
  const b = pick([
    () => [...new TextEncoder().encode(s)],
    () => [0xff, 0xfe, 0x41], // not UTF-8
    () => [0xef, 0xbb, 0xbf, 0x42], // BOM
  ])();
  return [...b, ...new Array(24).fill(0)].slice(0, 24);
};
const scanFrame = (mac, flag = 1) => [3, flag, rnd(256), rnd(2), ...mac, ...name24()];
function listFrame(macs, size = 33, flag = rnd(2)) {
  const recs = macs.flatMap(m => {
    const r = [pick([0x80, 0xc5, 0xb0]), pick([0, 50, 120]), rnd(2), ...m, ...name24()];
    return [...r, ...new Array(size - 33).fill(0x77)];
  });
  return [4, flag, macs.length, ...recs, rnd(256), rnd(256), rnd(256), 0x5a];
}
const ourList = st => Object.fromEntries(Object.entries(st).map(([k, d]) => [k, { name: d.name, rssi: d.rssi, addrType: d.addrType, ...(d.battery !== undefined ? { battValue: d.battery } : {}) }]));
const vendorList = l => Object.fromEntries(Object.entries(l).map(([k, d]) => [k, { ...d, name: d.name.replace(/\0+$/, "") }]));

// 10. Requests: open, poll, scan toggle, stop on hide.
{
  const v = loadPage("bleHost", { status: STATUS });
  v.page.onShow();
  eq(v.sent.shift(), { type: L.TYPE.BLE_HOST, buf: arr(L.bleHostScanStart(UID)) }, "scan starts on show");
  eq(v.tick(), 200, "first list poll after 200 ms");
  eq(v.sent.shift(), { type: L.TYPE.BLE_HOST, buf: arr(L.bleHostList(UID)) }, "list poll");
  eq(v.timers[0].ms, 1000, "list poll every 1 s");
  v.page.btn(btn("find"));
  eq(v.sent.shift().buf, arr(L.bleHostScanStart(UID)), "search button starts scan");
  v.page.btn(btn("find"));
  eq(v.sent.shift().buf, arr(L.bleHostScanStop(UID)), "search button stops scan");
  v.page.onHide();
  eq(v.sent.shift().buf, arr(L.bleHostScanStop(UID)), "scan stops on hide");
  eq(arr(L.uid14FromStatus([1, 2, 3])), new Array(14).fill(0), "short status gives zero UID");
}

// 11. Scan and list replies change the lists the same way; pair and delete send the same bytes.
for (let run = 0; run < 400; run++) {
  const v = loadPage("bleHost", { status: STATUS });
  const st = L.createBleHostState();
  for (let n = 0; n < 30; n++) {
    const f = rnd(4) ? scanFrame(pick(MACS), rnd(2)) : listFrame(MACS.filter(() => !rnd(3)).slice(0, 4), pick([33, 33, 36]));
    if (!rnd(15)) f[f.length - 1] = 0x00; // list without the 0x5A end mark (ignored), or a scan name byte
    v.page.rx(Uint8Array.from(f));
    L.applyBleHost(st, f);
    eq(ourList(st.found), vendorList(v.page.data.bleFindList), `found list run ${run} #${n}`);
    eq(ourList(st.paired), vendorList(v.page.data.bleBondList), `paired list run ${run} #${n}`);
    eq(st.scanning, v.page.data.loading, `scanning flag run ${run} #${n}`);
  }
  const foundMac = Object.keys(st.found)[0];
  if (foundMac) {
    v.sent.length = 0;
    v.page.btn(btn("conn", { currentTarget: { dataset: { fun: "conn", mac: foundMac } } }));
    const d = st.found[foundMac];
    see(d.nameBytes.length ? "ble: pair with name" : "ble: pair without name");
    eq(v.sent, [{ type: L.TYPE.BLE_HOST, buf: arr(L.bleHostPair(UID, d.addrType, foundMac, d.nameBytes)) }], `pair ${foundMac}`);
  }
  const pairedMac = Object.keys(st.paired)[0];
  if (pairedMac) {
    v.sent.length = 0;
    v.page.btn(btn("del", { currentTarget: { dataset: { fun: "del", mac: pairedMac } } }));
    eq(v.modals.at(-1), "确定要删除此蓝牙设备吗?", "delete asks first");
    eq(v.sent, [{ type: L.TYPE.BLE_HOST, buf: arr(L.bleHostDelete(UID, st.paired[pairedMac].addrType, pairedMac)) }], `delete ${pairedMac}`);
  }
}

// 12. Status codes.
for (let code = 0; code < L.BLE_HOST_STATUS.length; code++) {
  const v = loadPage("bleHost", { status: STATUS });
  v.page.rx(Uint8Array.of(6, 0, code));
  const r = L.decodeBleHost([6, 0, code]);
  eq([r.status.zh, r.status.kind], [v.msgs[0].text, v.msgs[0].kind], `status ${code}`);
}

// 13. Template helpers: reversed MAC and signal bars.
{
  const wxs = loadBleHostWxs();
  for (const m of MACS) {
    const mac = L.hex(m, ":");
    eq(L.macDisplay(mac), wxs.nv_formatmac({ nv_split: s => mac.split(s) }), `formatmac ${mac}`); // WXS strings use nv_ method names
  }
  for (let rssi = -128; rssi <= 0; rssi++) {
    let lit = 0;
    for (let i = 0; i < 6; i++) if (wxs.nv_getRSSIVal(i, rssi)) lit++;
    eq(L.rssiBars(rssi), lit, `signal bars ${rssi}`);
  }
}

console.log("coverage:", JSON.stringify(seen));
console.log(`live-vendor: ${checks} checks passed`);
