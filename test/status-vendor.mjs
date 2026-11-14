// Differential test: our status codec vs the vendor Mini App Status tab, Me tab and Settings action buttons.
// The vendor code is not in this repo. Pass the path to the unpacked, pretty-printed index.js:
//   node test/status-vendor.mjs ~/.cache/tsl6-miniapp/pkg/src/pages/index/index.js
// The test finds the other vendor files from that path:
//   <src>/pages/my/my.js, <src>/pages/set/set.js, <src>/app.js, <src>/0FF8F134...js,
//   <pkg>/app/webview.app.js (WXS module with getVehicleType), <pkg>/../wxml/pages/{index,set,my}/*.wxml (decompiled templates).
// It runs the vendor page handlers in node:vm with stubbed wx/BLE, and compares the frames they send with our builders.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import * as S from "../public/lib/tsl6-status.js";

const indexJs = process.argv[2];
if (!indexJs) { console.error("usage: node test/status-vendor.mjs <vendor pages/index/index.js>"); process.exit(2); }
const SRC = path.resolve(path.dirname(indexJs), "../..");
const PKG = path.resolve(SRC, "..");
const FILES = {
  index: path.resolve(indexJs),
  my: path.join(SRC, "pages/my/my.js"),
  set: path.join(SRC, "pages/set/set.js"),
  app: path.join(SRC, "app.js"),
  dev: path.join(SRC, "0FF8F134BD32C12F699E993320513A93.js"),
  wxs: path.join(PKG, "app/webview.app.js"),
  wxmlIndex: path.join(PKG, "../wxml/pages/index/index.wxml"),
  wxmlSet: path.join(PKG, "../wxml/pages/set/set.wxml"),
  wxmlMy: path.join(PKG, "../wxml/pages/my/my.wxml"),
};
for (const [k, f] of Object.entries(FILES)) if (!fs.existsSync(f)) { console.error(`missing vendor file (${k}): ${f}`); process.exit(2); }

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const arr = a => Array.from(a);

// Source up to and including the line that runs the module. The pretty-printed files carry compiled template code after it.
function cutAt(file, marker) {
  const s = fs.readFileSync(file, "utf8");
  const i = s.indexOf(marker);
  if (i < 0) throw new Error(`marker ${marker} not found in ${file}`);
  return s.slice(0, i + marker.length);
}

// ---------------------------------------------------------------- WXS getVehicleType
function loadWxs() {
  const line = fs.readFileSync(FILES.wxs, "utf8").split("\n").find(l => l.startsWith("function np_") && l.includes("nv_getVehicleType"));
  if (!line) throw new Error("WXS getVehicleType not found");
  const name = line.match(/^function (np_\d+)/)[1];
  const exp = vm.runInNewContext(`${line}\n${name}();`, {}); // sloppy script: nt_0/nt_1 are implicit globals
  return exp.nv_getVehicleType;
}
const wxsVehicleType = loadWxs();

// ---------------------------------------------------------------- WXML parser (decompiled templates)
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const unwrap = v => (v && v.startsWith("{{") ? v.slice(2, -2) : v);
const COND_VARS = ["hw_ver", "isAdmin", "on", "xgblePass", "mianSwitch"];
const evalCond = (c, env) => !!new Function(...COND_VARS, `return (${c});`)(...COND_VARS.map(k => env[k] ?? 0));

// Returns rows: { label, labelLongpress, help, conds, controls: [{ tag, attrs, text, conds }] }.
function parseWxml(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const stack = [];
  let lastPopped = null;
  const rows = [];
  const buttons = [];
  let row = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    let m;
    if ((m = l.match(/^<block wx:if="\{\{(.*)\}\}">$/))) { stack.push(m[1]); continue; }
    if (l === "<block wx:else>") { stack.push(`!(${lastPopped})`); continue; }
    if (/^<block wx:for=/.test(l)) { stack.push("true"); continue; }
    if (l === "</block>") { lastPopped = stack.pop(); if (lastPopped.startsWith("!(") || lastPopped === "true") lastPopped = null; continue; }
    if (/^<view [^>]*class="list-group-item gp"/.test(l)) {
      const a = attrs(l);
      if (a.style && a.style.includes("border-top-color:#fff") && row) continue; // second line of the previous row
      row = { label: null, labelLongpress: null, help: null, conds: [...stack], controls: [] };
      rows.push(row);
      continue;
    }
    if (/^<text\b/.test(l)) {
      const a = attrs(l);
      if (a["data-id"] && a["data-id"].startsWith("help_") && row && !row.help) { row.help = a["data-id"]; row.helpName = a["data-name"]; }
      if (!l.endsWith("/>") && row && row.label === null) { row.label = lines[i + 1].trim(); row.labelLongpress = a.bindlongpress || null; }
      continue;
    }
    if (/^<(switch|button)\b/.test(l)) {
      const a = attrs(l);
      const text = l.endsWith("/>") ? null : lines[i + 1].trim();
      const c = { tag: l.startsWith("<switch") ? "switch" : "button", attrs: a, text, conds: [...stack] };
      buttons.push(c);
      if (row) row.controls.push(c);
    }
  }
  return { rows, buttons, text: lines.join("\n") };
}

