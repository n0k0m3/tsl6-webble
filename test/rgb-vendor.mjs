// Differential test: our B9 ambient light codec vs the vendor Mini App page "pages/rgb".
// The vendor code is not in this repo. Pass the path to the unpacked, pretty-printed rgb.js:
//   node test/rgb-vendor.mjs ~/.cache/tsl6-miniapp/pkg/src/pages/rgb/rgb.js [webview.app.js]
// The test also loads these vendor files next to rgb.js: ../../app.js, ../../D586CCC2...js (HSV to RGB),
// ../../components/color-picker/color-picker.js, and ../../../app/webview.app.js (template option lists).
// All fixtures are synthetic. Trigger names are made up.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import {
  TYPE_RGB, TAB, TABLE_LEN, SLOT_COUNT, SLOT_LEN, LAMP, ZONE_EFFECT, BREATHE, BLINK, carEffectOptions, brightOptions,
  decodeSlot, encodeSlot, rulesFromTable, encodeTable, newRule, moveRule, removeRule, triggerName, rgbToHex,
  wheelColor, buildRead, buildWrite, buildTry, buildClear, parseReply, echoMatches,
} from "../public/lib/tsl6-rgb.js";

const rgbJs = process.argv[2];
if (!rgbJs) { console.error("usage: node test/rgb-vendor.mjs <vendor pages/rgb/rgb.js> [webview.app.js]"); process.exit(2); }
const srcRoot = path.resolve(path.dirname(rgbJs), "../..");
const webviewJs = process.argv[3] ?? path.resolve(srcRoot, "../app/webview.app.js");
const read = f => fs.readFileSync(f, "utf8");

// Globals that the compiled template code at the end of each vendor file needs.
const tailStubs = () => ({ __g: {}, __vd_version_info__: {}, __wxAppCode__: {} });

// Run a vendor file. The file tail (template code) may fail in a bare context; the define() part runs first.
function runVendor(file, ctx) {
  try { vm.runInNewContext(read(file), ctx, { filename: path.basename(file) }); }
  catch (e) { if (!ctx.__captured) throw e; }
}

// ---------------------------------------------------------------- vendor modules
const hsvModule = (() => {
  const m = { exports: {} };
  const ctx = { ...tailStubs(), define: (_n, f) => { f(() => { throw new Error("require"); }, m, m.exports); ctx.__captured = true; }, require() {}, console };
  runVendor(path.join(srcRoot, "D586CCC2BD32C12FB3E0A4C5C3213A93.js"), ctx);
  assert.ok(m.exports.hsv2rgb, "vendor hsv2rgb loaded");
  return m.exports;
})();

const appDef = (() => {
  let def = null;
  const ctx = {
    ...tailStubs(), console, require() {},
    define: (_n, f) => f(() => ({}), {}, {}),
    App: d => { def = d; ctx.__captured = true; },
    wx: {},
  };
  runVendor(path.join(srcRoot, "app.js"), ctx);
  assert.ok(def && def.Dec2Hex && def.Hex2Dec && def.getCheckData, "vendor app.js helpers loaded");
  return def;
})();

const pickerDef = (() => {
  let def = null;
  const ctx = {
    ...tailStubs(), console, require() {},
    define: (_n, f) => f(name => { if (name.includes("D586CCC2")) return hsvModule; throw new Error("require " + name); }, {}, {}),
    Component: d => { def = d; ctx.__captured = true; },
    wx: { getWindowInfo: () => ({ screenWidth: 750 }) },
  };
  runVendor(path.join(srcRoot, "components/color-picker/color-picker.js"), ctx);
  assert.ok(def, "vendor colour picker loaded");
  return def;
})();

// Option lists from the compiled template module "get" (WXS) in webview.app.js.
const wxsGet = (() => {
  const line = read(webviewJs).split("\n").find(l => l.startsWith("function np_") && l.includes("nv_breathe:(") && l.includes("nv_addr:("));
  assert.ok(line, "WXS module with nv_addr/nv_breathe found");
  const name = /^function (np_\d+)/.exec(line)[1];
  return vm.runInNewContext(`${line}\n${name}()`, {});
})();

// ---------------------------------------------------------------- page harness
const FUNLIST = { btn: [
  { name: "Group A", data: [{ val: 1, name: "Trigger one" }, { val: 7, name: "Trigger seven" }, { val: 300, name: "Trigger 300" }] },
  { name: "Group B", data: [{ val: 42, name: "Trigger 42", attemp: 1 }, { val: 511, name: "Trigger 511" }, { val: 7, name: "Trigger seven again" }] },
] };

