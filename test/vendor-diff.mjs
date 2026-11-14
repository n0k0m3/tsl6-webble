// Differential test: our settings codec vs the vendor Mini App settings page.
// The vendor code is not in this repo. Pass the path to the unpacked, pretty-printed set.js:
//   node test/vendor-diff.mjs ~/.cache/tsl6-miniapp/pkg/src/pages/set/set.js
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import { FIELDS, BY_ID, decodeSettings, encodeSettings, optionsFor, TSL_TYPES, PROMPT_TIMES, isPromptTime, promptDelayMs } from "../public/lib/tsl6-settings.js";

const setJs = process.argv[2];
if (!setJs) { console.error("usage: node test/vendor-diff.mjs <vendor set.js>"); process.exit(2); }

// ---------------------------------------------------------------- vendor harness
function loadVendor(hwType) {
  let pageDef = null;
  const sent = [];
  const ble = { tx: (type, buf) => sent.push({ type, buf: Uint8Array.from(buf) }) };
  const dev = { deviceinfo: { hw_ver: hwType, buf: [], id: "" } };
  const app = {
    msg() {}, modal() {}, input() {}, help() {}, modalview() {},
    isAdmin: () => 0,
    setCheckData() {}, getCheckData: () => false,
    getItemIdx(t, e) { for (let n = 0; n < t.data.length; n++) if (t.data[n].val == e) return n; return 0; },
    getUidUint8Array: t => t.slice(4, 18),
    index: { that: null }, set: { that: null },
  };
  const req = name => {
    if (name.includes("toConsumableArray")) return a => Array.from(a);
    if (name.includes("601BF826")) return ble;
    if (name.includes("0FF8F134")) return dev;
    throw new Error("unexpected require " + name);
  };
  const ctx = {
    define: (_name, factory) => factory(req, {}, {}),
    require: () => {},
    Page: def => { pageDef = def; },
    getApp: () => app,
    wx: { getStorageSync: () => 0, setStorageSync() {}, removeStorageSync() {}, navigateTo() {} },
    console,
  };
  vm.runInNewContext(fs.readFileSync(setJs, "utf8"), ctx, { filename: "set.js" });
  const page = Object.assign(Object.create(pageDef), {
    data: structuredClone(pageDef.data),
    setData(d) { if (d !== this.data) for (const k of Object.keys(d)) if (!k.includes(".")) this.data[k] = d[k]; },
    selectComponent: () => ({ showModal() {}, rx() {} }),
  });
  return { page, sent };
}