// ---------------------------------------------------------------- vendor harness
function makeHarness({ server = {}, isAdmin = 0, storage = {} } = {}) {
  const sent = [], dialogs = [], nav = [], helps = [], inputs = [];
  let confirm = true;
  const store = new Map(Object.entries({ isAdmin, ...storage }));
  let route = "pages/index/index";
  const serverInfo = { success: true, hw_ver: 6, name: "SYNTH", auth_time: "2000-01-01 00:00:00", bt_ver: 0, fw_ver: 0,
    bt_ver_new: 0, fw_ver_new: 0, state: 0, ...server };
  const wx = {
    getStorageSync: k => (store.has(k) ? store.get(k) : ""),
    setStorageSync: (k, v) => store.set(k, v),
    removeStorageSync: k => store.delete(k),
    showModal: o => {
      dialogs.push({ kind: o.editable ? "input" : "modal", text: o.editable ? o.placeholderText : o.content });
      const content = o.editable ? (inputs.length ? inputs.shift() : "") : undefined;
      if (o.success) o.success({ confirm, cancel: !confirm, content });
      if (o.complete) o.complete({});
    },
    showToast: o => dialogs.push({ kind: "toast", text: o.title }),
    hideToast() {}, showLoading() {}, hideLoading() {},
    request: o => {
      if (o.url.includes("?path=wxxcx")) { helps.push(o.url.split("&id=")[1]); o.success({ data: "HELP" }); return; }
      const q = Object.fromEntries(String(o.data).split("&").map(kv => kv.split("=")));
      if (q.fun === "getinfo") o.success({ data: serverInfo });
      else if (q.fun === "getBetaTestCode") o.success({ data: { success: true, code: "BETA" } });
      else o.success({ data: { success: false } });
    },
    navigateTo: o => nav.push(o.url), reLaunch: o => nav.push(o.url),
    setKeepScreenOn() {}, setNavigationBarTitle() {}, hideNavigationBarLoading() {}, showNavigationBarLoading() {},
    getAppBaseInfo: () => ({ host: { env: "WeChat" } }), getDeviceInfo: () => ({ platform: "ios" }),
    stopBluetoothDevicesDiscovery: o => o.complete && o.complete({}),
    setEnableDebug() {},
  };
  const ble = { tx: (type, buf) => sent.push({ type, payload: buf ? arr(buf) : [] }), connIsOK: () => true, init() {}, txvarinit() {} };
  const ota = { Check: () => false, ready: t => sent.push({ type: "ota-ready", payload: [t] }), rxCallback() {}, stop() {} };
  const stubs = {
    "601BF826BD32C12F067D90215E313A93": ble,
    "AD777A77BD32C12FCB1112700B513A93": ota,
    Objectvalues: {},
    toConsumableArray: a => Array.from(a),
  };
  const defs = new Map(), cache = new Map();
  let appObj = null, lastPage = null;
  const base = n => path.basename(n).replace(/\.js$/, "");
  const req = n => {
    const b = base(n);
    if (b in stubs) return stubs[b];
    if (cache.has(b)) return cache.get(b).exports;
    const f = defs.get(b);
    if (!f) throw new Error(`unexpected require ${n}`);
    const module = { exports: {} };
    cache.set(b, module);
    f(req, module, module.exports);
    return module.exports;
  };
  const noop = () => 0;
  const ctx = vm.createContext({
    define: (name, factory) => defs.set(base(name), factory),
    require: req,
    App: def => { appObj = def; },
    Page: def => { lastPage = def; },
    getApp: () => appObj,
    getCurrentPages: () => [{ route }],
    wx, console, setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  });
  vm.runInContext(cutAt(FILES.app, 'require("app.js");'), ctx, { filename: "app.js" });
  vm.runInContext(fs.readFileSync(FILES.dev, "utf8"), ctx, { filename: "dev.js" });
  const pages = {};
  for (const [k, marker] of [["index", 'require("pages/index/index.js");'], ["set", 'require("pages/set/set.js");'], ["my", 'require("pages/my/my.js");']]) {
    vm.runInContext(cutAt(FILES[k], marker), ctx, { filename: `${k}.js` });
    const def = lastPage;
    const page = Object.assign(Object.create(def), {
      data: JSON.parse(JSON.stringify(def.data)),
      var: def.var ? JSON.parse(JSON.stringify(def.var)) : undefined,
      setData(d) {
        if (d === this.data) return;
        for (const [key, v] of Object.entries(d)) {
          const parts = key.split(".");
          let o = this.data;
          for (const p of parts.slice(0, -1)) o = o[p];
          o[parts.at(-1)] = v;
        }
      },
      selectComponent: () => ({ showModal() {}, rx() {} }),
    });
    pages[k] = page;
  }
  pages.index.onLoad({});
  pages.set.onLoad({});
  pages.my.onLoad({});
  const dev = req("0FF8F134BD32C12F699E993320513A93");
  return {
    app: appObj, dev, ...pages, sent, dialogs, nav, helps, inputs, store,
    setRoute: r => { route = r; },
    setConfirm: c => { confirm = c; },
    clear() { sent.length = 0; dialogs.length = 0; nav.length = 0; helps.length = 0; },
  };
}