// rgb.js calls getApp() and require() once, at load. They forward to the page that the test runs now.
const harness = { app: null, sent: null };
const currentApp = new Proxy({}, { get: (_t, k) => harness.app[k], set: (_t, k, v) => { harness.app[k] = v; return true; } });
const currentBle = { tx: (type, buf) => harness.sent.push({ type, buf: Array.from(buf) }) };
let pageDef = null;
{
  const ctx = {
    ...tailStubs(), console, require() {},
    define: (_n, f) => f(name => {
      if (name.includes("defineProperty")) return (o, k, v) => { o[k] = v; return o; };
      if (name.includes("601BF826")) return currentBle;
      throw new Error("unexpected require " + name);
    }, {}, {}),
    Page: d => { pageDef = d; ctx.__captured = true; },
    getApp: () => currentApp,
    wx: {
      createSelectorQuery: () => ({ select() { return this; }, boundingClientRect(cb) { cb({ top: 0, height: 0 }); return this; }, exec() {} }),
      pageScrollTo() {},
    },
  };
  runVendor(rgbJs, ctx);
  assert.ok(pageDef, "vendor rgb page loaded");
}

function setPath(obj, key, val) {
  const parts = key.match(/[^.[\]]+/g);
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts.at(-1)] = val;
}

function loadVendor({ realCheck = false } = {}) {
  const h = harness;
  const msgs = [], modals = [];
  h.sent = [];
  h.app = {
    Dec2Hex: appDef.Dec2Hex, Hex2Dec: appDef.Hex2Dec,
    checkData: { count: 0, type: 0, buf: null },
    setCheckData: realCheck ? appDef.setCheckData : () => {},
    getCheckData: realCheck ? appDef.getCheckData : () => false,
    msg: t => msgs.push(t),
    modal: (t, _c, ok) => { modals.push(t); ok && ok({ confirm: true }); },
    modalview() {},
    getFunListJs: cb => cb(structuredClone(FUNLIST), true),
    rgb: { that: null }, index: { that: null },
  };
  const page = Object.assign(Object.create(pageDef), {
    data: structuredClone(pageDef.data),
    var: structuredClone(pageDef.var),
    setData(d, cb) {
      if (d !== this.data) for (const k of Object.keys(d)) setPath(this.data, k, d[k]);
      cb && cb.call(this);
    },
    selectComponent: id => id === "#picker" ? { rpx2px: x => x } : { showModal() {}, rx() {} },
  });
  page.onLoad({});
  page.onShow();
  return { page, sent: h.sent, msgs, modals };
}

const ev = (fun, idx, value, extra = {}) => ({ type: "tap", currentTarget: { dataset: { fun, idx } }, detail: { value }, changedTouches: [{ clientY: 0 }], ...extra });

// Open a tab and feed it a table, as the module would reply.
function openTab(v, tab, table) {
  if (tab !== 0) v.page.select({ currentTarget: { dataset: { idx: tab } } });
  v.page.rx(TYPE_RGB, Uint8Array.from(table));
  v.sent.length = 0;
}

// ---------------------------------------------------------------- fixtures
let seed = 4242;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

function randomTable({ holeRate = 35, maxRules = SLOT_COUNT } = {}) {
  const t = new Uint8Array(TABLE_LEN);
  for (let i = 0; i < TABLE_LEN; i++) t[i] = rnd(256);
  let used = 1;
  for (let s = 1; s < SLOT_COUNT; s++) {
    if (rnd(100) < holeRate || used >= maxRules) { t[s * SLOT_LEN] = 0; t[s * SLOT_LEN + 1] &= 0xfe; }
    else if ((t[s * SLOT_LEN] | ((t[s * SLOT_LEN + 1] & 1) << 8)) === 0) t[s * SLOT_LEN] = 1 + rnd(255);
    if (s > 0 && decodeSlot(t, s).cmd !== 0) used++;
  }
  // Some edge values: max fields in slot 1, a known trigger in slot 2, rule 0 with wire addr 0.
  if (rnd(2)) t.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], SLOT_LEN);
  if (rnd(2)) { t[0] &= 0xff; t[1] &= 0x03; }
  return t;
}

let checks = 0;

