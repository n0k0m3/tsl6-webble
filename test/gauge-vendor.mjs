// Differential test: our gauge codec vs the vendor Mini App gauge page.
// The vendor code is not in this repo. Pass the paths to the unpacked, pretty-printed files:
//   node test/gauge-vendor.mjs ~/.cache/tsl6-miniapp/pkg/src/pages/gauge/gauge.js [.../gaugeMenu/gaugeMenu.js]
// All frames are synthetic.
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
import {
  B0, startPayload, stopPayload, GAUGE_CAR_ACTIONS, MIN_FRAME_LEN, FULL_FRAME_LEN,
  decodeGauge, formatGauge, doorsOpen, lightsOn, accelTestToggle, accelTestStep,
  GAUGE_MENU, normalizeGaugePrefs,
} from "../public/lib/tsl6-gauge.js";

const gaugeJs = process.argv[2];
const menuJs = process.argv[3];
if (!gaugeJs) { console.error("usage: node test/gauge-vendor.mjs <vendor gauge.js> [vendor gaugeMenu.js]"); process.exit(2); }

// ---------------------------------------------------------------- vendor harness
// The vendor file ends with compiled template code that needs the WeChat runtime.
// Keep only the page module (up to its require line).
function pageSource(path, name) {
  const src = fs.readFileSync(path, "utf8");
  const cut = src.indexOf(`require("pages/${name}/${name}.js");`);
  assert.ok(cut > 0, `cannot find the end of the ${name} page module`);
  return src.slice(0, cut);
}

const clock = { now: Date.UTC(2026, 0, 2, 3, 4, 5) };
class FakeDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(clock.now); }
  static now() { return clock.now; }
}

function loadPageDef(path, name, env) {
  let def = null;
  const req = n => {
    if (n.includes("601BF826")) return env.ble;
    throw new Error("unexpected require " + n);
  };
  const ctx = {
    define: (_n, factory) => factory(req, {}, {}),
    Page: d => { def = d; },
    getApp: () => env.app,
    wx: env.wx,
    Date: FakeDate,
    console,
  };
  vm.runInNewContext(pageSource(path, name), ctx, { filename: `${name}.js` });
  assert.ok(def, `${name}: Page() was not called`);
  return def;
}

const env = {
  sent: [], msgs: [], storage: {},
  ble: { tx: (type, buf) => env.sent.push({ type, buf: Array.from(buf) }) },
  app: {
    msg: (t) => env.msgs.push({ kind: "msg", text: t }),
    modal: (t) => env.msgs.push({ kind: "modal", text: t }),
    modalview() {},
    index: { bleIsConn: true, that: null },
    gauge: { that: null },
  },
  wx: {
    getStorageSync: k => env.storage[k],
    setStorageSync: (k, v) => { env.storage[k] = v; },
    removeStorageSync: k => { delete env.storage[k]; },
    navigateTo() {}, navigateBack() {}, setKeepScreenOn() {},
  },
};
const gaugeDef = loadPageDef(gaugeJs, "gauge", env);

// A fresh page instance. The timer is not started (onShow is not called).
function newPage(gaugePrefs = {}) {
  const page = Object.assign(Object.create(gaugeDef), {
    var: structuredClone(gaugeDef.var),
    data: structuredClone(gaugeDef.data),
    setData(d) { if (d !== this.data) for (const k of Object.keys(d)) this.data[k] = d[k]; },
  });
  page.data.gauge = { ...normalizeGaugePrefs({}), ...gaugePrefs };
  page.var.isShow = true;
  env.sent.length = 0;
  env.msgs.length = 0;
  return page;
}

// ---------------------------------------------------------------- helpers
let seed = 0x5eed;
const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const randFrame = len => Uint8Array.from({ length: len }, () => rnd(256));
const now = () => new FakeDate();
let checks = 0;