// ---------------------------------------------------------------- synthetic payloads
let seed = 4242;
// 32-bit LCG in integer math (a plain multiply loses the low bits in a double). Use the high bits.
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
function payload(len, { runtimeOk = true, hw = 6 } = {}) {
  const u = new Uint8Array(len);
  for (let i = 0; i < len; i++) u[i] = rnd(256);
  u[0] = hw; u[1] = 0x12; u[2] = 0x10;
  if (len > 3) u[3] = runtimeOk ? u[3] | 1 : u[3] & ~1;
  for (let i = 4; i < Math.min(18, len); i++) u[i] = 0xa0 + i; // synthetic UID
  if (len >= 40) for (let i = 36; i < 40; i++) u[i] = 0x31 + (i - 36); // printable password "1234"
  if (len === 76) { u[40] = 1; for (let i = 0; i < 17; i++) u[41 + i] = 0x41 + (i % 26); } // synthetic VIN
  return u;
}

function primed(hw, opts = {}) {
  const h = makeHarness({ server: { hw_ver: hw, ...(opts.server || {}) }, isAdmin: opts.isAdmin || 0, storage: opts.storage });
  h.index.rxCallback(160, payload(76, { hw }));
  h.clear();
  return h;
}

const TSL6 = [6, 8];
const indexT = parseWxml(FILES.wxmlIndex);
const setT = parseWxml(FILES.wxmlSet);
const myText = fs.readFileSync(FILES.wxmlMy, "utf8");

// ================================================================ 1. WXS vehicle type, all inputs
for (let hw = 0; hw <= 20; hw++) for (let make = 0; make < 32; make++) for (let model = 0; model < 16; model++) for (const p of [0, 1]) {
  const v = wxsVehicleType(hw, make, model, p);
  const o = S.vehicleTypeText(hw, make, model, p);
  if (typeof v === "string" && !v.includes("undefined")) {
    ok(o.known, `vehicle ${hw}/${make}/${model}/${p}: we must know "${v}"`);
    eq(o.zh, v, `vehicle ${hw}/${make}/${model}/${p}`);
  } else {
    // Vendor quirk: an out-of-range raw value gives undefined or "特斯拉undefined". We keep the raw value instead.
    ok(!o.known, `vehicle ${hw}/${make}/${model}/${p}: vendor ${v}, we must flag unknown`);
    ok(o.zh.includes(`(${v === undefined ? make : model})`), `vehicle ${hw}/${make}/${model}/${p}: raw value kept`);
  }
}