// ---------------------------------------------------------------- 1. option lists vs the template module
{
  const conv = list => JSON.parse(JSON.stringify(list.map(e => [e.nv_val, e.nv_name]))); // cross-realm arrays
  const ours = list => list.map(e => [e[0], e[2]]);
  assert.deepEqual(ours(LAMP), conv(wxsGet.nv_addr(0)), "lamp list");
  assert.deepEqual(ours(ZONE_EFFECT), conv(wxsGet.nv_effect(0, true)), "zone effect list");
  assert.deepEqual(ours(carEffectOptions(1)), conv(wxsGet.nv_effect(1, true)), "car effect list, rule >= 1");
  assert.deepEqual(ours(carEffectOptions(0)), conv(wxsGet.nv_effect(1, false)), "car effect list, rule 0");
  assert.deepEqual(ours(brightOptions(TAB.ZONE)), conv(wxsGet.nv_bright(0)), "brightness list, tab 0");
  assert.deepEqual(ours(brightOptions(TAB.CAR)), conv(wxsGet.nv_bright(1)), "brightness list, tab 1");
  assert.deepEqual(ours(BREATHE), conv(wxsGet.nv_breathe(0)), "fade speed list");
  assert.deepEqual(ours(BLINK), conv(wxsGet.nv_blink(0)), "blink speed list");
  // The template uses the value as the list index. Every list must start at its first value with step 1.
  for (const l of [ZONE_EFFECT, carEffectOptions(0), brightOptions(0), BREATHE, BLINK]) l.forEach((e, i) => assert.equal(e[0], i));
  checks += 13;
}

// ---------------------------------------------------------------- 2. read request
for (const tab of [0, 1]) {
  const v = loadVendor();
  if (tab) v.page.select({ currentTarget: { dataset: { idx: 1 } } });
  assert.equal(v.sent.at(-1).type, TYPE_RGB);
  assert.deepEqual(v.sent.at(-1).buf, Array.from(buildRead(tab)), `read tab ${tab}`);
  checks++;
}

// ---------------------------------------------------------------- 3. decode and unchanged write
for (const tab of [0, 1]) {
  for (let n = 0; n < 300; n++) {
    const table = randomTable({ holeRate: n % 10 === 0 ? 0 : 35 }); // some full tables (36 rules)
    if (n % 10 === 0) for (let s = 1; s < SLOT_COUNT; s++) if (decodeSlot(table, s).cmd === 0) table[s * SLOT_LEN] = 7;
    const v = loadVendor();
    openTab(v, tab, table);
    const vr = v.page.data.datalist[tab];
    const ours = rulesFromTable(table);
    assert.equal(vr.length, ours.length, "rule count");
    ours.forEach((r, i) => {
      const x = vr[i];
      for (const k of ["cmd", "run", "bright", "breathe", "blink", "effect"]) assert.equal(x[k], r[k], `tab ${tab} rule ${i} ${k}`);
      assert.equal(x.addr + (tab === 0 ? 1 : 0), r.addr, `tab ${tab} rule ${i} addr`);
      assert.equal(x.color, rgbToHex(r.color), `tab ${tab} rule ${i} colour`);
      assert.equal(x.btnname, triggerName(tab, i, r.cmd, FUNLIST.btn).zh, `tab ${tab} rule ${i} name`);
      checks += 9;
    });
    // Write without a change: toggle rule 0's switch to the value it has.
    v.page.btn(ev("run", 0, Boolean(vr[0].run)));
    assert.equal(v.sent.length, 1);
    assert.equal(v.sent[0].type, TYPE_RGB);
    assert.deepEqual(v.sent[0].buf, Array.from(buildWrite(tab, encodeTable(ours, table))), `tab ${tab}: unchanged write`);
    checks++;
  }
}

// ---------------------------------------------------------------- 4. single field changes
const FIELD_VALUES = {
  run: [0, 1],
  addr: { 0: [1, 2, 3], 1: [0, 1, 2] },
  effect: [0, 1],
  bright: [0, 1, 10, 11, 20],
  breathe: [0, 1, 2, 3],
  blink: [0, 1, 15, 31],
};
for (const tab of [0, 1]) {
  for (const [field, spec] of Object.entries(FIELD_VALUES)) {
    const values = Array.isArray(spec) ? spec : spec[tab];
    for (const val of values) {
      for (let n = 0; n < 8; n++) {
        const table = randomTable();
        const v = loadVendor();
        openTab(v, tab, table);
        const rules = rulesFromTable(table);
        const idx = rnd(rules.length);
        // The vendor picker value is the list index. Tab 0 lamp: index = wire value - 1.
        const uiVal = field === "addr" && tab === 0 ? val - 1 : field === "run" ? Boolean(val) : val;
        v.page.btn(ev(field, idx, uiVal));
        const changed = rules.map((r, i) => i === idx ? { ...r, [field]: val } : r);
        assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable(changed, table))), `tab ${tab}: ${field} = ${val}`);
        checks++;
      }
    }
  }
  // Trigger change from the trigger picker (rule >= 1).
  for (const val of [1, 7, 42, 300, 511]) {
    const table = randomTable({ holeRate: 10 });
    const v = loadVendor();
    openTab(v, tab, table);
    const rules = rulesFromTable(table);
    if (rules.length < 2) continue;
    const idx = 1 + rnd(rules.length - 1);
    v.page.save({ detail: { currentTarget: { dataset: { idx, val } } } });
    const changed = rules.map((r, i) => i === idx ? { ...r, cmd: val } : r);
    assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable(changed, table))), `tab ${tab}: cmd = ${val}`);
    checks++;
  }
}