// Compare everything the vendor rx writes with our decoder + formatter.
function compareFrame(frame, label) {
  const page = newPage();
  page.rx(B0, frame);
  const v = page.data;
  const d = decodeGauge(frame);
  const f = formatGauge(d, now());
  const eq = (a, b, what) => { assert.deepEqual(a, b, `${label}: ${what}`); checks++; };
  eq(String(v.speed), f.speedText, "speed text");
  eq(v.speedType, f.bigSpeed, "speedType");
  for (const k of ["gear", "turn", "autoPilot", "door", "light", "sport", "frunkIsOpen", "trunkIsOpen",
    "accelPedalPos", "rearInverterPower", "frontInverterPower", "battHeat", "speedUnits", "handsOn",
    "hvacBlowerSpeedRPM", "wattsDemandEvap", "hvacCabinTempEst", "tempAmbientRaw", "fusedSpeedLimit"]) {
    eq(v[k], f[k], k);
  }
  for (const k of ["LeftBottom", "RightBottom", "Pressure", "brakeTemp", "blindSpotRear"]) eq(Array.from(v[k]), f[k], k);
  eq(page.var.setKeepScreenOn, f.keepScreenOn, "keep screen on");
  eq(page.var.aspect, d.carLightTheme, "car light theme");
  eq(v.aspect, d.carLightTheme, "aspect follows the car (gaugeAspect 0)");
  eq(page.var.gear, d.gear, "var.gear");
  return d;
}

// ---------------------------------------------------------------- 1. start / stop
{
  const page = newPage();
  page.getAllData();
  page.offGauge();
  assert.deepEqual(env.sent, [{ type: B0, buf: Array.from(startPayload()) }, { type: B0, buf: Array.from(stopPayload()) }]);
  checks++;
}

// ---------------------------------------------------------------- 2. random frames, all lengths
for (const len of [16, 20, 32, 33, 34, 40, 64]) {
  for (let n = 0; n < 2000; n++) compareFrame(randFrame(len), `len ${len} #${n}`);
}
assert.equal(decodeGauge(new Uint8Array(MIN_FRAME_LEN - 1)), null, "short frame is rejected");
assert.equal(decodeGauge(new Uint8Array(FULL_FRAME_LEN - 1)).full, false);
assert.equal(decodeGauge(new Uint8Array(FULL_FRAME_LEN)).full, true);
checks += 3;

// ---------------------------------------------------------------- 3. byte sweeps: every value of every byte
for (const len of [16, 33]) {
  for (let pos = 0; pos < len; pos++) {
    for (let val = 0; val < 256; val++) {
      const fr = randFrame(len);
      fr[pos] = val;
      compareFrame(fr, `len ${len} byte ${pos}=${val}`);
    }
  }
}

// ---------------------------------------------------------------- 4. field sweeps across byte borders
function setBits(fr, bitOff, width, value) {
  for (let i = 0; i < width; i++) {
    const b = bitOff + i, byte = b >> 3, bit = b & 7;
    fr[byte] = (fr[byte] & ~(1 << bit)) | (((value >> i) & 1) << bit);
  }
}
const SWEEPS = [
  ["speed", 0, 9], ["gear", 9, 3], ["odometer", 38, 26], ["rearPower", 104, 11], ["frontPower", 115, 11],
  ["altitude", 126, 14], ["brakeTemp0", 144, 10], ["brakeTemp1", 154, 10], ["brakeTemp2", 164, 10], ["brakeTemp3", 174, 10],
  ["blower", 184, 10], ["evap", 194, 11], ["cabin", 205, 11], ["cellV", 224, 12], ["range", 236, 10],
  ["battTemp", 246, 9], ["speedLimit", 255, 5],
];
for (const [name, off, width] of SWEEPS) {
  const max = 2 ** width;
  const step = Math.max(1, Math.floor(max / 4096));
  for (let v = 0; v < max; v += step) {
    const fr = randFrame(33);
    setBits(fr, off, width, v);
    compareFrame(fr, `sweep ${name}=${v}`);
  }
}