// ================================================================ 2. Status tab table vs template
const ROW_OF = Object.fromEntries(S.STATUS_ROWS.map(r => [r.zh, r]));
// Every row that the vendor shows for hw 6 (AP assist on, factory mode 2) must be in our table, in the same order.
const tplRows = indexT.rows.filter(r => r.label && r.conds.every(c => evalCond(c, { hw_ver: 6, on: 1, isAdmin: 2 })));
eq(tplRows.map(r => r.label), S.STATUS_ROWS.map(r => r.zh), "status rows: labels in screen order (no row left out)");
const visibleTypes = (conds, env) => [3, 5, 6, 7, 8, 19].filter(hw => conds.every(c => evalCond(c, { on: 1, ...env, hw_ver: hw })));
for (const tr of tplRows) {
  const r = ROW_OF[tr.label];
  eq(tr.help, r.help, `${r.id}: help id`);
  eq(visibleTypes(tr.conds, {}), r.types, `${r.id}: device types`);
  for (const ad of [0, 1, 2, 3]) for (const on of [0, 1]) {
    eq(tr.conds.every(c => evalCond(c, { hw_ver: 6, isAdmin: ad, on })), tr.conds.every(c => evalCond(c, { hw_ver: 8, isAdmin: ad, on })), `${r.id}: hw 6 = hw 8`);
  }
  if (r.longpress) eq(tr.labelLongpress, r.longpress, `${r.id}: label long-press`);
  if (r.kind === "switch") {
    eq(tr.controls.length, 1, `${r.id}: one switch`);
    const a = tr.controls[0].attrs;
    eq(a.bindchange, r.handler, `${r.id}: handler`);
    if (r.btn !== undefined) eq(Number(unwrap(a["data-btn"])), r.btn, `${r.id}: data-btn`);
    // State expression: evaluate the template expression on every byte value.
    const expr = unwrap(a.checked);
    const v = r.state[0];
    for (let x = 0; x < 256; x++) {
      const env = { on: 0, fxp: 0, esp: 0, dat0: 0, dat1: 0, [v]: x };
      const tpl = !!new Function("on", "fxp", "esp", "dat0", "dat1", `return (${expr});`)(env.on, env.fxp, env.esp, env.dat0, env.dat1);
      if (tpl !== (((x >> r.state[1]) & 1) === 1)) assert.fail(`${r.id}: state ${expr} at ${v}=${x}`);
    }
    checks++;
  }
  if (r.buttons) {
    const tb = tr.controls.filter(c => c.tag === "button");
    eq(tb.map(c => Number(unwrap(c.attrs["data-btn"]))), r.buttons.map(b => b.btn), `${r.id}: button ids in order`);
    tb.forEach((c, i) => {
      const b = r.buttons[i];
      const icon = (c.attrs.class.match(/iconfont (\S+) btn/) || [])[1];
      if (b.icon) eq(icon, b.icon, `${r.id} ${b.btn}: icon`);
      if (b.text) eq(c.text, b.text, `${r.id} ${b.btn}: text`);
      if (r.kind === "tap") eq(c.attrs["data-info"] ?? null, b.info, `${r.id} ${b.btn}: data-info`);
      const hand = { seat: "SideControl", wheel: "btn", memory: "sideMemoryBtn", tap: "controlBtn" }[r.kind];
      const events = [c.attrs["bind:touchstart"], c.attrs["bind:touchend"], c.attrs["bind:tap"], c.attrs.bindtap, c.attrs["bind:longpress"]].filter(Boolean);
      ok(events.length > 0 && events.every(e => e === hand), `${r.id} ${b.btn}: handler ${hand}`);
      if (r.kind === "seat" || r.kind === "wheel") ok(c.attrs["bind:touchstart"] && c.attrs["bind:touchend"] && !c.attrs["bind:touchcancel"], `${r.id} ${b.btn}: press + release, no touchcancel`);
      if (r.kind === "memory") ok(c.attrs["bind:tap"] && c.attrs["bind:longpress"], `${r.id} ${b.btn}: tap + long-press`);
      const types = visibleTypes(c.conds, { isAdmin: b.vendorGate ? 2 : 0 });
      eq(types, b.types || r.types, `${r.id} ${b.btn}: device types`);
      const adminOnly = c.conds.some(x => x.includes("isAdmin"));
      eq(adminOnly ? "isAdmin == 2" : undefined, b.vendorGate, `${r.id} ${b.btn}: vendor gate`);
      if (adminOnly) ok(c.conds.every(x => evalCond(x, { hw_ver: 6, isAdmin: 2 })) && !c.conds.every(x => evalCond(x, { hw_ver: 6, isAdmin: 1 })), `${b.btn}: isAdmin 2 only`);
    });
  }
}
// Vehicle type text, harness flag and countdown: template expressions.
const vtExpr = indexT.text.match(/\{\{(m\.getVehicleType\([^}]*\))\}\}/)[1];
const harnessCond = indexT.text.match(/<block wx:if="\{\{([^}]*)\}\}">\s*<text[^>]*>\s*线束未插好/)[1];