// ---------------------------------------------------------------- 5. colour wheel and colour write
{
  const comp = (left, top, size) => {
    let out = null;
    const self = { data: { left, top, size, brightness: 255 }, triggerEvent: (_n, d) => { out = d; } };
    return (x, y) => { pickerDef.methods._selectColor.call(self, { touches: [{ clientX: x, clientY: y }] }); return out; };
  };
  for (const [left, top, size] of [[75, 75, 225], [0, 0, 300], [10, 20, 199]]) {
    const tap = comp(left, top, size);
    for (let x = -20; x <= size + 20; x += 7) {
      for (let y = -20; y <= size + 20; y += 7) {
        const d = tap(left + x, top + y);
        const o = wheelColor(x, y, size);
        assert.equal(Number(d.h), o.h, `hue at ${x},${y}`);
        assert.equal(Number(d.s), o.s, `saturation at ${x},${y}`);
        assert.deepEqual(Array.from(d.rgb.val), o.rgb, `rgb at ${x},${y}`);
        checks += 3;
      }
    }
  }
  // Colour written through the page.
  for (const tab of [0, 1]) {
    for (let n = 0; n < 40; n++) {
      const table = randomTable();
      const v = loadVendor();
      openTab(v, tab, table);
      const rules = rulesFromTable(table);
      const idx = rnd(rules.length);
      v.page.btn(ev("color", idx));
      assert.equal(v.page.data.color, true, "colour picker opens");
      const size = 225, x = rnd(size), y = rnd(size);
      const d = comp(75, 75, size)(75 + x, 75 + y);
      v.page.selectColor({ detail: d });
      const changed = rules.map((r, i) => i === idx ? { ...r, color: wheelColor(x, y, size).rgb } : r);
      assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable(changed, table))), `tab ${tab}: colour`);
      checks++;
    }
  }
}

// ---------------------------------------------------------------- 6. remove, remove all, try, move, add
for (const tab of [0, 1]) {
  for (let n = 0; n < 40; n++) {
    const table = randomTable({ holeRate: 20, maxRules: 30 });
    const rules = rulesFromTable(table);
    if (rules.length < 3) continue;
    const idx = 1 + rnd(rules.length - 1);

    // Remove one rule. The vendor asks first, then writes the whole table.
    let v = loadVendor();
    openTab(v, tab, table);
    v.page.btn(ev("remove", idx));
    assert.equal(v.modals.at(-1), "确定要删除此指令吗");
    assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable(removeRule(rules, idx), table))), "remove");
    const echo = encodeTable(removeRule(rules, idx), table);
    v.page.rx(TYPE_RGB, Uint8Array.from(echo));
    assert.equal(v.msgs.at(-1), "删除成功");

    // Remove all.
    v = loadVendor();
    openTab(v, tab, table);
    v.page.btn(ev("removeAll"));
    assert.equal(v.modals.at(-1), "确定删除所有指令?");
    assert.deepEqual(v.sent.at(-1).buf, Array.from(buildClear(tab)), "remove all");

    // Try. The index is the rule position on the page.
    v = loadVendor();
    openTab(v, tab, table);
    v.page.btn(ev("test", idx));
    assert.deepEqual(v.sent.at(-1).buf, Array.from(buildTry(tab, idx)), "try");

    // Move up and down by long press and drag.
    for (const dy of [-60, 60]) {
      v = loadVendor();
      openTab(v, tab, table);
      v.page.btn({ type: "longpress", currentTarget: { dataset: { fun: "move", idx } }, changedTouches: [{ clientY: 500 }], detail: {} });
      v.page.btn({ type: "touchend", currentTarget: { dataset: { fun: "move", idx } }, changedTouches: [{ clientY: 500 + dy }], detail: {} });
      const to = dy < 0 ? idx - 1 : idx + 1;
      if (to < 1 || to >= rules.length) { assert.equal(v.sent.length, 0, "no move past the ends"); checks++; continue; }
      assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable(moveRule(rules, idx, to), table))), "move");
      checks++;
    }

    // Add. The vendor sends nothing until a field changes.
    v = loadVendor();
    openTab(v, tab, table);
    v.page.btn(ev("add"));
    assert.equal(v.sent.length, 0, "add sends nothing");
    v.page.btn(ev("bright", rules.length, 5));
    assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(tab, encodeTable([...rules, { ...newRule(tab), bright: 5 }], table))), "add");
    checks += 8;
  }
}