// ---------------------------------------------------------------- 5. door, light and wheel order
{
  const fr = new Uint8Array(33);
  const names = ["fl", "rl", "fr", "rr"]; // door bit 0..3
  for (let b = 0; b < 4; b++) {
    fr[2] = 1 << b;
    const open = doorsOpen(decodeGauge(fr));
    for (const n of names) assert.equal(open[n], n === names[b], `door bit ${b}`);
    checks++;
  }
  fr[2] = 0;
  fr[2] = 0xf0; fr[3] = 0x80; fr[4] = 0x10; // all six light bits
  assert.deepEqual(lightsOn(decodeGauge(fr)), { highBeam: true, lowBeam: true, position: true, frontFog: true, rearFog: true, brake: true });
  fr[2] = 0; fr[3] = 0; fr[4] = 0;
  fr[8] = 80; fr[9] = 0; fr[10] = 255; fr[11] = 100; // pressure FL, FR, RL, RR
  assert.deepEqual(decodeGauge(fr).tirePressureBar, [2, null, null, 2.5]);
  checks += 2;
}

// ---------------------------------------------------------------- 6. car actions from the gauge page
{
  const doors = ["doorfl", "doorfr", "doorrl", "doorrr"];
  for (let s = 0; s < 4; s++) {
    const page = newPage();
    page.rx(B0, Uint8Array.of(0, 2, 0, 0, ...new Array(29).fill(0))); // P, speed 0
    page.btn({ currentTarget: { dataset: { fun: doors[s], btn: String(s) } } });
    const act = GAUGE_CAR_ACTIONS[s];
    assert.deepEqual(env.sent.at(-1), { type: 0xa7, buf: [act.a7] }, `door ${s}`);
    assert.equal(env.msgs.at(-1).text, act.zh);
    checks += 2;
  }
  // Moving: the vendor refuses to open a door.
  const page = newPage();
  page.rx(B0, Uint8Array.of(10, 8, 0, 0, ...new Array(29).fill(0))); // D, speed 10
  page.btn({ currentTarget: { dataset: { fun: "doorfl", btn: "0" } } });
  assert.equal(env.sent.length, 0);
  checks++;
  // Battery heat toggles between A7 05 (on) and A7 04 (off).
  for (const heat of [0, 1, 2]) {
    const p = newPage();
    const fr = new Uint8Array(33); fr[17] = heat << 4;
    p.rx(B0, fr);
    p.battHeat();
    const want = GAUGE_CAR_ACTIONS.find(a => a.id === (decodeGauge(fr).battHeat ? "battHeatOff" : "battHeatOn")).a7;
    assert.deepEqual(env.sent.at(-1), { type: 0xa7, buf: [want] });
    checks++;
  }
}