// ================================================================ 3. Live state decode vs vendor rxCallback
for (const hw of TSL6) {
  const h = primed(hw);
  for (let n = 0; n < 600; n++) {
    const len = [24, 40, 76, 178, 18, 20, 12][n % 7];
    const runtimeOk = n % 5 !== 0;
    const p = payload(len, { hw, runtimeOk });
    if (n % 11 === 0 && len >= 40) for (let i = 18; i < 40; i++) p[i] = 0; // blank status (no password)
    const type = [160, 161, 163][n % 3];
    h.index.rxCallback(type, p);
    const d = h.index.data;
    const o = S.decodeLiveState(p, hw);
    eq(d.hw_ver, hw, "hw_ver from server");
    for (const k of ["on", "fxp", "dat0", "dat1"]) eq(d[k] ?? 0, o.raw[k], `hw ${hw} len ${len} ok ${runtimeOk}: ${k}`);
    if (!o.runtimeOk) { ok(o.raw.esp === 0 && Object.values(o.toggles).every(t => !t), "boot mode: all off"); continue; }
    if (!o.live) { eq(o.timerMs, 0, "short payload: no timer"); continue; }
    eq(d.esp, o.raw.esp, `hw ${hw}: esp`);
    eq(String(d.time.count), o.timerText, `hw ${hw}: timer`);
    for (const r of S.SWITCHES) {
      const c = tplRows.find(t => t.label === r.zh).controls[0];
      const tpl = !!new Function("on", "fxp", "esp", "dat0", "dat1", `return (${unwrap(c.attrs.checked)});`)(d.on, d.fxp, d.esp, d.dat0, d.dat1);
      eq(o.toggles[r.id], tpl, `hw ${hw}: toggle ${r.id}`);
    }
    const vt = new Function("m", "hw_ver", "on", "fxp", "esp", "dat0", "dat1", `return ${vtExpr};`)({ getVehicleType: wxsVehicleType }, d.hw_ver, d.on, d.fxp, d.esp, d.dat0, d.dat1);
    if (o.vehicle.known) eq(o.vehicle.zh, vt, `hw ${hw}: vehicle text`); else ok(vt === undefined || String(vt).includes("undefined"), "vendor quirk");
    eq(o.vehicle.detected, ((d.dat0 >> 0) & 31) !== 0, "vehicle colour (detected)");
    eq(o.harnessUnplugged, evalCond(harnessCond, { on: d.on }), `hw ${hw}: harness flag`);
    eq(o.assistActive, (d.on & 1) === 1, `hw ${hw}: countdown shown`);
    // Without the password, bytes 18-39 are 0, so every on/fxp switch is off. Byte 3 (esp) is still filled.
    if (n % 11 === 0 && len >= 40) ok(o.blank && S.SWITCHES.filter(r => r.state[0] !== "esp").every(r => !o.toggles[r.id]), "blank status: on/fxp switches off");
  }
}

// ================================================================ 4. Handlers: one frame each, never an A0 re-read
function oneFrame(h, msg) {
  eq(h.sent.length, 1, `${msg}: exactly one frame`);
  ok(h.sent[0].type !== 0xa0, `${msg}: no A0 re-read`);
  return h.sent[0];
}
const frame = c => ({ type: c.type, payload: arr(c.payload) });