// ---------------------------------------------------------------- 7. replies
{
  const v = loadVendor();
  v.page.rx(TYPE_RGB, Uint8Array.of(0xff));
  assert.equal(v.msgs.at(-1), "请先安装\r\n氛围灯模块");
  assert.equal(parseReply(Uint8Array.of(0xff)).kind, "noModule");
  assert.equal(parseReply(new Uint8Array(TABLE_LEN)).kind, "table");
  assert.equal(parseReply(new Uint8Array(5)).kind, "unknown");
  checks += 4;
}

// ---------------------------------------------------------------- 8. vendor quirks (we do not copy them)
// 8a. A write echo that differs makes the vendor resend the bare 256-byte table, without the [1, tab] header.
{
  const table = randomTable();
  const v = loadVendor({ realCheck: true });
  openTab(v, 0, table);
  v.page.btn(ev("bright", 0, (decodeSlot(table, 0).bright + 1) % 21));
  const frame = v.sent.at(-1).buf;
  assert.equal(frame.length, 2 + TABLE_LEN);
  let resends = 0;
  for (let i = 0; i < 6; i++) {
    const before = v.sent.length;
    v.page.rx(TYPE_RGB, Uint8Array.from(table)); // module "did not take" the write
    if (v.sent.length > before) {
      resends++;
      const r = v.sent.at(-1);
      assert.equal(r.type, TYPE_RGB);
      assert.deepEqual(r.buf, frame.slice(2), "vendor resend has no header");
    }
  }
  assert.equal(resends, 4, "vendor resends 4 times");
  assert.ok(echoMatches(Uint8Array.from(frame.slice(2)), Uint8Array.from(frame.slice(2))), "echo of the sent table matches");
  assert.ok(!echoMatches(Uint8Array.from(frame.slice(2)), table), "old table does not match");
  checks += 7;
}
// 8b. Tab 0: each vendor write adds 1 to the lamp value in memory. A second write before the echo drifts.
{
  const table = randomTable({ holeRate: 50 });
  const v = loadVendor();
  openTab(v, 0, table);
  v.page.btn(ev("breathe", 0, 1));
  v.page.btn(ev("breathe", 0, 2));
  const rules = rulesFromTable(table).map((r, i) => i === 0 ? { ...r, breathe: 2 } : r);
  const vendorSecond = Uint8Array.from(v.sent.at(-1).buf.slice(2));
  rules.forEach((r, i) => {
    assert.equal(decodeSlot(vendorSecond, i).addr, (r.addr + 1) & 63, `vendor drift, rule ${i}`);
    checks++;
  });
  assert.deepEqual(rulesFromTable(encodeTable(rules, table)).map(r => r.addr), rules.map(r => r.addr), "our codec does not drift");
  checks++;
}
// 8c. We mask each field to its width. The vendor lets a large cmd spill into the run bit.
{
  const s = encodeSlot({ cmd: 0x3ff, run: 0, addr: 64, bright: 40, breathe: 0, blink: 0, effect: 2, color: [1, 2, 3] });
  const d = decodeSlot(s, 0);
  assert.deepEqual([d.cmd, d.run, d.addr, d.bright, d.effect], [0x1ff, 0, 0, 8, 0]);
  checks++;
}

// 8d. More than 36 rules: the vendor drops the extra rule without a message. Our encodeTable throws.
{
  const table = randomTable({ holeRate: 0 });
  for (let s = 1; s < SLOT_COUNT; s++) if (decodeSlot(table, s).cmd === 0) table[s * SLOT_LEN] = 7;
  const rules = rulesFromTable(table);
  assert.equal(rules.length, SLOT_COUNT);
  const v = loadVendor();
  openTab(v, 1, table);
  v.page.btn(ev("add"));
  v.page.btn(ev("bright", 0, (rules[0].bright + 1) % 21));
  const changed = rules.map((r, i) => i === 0 ? { ...r, bright: (r.bright + 1) % 21 } : r);
  assert.deepEqual(v.sent.at(-1).buf, Array.from(buildWrite(1, encodeTable(changed, table))), "vendor drops rule 37");
  assert.throws(() => encodeTable([...rules, newRule(1)], table), RangeError);
  checks += 3;
}

console.log(`rgb-vendor: ${checks} checks passed`);