// ---------------------------------------------------------------- 7. 0-100 test
{
  const frame = (speed, gear) => {
    const fr = new Uint8Array(33);
    setBits(fr, 0, 9, speed); setBits(fr, 9, 3, gear);
    return fr;
  };
  const press = p => p.btn({ currentTarget: { dataset: { fun: "speedUpTest" } } });

  // Refusals and arm.
  for (const [speed, gear] of [[0, 1], [0, 2], [0, 3], [0, 0], [5, 4], [0, 4]]) {
    const p = newPage();
    p.rx(B0, frame(speed, gear));
    press(p);
    const ours = accelTestToggle(0, decodeGauge(frame(speed, gear)));
    assert.equal(p.data.speedUpTest, ours.state, `toggle speed ${speed} gear ${gear}`);
    assert.equal(env.msgs.at(-1).text, ours.zh);
    checks += 2;
  }

  // Full run, then a too-slow run.
  for (const [finishMs, event] of [[4567, "result"], [150000, "tooSlow"]]) {
    const p = newPage();
    clock.now = 1_000_000;
    p.rx(B0, frame(0, 4));
    press(p);
    let t = { state: 1 };
    const feed = (speed, ms) => {
      clock.now = ms;
      p.rx(B0, frame(speed, 4));
      t = accelTestStep(t, speed, ms);
      assert.equal(p.data.speedUpTest, t.state, `state at speed ${speed}`);
      checks++;
    };
    feed(0, 1_000_100);
    feed(1, 1_000_200);
    assert.equal(env.msgs.at(-1).text, "测试开始");
    feed(60, 1_002_000);
    feed(100, 1_000_200 + finishMs);
    assert.equal(t.event, event);
    if (event === "result") assert.deepEqual(env.msgs.at(-1), { kind: "modal", text: "百公里加速\r\n本次成绩 " + t.seconds + " 秒" });
    else assert.equal(env.msgs.at(-1).text, "成绩太次\r\n退出测试");
    checks += 2;
  }

  // Press while armed: exit.
  const p = newPage();
  p.rx(B0, frame(0, 4));
  press(p); press(p);
  const ours = accelTestToggle(1, decodeGauge(frame(0, 4)));
  assert.equal(p.data.speedUpTest, ours.state);
  assert.equal(env.msgs.at(-1).text, ours.zh);
  checks += 2;
}

// ---------------------------------------------------------------- 8. a short frame keeps the extended values
{
  const page = newPage();
  const full = randFrame(40), short = randFrame(20);
  page.rx(B0, full);
  page.rx(B0, short);
  const f = formatGauge(decodeGauge(short), now(), formatGauge(decodeGauge(full), now()));
  for (const k of ["LeftBottom", "RightBottom", "brakeTemp", "blindSpotRear"]) assert.deepEqual(Array.from(page.data[k]), f[k], k);
  for (const k of ["fusedSpeedLimit", "hvacCabinTempEst", "battHeat", "handsOn"]) assert.equal(page.data[k], f[k], k);
  checks += 8;
}

// ---------------------------------------------------------------- 9. gauge menu tables
{
  const page = newPage();
  env.storage.gauge = { gaugeType: 2, gaugeLeftBottom: 4, gaugeRightBottom: 3, gaugeAspect: 2 };
  page.onShow = gaugeDef.onShow; // run the vendor prefs loader, but stop its timer
  page.timer = () => {};
  page.onShow();
  const ours = normalizeGaugePrefs(env.storage.gauge);
  for (const m of GAUGE_MENU) assert.equal(page.data.gauge[m.id], ours[m.id], `prefs ${m.id}`);
  assert.equal(page.data.LeftBottomIdx, 0, "cycle mode starts at item 0");
  assert.equal(page.data.RightBottomIdx, 3);
  assert.equal(page.data.aspect, 1, "gaugeAspect 2 (light) -> aspect 1");
  checks += GAUGE_MENU.length + 3;
  delete env.storage.gauge;

  if (menuJs) {
    const menuDef = loadPageDef(menuJs, "gaugeMenu", env);
    const vList = JSON.parse(JSON.stringify(menuDef.data.list)); // host-realm copy
    assert.deepEqual(vList.map(m => m.id), GAUGE_MENU.map(m => m.id), "menu ids and order");
    for (const [i, m] of GAUGE_MENU.entries()) {
      assert.equal(vList[i].name, m.zh, `${m.id} name`);
      assert.deepEqual(vList[i].data.map(o => [o.val, o.name]), m.options.map(o => [o[0], o[2]]), `${m.id} options`);
      // The vendor stores the picker index. Our values must equal the index.
      m.options.forEach((o, idx) => assert.equal(o[0], idx));
      checks += 3;
    }
  } else {
    console.log("gauge-vendor: no gaugeMenu.js given, menu table diff skipped");
  }
}

console.log(`gauge-vendor: ${checks} checks passed`);