for (const hw of TSL6) {
  // Switches.
  for (const r of S.SWITCHES) for (const on of [false, true]) {
    const h = primed(hw);
    const c = tplRows.find(t => t.label === r.zh).controls[0];
    h.index[c.attrs.bindchange]({ type: "change", detail: { value: on }, currentTarget: { dataset: { btn: Number(unwrap(c.attrs["data-btn"])) } } });
    const f = oneFrame(h, `${r.id} ${on}`);
    const ours = S.switchCommand(r.id, on, { allowDangerous: true });
    eq(f, frame(ours), `hw ${hw}: switch ${r.id} -> ${on}`);
    eq(h.helps, ours.help ? [ours.help.id] : [], `${r.id} ${on}: help popup`);
    eq(h.dialogs.filter(x => x.kind === "modal").length, 0, `${r.id}: no confirm dialog`);
  }
  // Seat move and wheel: press / release.
  for (const r of S.STATUS_ROWS.filter(x => x.kind === "seat" || x.kind === "wheel")) for (const b of r.buttons) {
    const h = primed(hw);
    const handler = r.kind === "seat" ? "SideControl" : "btn";
    for (const type of ["touchstart", "touchend"]) {
      h.clear();
      h.index[handler]({ type, currentTarget: { dataset: { btn: b.btn } } });
      eq(oneFrame(h, `${r.id} ${b.btn} ${type}`), frame(S.holdCommand(r.id, b.btn, type === "touchstart" ? "press" : "release")), `hw ${hw}: ${r.id} ${b.btn} ${type}`);
      if (r.kind === "wheel" && type === "touchstart") eq(h.index.data.btnval, b.btn, "wheel highlight on press");
    }
    if (r.kind === "wheel") { h.index.rxCallback(162, Uint8Array.of(S.A2_RELEASE)); eq(h.index.data.btnval, S.A2_RELEASE, "A2 echo sets highlight"); }
  }
  // Seat memory: tap = recall, long-press = save; confirm first; cancel sends nothing.
  for (const r of S.STATUS_ROWS.filter(x => x.kind === "memory")) for (const b of r.buttons) for (const type of ["tap", "longpress"]) {
    const h = primed(hw);
    h.index.sideMemoryBtn({ type, currentTarget: { dataset: { btn: b.btn } } });
    const ours = S.memoryCommand(r.id, b.btn, type === "longpress");
    eq(h.dialogs.map(x => x.text), [ours.confirm.zh], `${r.id} ${b.btn} ${type}: confirm text`);
    eq(oneFrame(h, `${r.id} ${b.btn} ${type}`), frame(ours), `hw ${hw}: memory ${b.btn} ${type}`);
    const h2 = primed(hw); h2.setConfirm(false);
    h2.index.sideMemoryBtn({ type, currentTarget: { dataset: { btn: b.btn } } });
    eq(h2.sent.length, 0, "memory: cancel sends nothing");
  }
  // Doors and control buttons.
  for (const r of S.STATUS_ROWS.filter(x => x.kind === "tap")) {
    const tb = tplRows.find(t => t.label === r.zh).controls.filter(c => c.tag === "button");
    for (const c of tb) {
      const btn = Number(unwrap(c.attrs["data-btn"]));
      const h = primed(hw);
      h.index.controlBtn({ type: "tap", currentTarget: { dataset: { btn, info: c.attrs["data-info"] } } });
      const ours = S.tapCommand(r.id, btn, { allowDangerous: true });
      eq(h.dialogs.map(x => x.text), ours.confirm ? [ours.confirm.zh] : [], `${r.id} ${btn}: confirm`);
      eq(oneFrame(h, `${r.id} ${btn}`), frame(ours), `hw ${hw}: control ${btn}`);
    }
  }
  // Long-press "车辆类型": A0, then the CAN dialog from the next status.
  {
    const h = primed(hw);
    h.index.displayVehicleType({ type: "longpress" });
    eq(h.sent, [frame(S.buildA0())], "CAN: long-press sends one A0");
    const p = payload(76, { hw });
    h.clear();
    h.index.rxCallback(160, p);
    eq(h.dialogs.map(x => x.text), [S.canStateText(p[23]).zh], `hw ${hw}: CAN dialog`);
    h.clear();
    h.index.rxCallback(160, p);
    eq(h.dialogs.length, 0, "CAN dialog only once");
  }
  // Long-press "模拟滚轮": C1, reply as 32-bit value.
  {
    const h = primed(hw);
    h.index.getVehicleType({ type: "longpress" });
    eq(oneFrame(h, "C1"), frame(S.buildC1()), "C1 frame");
    for (let n = 0; n < 20; n++) {
      const b = Uint8Array.of(rnd(256), rnd(256), rnd(256), rnd(256));
      h.clear();
      h.index.rxCallback(193, b);
      eq(h.dialogs.map(x => x.text), [S.formatC1Reply(b).zh], "C1 reply text");
    }
  }
  // Replies.
  {
    const h = primed(hw);
    for (const [p, want] of [[[1, 0], S.decodeA7Reply([1, 0])], [[1, 1], S.decodeA7Reply([1, 1])], [[0, 1], null], [[1, 2], null]]) {
      h.clear(); h.index.rxCallback(167, Uint8Array.from(p));
      eq(h.dialogs.map(x => x.text), want ? [want.zh] : [], `A7 reply ${p}`);
    }
    for (const c of [0, 1, 2]) { h.clear(); h.index.rxCallback(169, Uint8Array.of(c)); eq(h.dialogs.map(x => x.text), [S.decodeA9Reply([c]).zh], `A9 reply ${c}`); }
    h.clear(); h.index.rxCallback(164, new Uint8Array(0));
    eq(h.dialogs.map(x => x.text), [S.REPLY_TEXT[0xa4].zh], "A4 reply"); eq(h.sent.length, 0, "A4 reply: no re-read on hw 6/8");
    h.clear(); h.index.rxCallback(165, new Uint8Array(0));
    eq(h.dialogs.map(x => x.text), [S.REPLY_TEXT[0xa5].zh], "A5 reply");
  }
}