// Vendor field object by id (top level or sub) from the page data.
function vendorField(page, id) {
  for (const list of ["tsl6list", "list", "tslBasicSet"]) {
    for (const f of page.data[list]) {
      if (f.id === id) return f;
      if (f.sub && f.sub.id === id) return f.sub;
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers
let seed = 12345;
// Math.imul keeps the 32-bit product exact. A plain * loses the low bits above 2^53 and gives mostly 0.
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 8) % n; };
const pick = a => a[rnd(a.length)];
const UNMAPPED = { 32: 0x10, 33: 0x30 }; // bits the vendor clears on save

function validPayload(len, hwType) {
  const u = new Uint8Array(len);
  for (let i = 0; i < 24; i++) u[i] = rnd(256);
  u[0] = hwType;
  u[34] = rnd(2); // bit 0 is kept by the vendor; other bits come from fields
  if (len > 35) for (let i = 35; i < len; i++) u[i] = rnd(256);
  if (len === 76) for (let i = 59; i < 75; i++) u[i] = 0;
  const vals = {};
  for (const f of FIELDS) {
    if (f.layout76 && len !== 76) continue;
    if (f.id === "steerAssistanceLighting" && ![6, 7, 8, 19].includes(hwType)) { vals[f.id] = 0; continue; }
    if (f.id === "enable_save" && [6, 7, 8, 19].includes(hwType)) { vals[f.id] = 0; continue; }
    vals[f.id] = pick(f.options)[0];
  }
  // fsd and apAutoOpenType are exclusive only when the user changes one; a module can report both.
  for (const [id, v] of Object.entries(vals)) {
    const f = BY_ID[id];
    u[f.byte] |= v << f.shift;
  }
  return u;
}

let checks = 0;

// 1. Option value lists match the vendor menus.
for (const hw of TSL_TYPES) {
  for (const rand of [0, 1]) {
    const { page } = loadVendor(hw);
    const p = validPayload(40, hw);
    p[28] = (p[28] & ~1) | rand;
    page.rx(160, p);
    const ours = decodeSettings(p);
    for (const f of FIELDS) {
      const vf = vendorField(page, f.id);
      if (!vf) { assert.fail(`vendor has no field ${f.id}`); }
      const vVals = Array.from(vf.data, d => d.val);
      const oVals = optionsFor(f, ours, hw).map(o => o[0]);
      assert.deepEqual(oVals, vVals, `hw ${hw} rand ${rand}: option values for ${f.id}`);
      checks++;
    }
  }
}

// 2. Decode matches the vendor: vendor index -> value equals our raw value.
// 3. Save without changes produces the same A3 payload as the vendor.
for (const hw of TSL_TYPES) {
  for (const len of [40, 76, 178]) {
    for (let n = 0; n < 300; n++) {
      const { page, sent } = loadVendor(hw);
      const p = validPayload(len, hw);
      page.rx(160, p);
      const ours = decodeSettings(p);
      for (const f of FIELDS) {
        if (!(f.id in ours)) continue;
        const vf = vendorField(page, f.id);
        // The vendor does not decode this bit on old types (it reuses the previous field's value).
        if (f.id === "steerAssistanceLighting" && ![6, 7, 8, 19].includes(hw)) continue;
        assert.equal(vf.data[vf.index].val, ours[f.id], `hw ${hw} len ${len}: decode ${f.id}`);
        checks++;
      }
      page.tx(163);
      assert.equal(sent.length, 1);
      const vendorOut = sent[0].buf;
      const ourOut = encodeSettings(p, ours, hw);
      assert.equal(sent[0].type, 163);
      assert.deepEqual(Array.from(ourOut), Array.from(vendorOut), `hw ${hw} len ${len}: A3 payload`);
      checks++;
    }
  }
}

// 4. A single change matches the vendor (vendor save handler + tx).
for (const hw of TSL_TYPES) {
  for (const f of FIELDS) {
    if (f.layout76 || f.group === "lab" && f.id !== "backHazardRearFogLight" && f.id !== "steerAssistanceLighting") continue;
    if (f.id === "steerAssistanceLighting" && ![6, 7, 8, 19].includes(hw)) continue;
    if (f.id === "enable_save" && [6, 7, 8, 19].includes(hw)) continue;
    for (const [val] of f.options) {
      const { page, sent } = loadVendor(hw);
      page.data.isAdmin = true;
      const p = validPayload(40, hw);
      page.rx(160, p);
      const vf = vendorField(page, f.id);
      const idx = vf.data.findIndex(d => d.val === val);
      page.save({ currentTarget: { dataset: { id: f.id } }, detail: { value: idx } });
      const vendorOut = sent.at(-1).buf;
      const vals = { ...decodeSettings(p), [f.id]: val };
      const ourOut = encodeSettings(p, vals, hw, f.id);
      assert.deepEqual(Array.from(ourOut), Array.from(vendorOut), `hw ${hw}: change ${f.id} -> ${val}`);
      checks++;
    }
  }
}

// 5. Policy difference, on purpose: unknown values and unmapped bits are kept.
{
  const hw = 19;
  const { page, sent } = loadVendor(hw);
  const p = validPayload(40, hw);
  p[26] = 42;            // beep value that no menu lists
  p[32] |= UNMAPPED[32]; // unmapped bit
  page.rx(160, p);
  page.tx(163);
  const v = sent[0].buf;
  const o = encodeSettings(p, decodeSettings(p), hw);
  assert.equal(v[26], 0, "vendor rewrites an unknown beep value to 0");
  assert.equal(o[26], 42, "we keep the unknown beep value");
  assert.equal(v[32] & UNMAPPED[32], 0, "vendor clears unmapped bits");
  assert.equal(o[32] & UNMAPPED[32], UNMAPPED[32], "we keep unmapped bits");
  checks += 4;
}

// 6. The prompt-build options are an app extra: only with promptBuild, first in the list.
for (const rand of [0, 1]) {
  const plain = optionsFor(BY_ID.time, { rand }, 6);
  const extra = optionsFor(BY_ID.time, { rand }, 6, { promptBuild: true });
  const promptVals = PROMPT_TIMES.map(([v]) => v);
  assert.ok(!plain.some(([v]) => promptVals.includes(v)), "vendor list has no prompt values");
  assert.deepEqual(extra.slice(0, promptVals.length).map(([v]) => v), promptVals, "promptBuild adds the prompt values first");
  assert.deepEqual(extra.slice(promptVals.length), plain, "the rest is the vendor list");
  for (const v of promptVals) {
    assert.equal(encodeSettings(validPayload(40, 6), { time: v }, 6, "time")[27] & 15, v, `time ${v} encodes`);
    assert.ok(isPromptTime(v) && promptDelayMs(v) > 0, `time ${v} is a prompt value`);
  }
  for (const v of [1, 2, 8, 15]) assert.ok(!isPromptTime(v) && promptDelayMs(v) === 0, `time ${v} is a stock value`);
  assert.deepEqual(PROMPT_TIMES.map(([, ms]) => ms), [300, 600, 1000, 1500, 2000, 3000, 5000], "delay means match scroll_prompt.S");
  checks += 4 + 2 * promptVals.length + 4;
}

console.log(`vendor-diff: ${checks} checks passed`);