// ================================================================ 5. Settings tab action buttons
const setButtons = setT.buttons.filter(b => b.attrs.bindtap === "btn" && b.attrs["data-id"]);
{
  // Every action button that the vendor shows for hw 6 (form closed, module on, not factory mode) is in our table, in order.
  const vis = setButtons.filter(b => b.conds.every(c => evalCond(c, { hw_ver: 6 })));
  eq(vis.map(b => b.attrs["data-id"]), S.SET_ACTIONS.map(a => a.id), "set actions: ids in screen order (none left out)");
}
for (const a of S.SET_ACTIONS) {
  const tb = setButtons.filter(b => b.attrs["data-id"] === a.id && b.conds.every(c => evalCond(c, { hw_ver: 6 })));
  ok(tb.length === 1, `set action ${a.id}: one button for hw 6`);
  eq(tb[0].text, a.zh, `set action ${a.id}: label`);
  for (const hw of TSL6) for (const ms of [0, 1]) for (const xg of [0, 1]) {
    const vis = tb[0].conds.every(c => evalCond(c, { hw_ver: hw, mianSwitch: ms, xgblePass: xg }));
    eq(vis, xg === 0 && (a.gate !== "mianSwitch == 0" || ms === 0), `set action ${a.id}: gate hw ${hw} mianSwitch ${ms} form ${xg}`);
  }
}
for (const hw of TSL6) {
  const status = payload(76, { hw });
  const loadSet = (opts = {}) => {
    const h = primed(hw, opts);
    h.dev.deviceinfo.buf = status;
    h.set.rx(160, status);
    h.clear();
    return h;
  };
  const tap = (h, id) => h.set.btn({ type: "tap", currentTarget: { dataset: { id } } });
  // Navigation.
  for (const a of S.SET_ACTIONS.filter(x => x.nav)) {
    const h = loadSet(); tap(h, a.id);
    eq(h.nav, ["../" + a.nav.split("/").slice(1).join("/")], `set ${a.id}: navigates`);
    eq(h.sent.length, 0, `set ${a.id}: no BLE`);
  }
  // Restore defaults (A4).
  {
    const h = loadSet(); tap(h, "reset");
    const a = S.SET_ACTIONS.find(x => x.id === "reset");
    eq(h.dialogs.map(x => x.text), [a.confirm.zh], "A4 confirm");
    eq(oneFrame(h, "A4"), frame(S.buildA4(status)), `hw ${hw}: A4 payload`);
    eq(h.set.data.hw_ver, 0, "A4 blanks the settings page until the next status");
  }
  // Tesla service mode (A7 255).
  {
    const a = S.SET_ACTIONS.find(x => x.id === "service");
    const ours = frame(S.serviceModeCommand({ allowDangerous: true }));
    let h = loadSet({ isAdmin: 1 }); h.set.data.isAdmin = 1; tap(h, "service");
    eq(h.dialogs.map(x => x.text), [a.confirm.zh], "service confirm text");
    eq(oneFrame(h, "service admin"), ours, `hw ${hw}: service mode (factory mode)`);
    h = loadSet({ storage: { TSLServiceMode: "BETA" } }); tap(h, "service");
    eq(oneFrame(h, "service stored code"), ours, "service mode with stored beta code");
    h = loadSet(); h.inputs.push("BETA"); tap(h, "service");
    eq(h.dialogs.map(x => x.text), [a.confirm.zh, "请输入内测码"], "service: asks for beta code");
    eq(oneFrame(h, "service typed code"), ours, "service mode with typed beta code");
    eq(h.store.get("TSLServiceMode"), "BETA", "service: stores the beta code");
    h = loadSet(); h.inputs.push("WRONG"); tap(h, "service");
    eq(h.sent.length, 0, "service: wrong beta code sends nothing");
    ok(S.A7_HARD_GATED.includes(255), "service mode is hard-gated in our codec");
  }
  // Change password (A9).
  {
    const a = S.SET_ACTIONS.find(x => x.id === "xgblePass");
    let h = loadSet(); tap(h, "xgblePass"); eq(h.set.data.xgblePass, 1, "password form opens");
    eq(h.set.data.wl4.oldkey, String.fromCharCode(...status.slice(36, 40)), "vendor shows the stored password as the placeholder");
    const cases = [["123", "5678", "5678"], ["1234", "567", "567"], ["1234", "1234", "1234"], ["1234", "5678", "5679"], ["1234", "5678", "5678"],
      ["abcd", "Zz9!", "Zz9!"], ["1234", "a b~", "a b~"]];
    for (const [o, n, c] of cases) {
      h = loadSet();
      h.set.data.wl4.key = [o, n, c];
      tap(h, "blePasswordSave");
      const err = S.validatePasswordChange(o, n, c);
      if (err) { eq(h.dialogs.map(x => x.text), [err.zh], `password ${o}/${n}/${c}: vendor message`); eq(h.sent.length, 0, "no frame"); continue; }
      eq(h.dialogs.map(x => x.text), [a.confirm.zh], "A9 confirm");
      eq(oneFrame(h, "A9"), frame(S.buildA9(status, o, n)), `hw ${hw}: A9 ${o}->${n}`);
    }
    // Vendor accepts non-ASCII; we do not.
    h = loadSet(); h.set.data.wl4.key = ["1234", "密码ab", "密码ab"]; tap(h, "blePasswordSave");
    eq(h.sent.length, 1, "vendor sends a non-ASCII password");
    ok(S.validatePasswordChange("1234", "密码ab", "密码ab") !== null, "we refuse a non-ASCII password");
    assert.throws(() => S.buildA9(status, "1234", "密码ab")); checks++;
  }
}

// ================================================================ 6. Me tab
for (const hw of TSL6) {
  const p = payload(76, { hw });
  for (const fwServer of [0, 0x41]) {
    const h = makeHarness({ server: { hw_ver: hw, fw_ver: fwServer } });
    h.index.rxCallback(160, p);
    h.my.show(p);
    const me = S.meInfo(p);
    eq(h.my.data.UID, me.moduleId, "Me: device ID");
    eq(h.my.data.MAC, me.mac, "Me: MAC");
    eq(h.my.data.VIN, me.vin, "Me: VIN");
    eq(h.my.data.bt_ver, me.bootVersion, "Me: boot version from status byte 1");
    eq(h.my.data.fw_ver, fwServer ? S.formatVersion(fwServer << 8) : me.runVersion, `Me: firmware version (server value ${fwServer})`);
    eq(h.my.data.auth_time, "2000-01-01 00:00:00", "Me: activation time from the server");
  }
  for (let v = 0; v < 0x10000; v += 0x0101) {
    const h = primed(hw);
    eq(h.my.getver(v), S.formatVersion(v), `version text ${v}`);
  }
  // Restart (A5).
  {
    const h = primed(hw);
    h.my.btn({ type: "tap", currentTarget: { dataset: { id: "reboot" } } });
    eq(h.dialogs.map(x => x.text), [S.ME_ROWS.find(r => r.id === "reboot").confirm.zh], "A5 confirm");
    eq(oneFrame(h, "A5"), frame(S.buildA5(h.dev.deviceinfo.buf)), `hw ${hw}: A5 payload`);
  }
  // Clear cache.
  {
    const h = primed(hw);
    const keep = ["bleKeyErr", "isAdmin", "showDebug", "showTest", "moveid"];
    for (const k of [...S.CLEAR_CACHE_KEYS, ...keep]) h.store.set(k, 1);
    const removed = [];
    const del = h.store.delete.bind(h.store);
    h.store.delete = k => { removed.push(k); return del(k); };
    h.my.btn({ type: "tap", currentTarget: { dataset: { id: "clear" } } });
    eq(h.dialogs[0].text, S.ME_ROWS.find(r => r.id === "clear").confirm.zh, "clear confirm");
    eq(removed, [...S.CLEAR_CACHE_KEYS], "clear removes exactly our key list, in order");
    eq(keep.filter(k => h.store.has(k)), keep, "clear keeps the other keys");
    eq(h.sent.length, 0, "clear: no BLE");
  }
  // Bootloader OTA pre-check: A1 00 when AP assist is on.
  {
    const h = primed(hw);
    const p2 = payload(76, { hw }); p2[19] |= 1;
    h.index.rxCallback(160, p2); h.clear();
    h.my.update({ currentTarget: { dataset: { isapp: "0", name: "bootloader引导" } } });
    eq(h.dialogs.map(x => x.text), [S.OTA_PRECHECK.zh], "OTA pre-check text");
    eq(oneFrame(h, "OTA pre-check"), frame(S.buildA1(false)), "OTA pre-check sends A1 00");
  }
}
for (const r of S.ME_ROWS.filter(x => x.id !== "appDate")) ok(myText.includes(r.zh), `Me row ${r.zh} in template`);

// ================================================================ 7. Our safety policy (differs from the vendor on purpose)
for (const v of S.A7_HARD_GATED) { assert.throws(() => S.buildA7(v), /hard-gated/); checks++; }
for (const v of [47, 49, 51]) {
  const r = S.SWITCHES.find(x => x.btn === v - 1);
  assert.throws(() => S.switchCommand(r.id, true), /hard-gated/); checks++;
  eq(frame(S.switchCommand(r.id, false)), { type: 0xa7, payload: [v - 1] }, `${r.id}: turning off is not gated`);
}
assert.throws(() => S.buildA7(24), /not used/); checks++;
assert.throws(() => S.buildA4(new Uint8Array(12)), /too short/); checks++;
{
  // The vendor sends 14 zero bytes when the status is shorter than 18 bytes.
  const h = primed(6);
  h.dev.deviceinfo.buf = new Uint8Array(12);
  h.my.btn({ type: "tap", currentTarget: { dataset: { id: "reboot" } } });
  eq(h.sent[0].payload, Array(14).fill(0), "vendor A5 with a short status: 14 zero bytes");
}
for (const t of [0xad, 0xae, 0xaf]) ok(!Object.values(S.CMD).includes(t), `no builder for ${t.toString(16)}`);

console.log(`status-vendor: ${checks} checks passed`);
