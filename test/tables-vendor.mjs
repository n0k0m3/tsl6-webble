// Differential test: our table codec vs the vendor Mini App pages btn, blebtn and backup,
// and the vendor write check (app.js setCheckData/getCheckData).
// The vendor code is not in this repo. Pass the unpacked, pretty-printed source directory:
//   node test/tables-vendor.mjs ~/.cache/tsl6-miniapp/pkg/src
// It reads app.js, pages/btn/btn.js, pages/blebtn/blebtn.js and pages/backup/backup.js from there.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import {
  CMD, READ_TABLE, BLE_PAIR_START, MAGIC, TABLE_LEN, SHORTCUT_SLOTS, BLE_SLOTS, FACTORY_SHORTCUTS,
  decodeShortcuts, encodeShortcuts, decodeBleButtons, encodeBleButtons, parseBleNotify, tryPayload,
  funName, funNamesAll, validateFunList, WriteCheck, makeBackup, readBackup, restorePlan,
  tableWriteBlocker, emptyTable, LABELS,
} from "../public/lib/tsl6-tables.js";
import { hex } from "../public/lib/tsl6-settings.js";

const srcDir = process.argv[2];
if (!srcDir) { console.error("usage: node test/tables-vendor.mjs <vendor pkg/src directory>"); process.exit(2); }
const SRC = {
  app: path.join(srcDir, "app.js"),
  btn: path.join(srcDir, "pages/btn/btn.js"),
  blebtn: path.join(srcDir, "pages/blebtn/blebtn.js"),
  backup: path.join(srcDir, "pages/backup/backup.js"),
};

// Only the define(...) call. The rest of each file is compiled template code that needs the WeChat runtime.
function defineOnly(file) {
  const s = fs.readFileSync(file, "utf8");
  const end = s.indexOf('\nrequire("');
  return end > 0 ? s.slice(0, end) : s;
}

// ---------------------------------------------------------------- random data (synthetic only)
let seed = 4242;
const rnd = n => { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) % n;
};
const randBytes = n => Uint8Array.from({ length: n }, () => rnd(256));

function randomFunList() {
  const group = (prefix, count, withZero) => Array.from({ length: count }, (_, g) => ({
    name: `${prefix} group ${g}`,
    data: [
      ...(withZero && g === 0 ? [{ val: 0, name: `${prefix} none` }] : []),
      ...Array.from({ length: 4 + rnd(12) }, () => {
        const val = 1 + rnd(255);
        return { val, name: `${prefix}${val}/g${g}`, ...(rnd(4) === 0 ? { attemp: 1, title: "help" } : {}) };
      }),
    ],
  }));
  return { success: true, btn: group("T", 3, false), fun: group("A", 4, true) };
}

// ---------------------------------------------------------------- vendor harness
// Real app.js helpers: setCheckData/getCheckData, Dec2Hex/Hex2Dec.
let appDef = null;
vm.runInNewContext(defineOnly(SRC.app), {
  define: (_n, f) => f(() => ({}), {}, {}),
  App: d => { appDef = d; },
  wx: {}, console,
});
assert.ok(appDef && appDef.getCheckData && appDef.setCheckData, "app.js check helpers");

function loadVendor(which, opts = {}) {
  let pageDef = null;
  const sent = [], toasts = [], modals = [], requests = [];
  const storage = new Map(Object.entries(opts.storage || {}));
  const ble = { tx: (type, buf) => sent.push({ type, buf: Uint8Array.from(buf || []) }) };
  const dev = { deviceinfo: { hw_ver: 6, buf: opts.status || new Uint8Array(76), id: opts.uid || "" } };
  const app = {
    checkData: { count: 0, type: 0, buf: null },
    setCheckData: appDef.setCheckData, getCheckData: appDef.getCheckData,
    Dec2Hex: appDef.Dec2Hex, Hex2Dec: appDef.Hex2Dec,
    msg: (t, e) => toasts.push(t),
    modal: (t, cancel, ok) => { modals.push(t); if (ok) ok({ confirm: true }); },
    input: (ph, ok) => ok({ content: opts.inputText ?? "" }),
    modalview() {}, isAdmin: () => 0,
    getFunListJs: cb => cb(opts.funList, false),
    getjson: (q, cb) => { requests.push(q); if (opts.server) cb(opts.server(q)); },
    index: { that: null }, set: { that: null }, btn: {}, blebtn: {}, backup: {},
  };
  const chain = { select: () => chain, boundingClientRect: () => chain, exec() {} };
  const wx = {
    getStorageSync: k => storage.get(k), setStorageSync: (k, v) => storage.set(k, structuredClone(v)),
    showLoading: o => toasts.push("loading:" + o.title), createSelectorQuery: () => chain, pageScrollTo() {},
    navigateTo() {},
  };
  const req = name => {
    if (name.includes("defineProperty")) return (o, k, v) => { o[k] = v; return o; };
    if (name.includes("601BF826")) return ble;
    if (name.includes("0FF8F134")) return dev;
    throw new Error("unexpected require " + name);
  };
  vm.runInNewContext(defineOnly(SRC[which]), {
    define: (_n, f) => f(req, {}, {}), Page: d => { pageDef = d; }, getApp: () => app, wx, console,
  });
  const page = Object.assign(Object.create(pageDef), {
    data: structuredClone(pageDef.data),
    setData(d) { if (d !== this.data) for (const k of Object.keys(d)) if (!/[.[]/.test(k)) this.data[k] = d[k]; },
    selectComponent: () => ({ showModal() {} }),
  });
  return { page, sent, toasts, modals, requests, storage, app };
}

const ev = (fun, extra = {}) => ({ currentTarget: { dataset: { fun, ...extra } } });
const pick = (sel, idx, fun, val) => ({ detail: { currentTarget: { dataset: { idx, fun, val } } } });
let checks = 0;
const seen = {}; // how often each edit path ran
const saw = k => { seen[k] = (seen[k] || 0) + 1; };
const eqBytes = (a, b, msg) => { assert.deepEqual(Array.from(a), Array.from(b), msg); checks++; };

// ---------------------------------------------------------------- AB tables
function randomShortcutTable() {
  const t = new Uint8Array(TABLE_LEN);
  const fill = rnd(4) === 0 ? 1 : rnd(3) === 0 ? 0.95 : 0.3;
  for (let n = 0; n < SHORTCUT_SLOTS; n++) {
    if (rnd(1000) < fill * 1000) { t[2 * n] = 1 + rnd(255); t[2 * n + 1] = rnd(256); }
    else t[2 * n + 1] = rnd(3) === 0 ? rnd(256) : 0; // action byte left in an empty slot
  }
  t[254] = rnd(4) === 0 ? rnd(256) : 0;
  t[255] = rnd(10) === 0 ? rnd(256) : MAGIC;
  return t;
}

// 1. Read request, decode and names.
for (let n = 0; n < 400; n++) {
  const funList = randomFunList();
  assert.deepEqual(validateFunList(funList), []);
  const v = loadVendor("btn", { funList });
  v.page.onShow();
  assert.equal(v.sent[0].type, CMD.SHORTCUTS);
  eqBytes(v.sent[0].buf, READ_TABLE, "AB read request");
  const table = randomShortcutTable();
  v.page.rx(CMD.SHORTCUTS, Uint8Array.from(table));
  const ours = decodeShortcuts(table);
  assert.equal(v.page.data.datalist.length, ours.length, "shortcut count");
  ours.forEach((e, i) => {
    const d = v.page.data.datalist[i];
    assert.equal(d.btn, e.trigger); assert.equal(d.fun, e.action);
    assert.equal(d.btnname, funName(funList.btn, e.trigger) ?? LABELS.triggerNone.zh);
    assert.equal(d.funname, funName(funList.fun, e.action) ?? LABELS.actionNone.zh);
    checks += 4;
  });
}

// 2. Edits produce the same AB write; the echo ends the write check without a re-send.
const OPS = ["remove", "removeAll", "saveTrigger", "saveAction", "moveUp", "moveDown", "addThenAction"];
for (let n = 0; n < 1500; n++) {
  const funList = randomFunList();
  const v = loadVendor("btn", { funList });
  v.page.onShow();
  const table = randomShortcutTable();
  table[255] = MAGIC;
  v.page.rx(CMD.SHORTCUTS, Uint8Array.from(table));
  const entries = decodeShortcuts(table).map(({ trigger, action }) => ({ trigger, action }));
  const op = OPS[n % OPS.length];
  if (entries.length === 0 && op !== "removeAll" && op !== "addThenAction") continue;
  const i = rnd(Math.max(entries.length, 1));
  const val = 1 + rnd(255);
  switch (op) {
    case "remove": v.page.btn(ev("remove", { idx: i })); entries.splice(i, 1); break;
    case "removeAll": v.page.btn(ev("removeAll")); entries.length = 0; break;
    case "saveTrigger": v.page.save(pick(0, i, "btn", val)); entries[i].trigger = val; break;
    case "saveAction": v.page.save(pick(0, i, "fun", val - 1)); entries[i].action = val - 1; break;
    case "moveUp": case "moveDown": {
      const up = op === "moveUp";
      v.page.btn({ type: "longpress", changedTouches: [{ clientY: 500 }], ...ev("move", { idx: i }) });
      v.page.btn({ type: "touchend", changedTouches: [{ clientY: up ? 440 : 560 }], ...ev("move", { idx: i }) });
      const j = up ? i - 1 : i + 1;
      if (j < 0 || j >= entries.length) { assert.equal(v.sent.length, 1, "no write at the list end"); checks++; continue; }
      [entries[i], entries[j]] = [entries[j], entries[i]];
      break;
    }
    case "addThenAction": {
      if (entries.length >= SHORTCUT_SLOTS) continue;
      v.page.btn(ev("add"));
      assert.equal(v.sent.length, 1, "add alone does not write"); checks++;
      const k = v.page.data.datalist.length - 1;
      v.page.save(pick(0, k, "fun", val));
      entries.push({ trigger: 1, action: val }); // vendor placeholder trigger is 1
      break;
    }
  }
  const w = v.sent.at(-1);
  assert.equal(w.type, CMD.SHORTCUTS);
  saw("AB " + op);
  const ours = encodeShortcuts(table, entries);
  eqBytes(w.buf, ours, `AB write after ${op}`);
  assert.equal(tableWriteBlocker(ours), null); checks++;
  const before = v.sent.length;
  v.page.rx(CMD.SHORTCUTS, Uint8Array.from(ours));
  assert.equal(v.sent.length, before, "matching echo: no re-send"); checks++;
  if (op === "remove" || op === "removeAll") { assert.equal(v.toasts.at(-1), "删除成功"); checks++; }
}

// 3. Write check: k wrong echoes. The vendor re-sends; WriteCheck must do the same.
for (let k = 0; k <= 7; k++) {
  for (const finalOk of [true, false]) {
    const funList = randomFunList();
    const v = loadVendor("btn", { funList });
    v.page.onShow();
    const table = randomShortcutTable(); table[255] = MAGIC;
    v.page.rx(CMD.SHORTCUTS, Uint8Array.from(table));
    v.page.btn(ev("removeAll"));
    const payload = v.sent.at(-1).buf;
    const chk = new WriteCheck(CMD.SHORTCUTS, payload);
    const wrong = Uint8Array.from(payload); wrong[0] ^= 1;
    let ourResends = 0, ourDone = null;
    const replies = [...Array(k).fill(wrong), finalOk ? payload : wrong];
    for (const r of replies) {
      const before = v.sent.length;
      v.page.rx(CMD.SHORTCUTS, Uint8Array.from(r));
      const vendorResent = v.sent.length > before;
      if (vendorResent) { saw("vendor re-send"); eqBytes(v.sent.at(-1).buf, payload, "re-sent payload"); }
      const res = chk.onReply(CMD.SHORTCUTS, r);
      if (res.action === "resend") { ourResends++; eqBytes(res.payload, payload, "our re-send payload"); }
      if (res.action === "done") ourDone = res;
      assert.equal(res.action === "resend", vendorResent, `k=${k}: re-send decision`); checks++;
      if (ourDone) break;
    }
    assert.ok(ourResends <= 4); checks++;
    assert.equal(chk.sends, 1 + ourResends); checks++;
  }
}
assert.deepEqual(new WriteCheck(CMD.SHORTCUTS, [1]).onReply(CMD.BLE_BUTTONS, [2]), { action: "ignore" }); checks++;

// 4. BB "try" from a shortcut row.
for (let a = 0; a < 256; a += 17) {
  const v = loadVendor("btn", { funList: randomFunList() });
  v.page.btn(ev("test", { id: a }));
  assert.equal(v.sent[0].type, CMD.TRY);
  eqBytes(v.sent[0].buf, tryPayload(a), "BB payload");
}

// ---------------------------------------------------------------- BA tables
function randomBleTable() {
  const t = new Uint8Array(TABLE_LEN);
  const fill = rnd(4) === 0 ? 1 : 0.4;
  for (let n = 0; n < BLE_SLOTS; n++) {
    const o = n * 6;
    if (rnd(1000) < fill * 1000) { t.set(randBytes(6), o); if (rnd(3) === 0) t[o] = 249; if (rnd(3) === 0) t[o + 1] = 248; }
    else if (rnd(5) === 0) { t[o] = rnd(256); t[o + 1] = rnd(256); } // actions with id 0 (empty)
  }
  t.set(rnd(4) === 0 ? randBytes(3) : [0, 0, 0], 252);
  t[255] = MAGIC;
  return t;
}
const bleStorage = (table) => {
  const names = {}, bats = {};
  for (const e of decodeBleButtons(table)) {
    if (rnd(2)) names["id" + e.id] = "Btn " + e.idHex.slice(0, 4);
    if (rnd(2)) bats["id" + e.id] = rnd(101);
  }
  names["id12345"] = "stale"; bats["id12345"] = 50; // ids not in the table
  return { blename: names, blebat: bats };
};

// 5. Read, decode, names, battery, and the vendor storage clean-up.
for (let n = 0; n < 400; n++) {
  const funList = randomFunList();
  const table = randomBleTable();
  const storage = bleStorage(table);
  const v = loadVendor("blebtn", { funList, storage: structuredClone(storage) });
  v.page.onShow();
  assert.equal(v.sent[0].type, CMD.BLE_BUTTONS);
  eqBytes(v.sent[0].buf, READ_TABLE, "BA read request");
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(table));
  const ours = decodeBleButtons(table);
  assert.equal(v.page.data.datalist.length, ours.length, "BLE button count");
  ours.forEach((e, i) => {
    const d = v.page.data.datalist[i];
    assert.equal(d.Click, e.click); assert.equal(d.dbClick, e.dblClick); assert.equal(d.id, e.id);
    assert.equal(d.ClickName, funName(funList.fun, e.click) ?? LABELS.actionNone.zh);
    assert.equal(d.dbClickName, funName(funList.fun, e.dblClick) ?? LABELS.actionNone.zh);
    assert.equal(d.name, storage.blename["id" + e.id] || LABELS.bleButton.zh);
    assert.equal(d.bat, storage.blebat["id" + e.id] || "null"); // vendor quirk: 0 % shows as "null"
    checks += 7;
  });
  const keep = new Set(ours.map(e => "id" + e.id));
  const pruned = o => Object.fromEntries(Object.entries(o).filter(([k]) => keep.has(k)));
  assert.deepEqual(v.storage.get("blename"), pruned(storage.blename), "names of removed buttons are deleted");
  assert.deepEqual(v.storage.get("blebat"), pruned(storage.blebat), "battery of removed buttons is deleted");
  checks += 2;
}

// 6. Edits produce the same BA write.
const BLE_OPS = ["remove", "removeAll", "saveClick", "saveDbl", "moveUp", "moveDown"];
for (let n = 0; n < 1200; n++) {
  const funList = randomFunList();
  const table = randomBleTable();
  const v = loadVendor("blebtn", { funList, storage: bleStorage(table) });
  v.page.onShow();
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(table));
  const entries = decodeBleButtons(table).map(({ click, dblClick, idHex }) => ({ click, dblClick, idHex }));
  const op = BLE_OPS[n % BLE_OPS.length];
  if (entries.length === 0 && op !== "removeAll") continue;
  const i = rnd(Math.max(entries.length, 1));
  const val = rnd(256);
  switch (op) {
    case "remove": v.page.btn(ev("remove", { idx: i })); entries.splice(i, 1); break;
    case "removeAll": v.page.btn(ev("removeAll")); entries.length = 0; break;
    case "saveClick": v.page.save(pick(0, i, "Click", val)); entries[i].click = val; break;
    case "saveDbl": v.page.save(pick(0, i, "dbClick", val)); entries[i].dblClick = val; break;
    case "moveUp": case "moveDown": {
      const up = op === "moveUp";
      v.page.btn({ type: "longpress", changedTouches: [{ clientY: 300 }], ...ev("move", { idx: i }) });
      v.page.btn({ type: "touchend", changedTouches: [{ clientY: up ? 200 : 400 }], ...ev("move", { idx: i }) });
      const j = up ? i - 1 : i + 1;
      if (j < 0 || j >= entries.length) continue;
      [entries[i], entries[j]] = [entries[j], entries[i]];
      break;
    }
  }
  const w = v.sent.at(-1);
  assert.equal(w.type, CMD.BLE_BUTTONS);
  saw("BA " + op);
  eqBytes(w.buf, encodeBleButtons(table, entries), `BA write after ${op}`);
  if (op === "removeAll") { assert.deepEqual(v.storage.get("blename"), {}); checks++; }
}

// 7. Pairing: BA 01, echo, 6-byte message, write, echo with the name.
for (let n = 0; n < 400; n++) {
  const funList = randomFunList();
  let table = randomBleTable();
  while (decodeBleButtons(table).length >= BLE_SLOTS) table = randomBleTable();
  const v = loadVendor("blebtn", { funList, inputText: n % 5 ? "Key " + n : "" });
  v.page.onShow();
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(table));
  v.page.btn(ev("add"));
  assert.equal(v.sent.at(-1).type, CMD.BLE_BUTTONS);
  eqBytes(v.sent.at(-1).buf, BLE_PAIR_START, "pair start");
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.of(1));
  assert.equal(parseBleNotify([1]).kind, "pairAck");
  assert.equal(v.toasts.at(-1), "loading:请点击蓝牙按钮"); checks++;
  let msg = randBytes(6);
  while (msg[0] === 0 && msg[1] === 0 && msg[2] === 0 && msg[3] === 0) msg = randBytes(6);
  const learned = parseBleNotify(msg);
  assert.equal(learned.kind, "learned");
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(msg));
  const entries = [...decodeBleButtons(table), learned].map(({ click, dblClick, idHex }) => ({ click, dblClick, idHex }));
  const ours = encodeBleButtons(table, entries);
  eqBytes(v.sent.at(-1).buf, ours, "BA write after pairing");
  assert.equal(v.storage.get("blebat")["id" + learned.id], learned.battery, "battery from pairing message"); checks++;
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(ours));
  assert.equal(v.storage.get("blename")["id" + learned.id], n % 5 ? "Key " + n : LABELS.bleButton.zh);
  assert.equal(v.toasts.at(-1), "添加成功"); checks += 2;
}

// 8. Press message (7 bytes): vendor toast text and battery.
for (let n = 0; n < 400; n++) {
  const funList = randomFunList();
  const table = randomBleTable();
  let list = decodeBleButtons(table);
  if (n % 10 === 0 && list.length >= 2) { // two entries with the same id
    table.set(table.slice(list[0].slot * 6 + 2, list[0].slot * 6 + 6), list[1].slot * 6 + 2);
    list = decodeBleButtons(table);
  }
  if (!list.length) continue;
  const storage = bleStorage(table);
  const v = loadVendor("blebtn", { funList, storage: structuredClone(storage) });
  v.page.onShow();
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(table));
  const b = n % 10 === 0 ? list[0] : list[rnd(list.length)];
  if (list.filter(e => e.id === b.id).length > 1) saw("press on a duplicate id");
  const msg = new Uint8Array(7);
  msg.set(table.slice(b.slot * 6 + 2, b.slot * 6 + 6), 0);
  msg[4] = rnd(256); msg[5] = rnd(4) === 0 ? 0x80 | rnd(16) : rnd(16); msg[6] = rnd(2);
  const p = parseBleNotify(msg);
  assert.equal(p.kind, "press"); assert.equal(p.id, b.id);
  v.page.rx(CMD.BLE_BUTTONS, Uint8Array.from(msg));
  // The vendor lists the action names of every table entry with this id.
  const names = list.filter(e => e.id === b.id)
    .flatMap(e => funNamesAll(funList.fun, p.double ? e.dblClick : e.click)).map(s => s + " ").join("");
  const who = storage.blename["id" + b.id] || LABELS.bleButton.zh;
  const kind = p.double ? LABELS.dblClick.zh : LABELS.click.zh;
  assert.equal(v.toasts.at(-1), `${who} ${kind}\r\n${names || LABELS.pressNone.zh}`);
  const old = storage.blebat["id" + b.id];
  const expectBat = typeof old !== "number" || Math.abs(old - p.battery) >= 3 ? p.battery : old;
  assert.equal(v.storage.get("blebat")["id" + b.id], expectBat);
  checks += 4;
}

// 9. BB "try" from a BLE button row.
{
  const v = loadVendor("blebtn", { funList: randomFunList() });
  v.page.btn(ev("test", { id: 249 }));
  eqBytes(v.sent[0].buf, tryPayload(249), "BB payload from blebtn");
}

// ---------------------------------------------------------------- backup page
function randomStatus(uidSeed) {
  const s = randBytes(76);
  s[0] = 0; s[3] = 1;
  for (let i = 4; i < 18; i++) s[i] = (uidSeed * 7 + i) & 255;
  for (let i = 36; i < 40; i++) s[i] = 0x30 + rnd(10);         // printable password
  s[40] = 1; for (let i = 41; i < 58; i++) s[i] = 0x41 + rnd(26); // synthetic VIN
  return s;
}

for (let n = 0; n < 200; n++) {
  const current = randomStatus(1);
  const other = randomStatus(2); // the backup came from another module
  other.set(current.slice(40, 59), 40); // same VIN block, so the vendor and our restore match byte for byte
  const ab = encodeShortcuts(null, Array.from({ length: rnd(20) }, () => ({ trigger: 1 + rnd(255), action: rnd(256) })));
  const ba = encodeBleButtons(null, Array.from({ length: rnd(10) }, () => ({ click: rnd(256), dblClick: rnd(256), idHex: hex(randBytes(4)) })));
  const file = JSON.parse(JSON.stringify(makeBackup({ settings: other, shortcuts: ab, bleButtons: ba }, { redact: false })));
  const backup = readBackup(file);
  const server = q => ({ success: true, data: [
    { id: "set", name: "1", backupTime: "t", share: 0, backupData: file.blocks.settings.hex },
    { id: "btn", name: "2", backupTime: "t", share: 0, backupData: file.blocks.shortcuts.hex },
    { id: "ble", name: "3", backupTime: "t", share: 0, backupData: file.blocks.bleButtons.hex },
  ] });
  const v = loadVendor("backup", { status: current, uid: "UID", server });
  v.page.onShow();
  assert.match(v.requests[0], /^fun=getBackup&id=UID&local=1&msg=local$/); checks++;
  const plan = restorePlan(backup, current, { keepPassword: false });
  ["set", "btn", "ble"].forEach((id, k) => {
    v.page.btn(ev("recover", { id }));
    const w = v.sent.at(-1);
    assert.equal(w.type, plan[k].type, `restore ${id}: type`);
    eqBytes(w.buf, plan[k].payload, `restore ${id}: payload`);
    v.page.rx(w.type, Uint8Array.from(w.buf));
    assert.equal(v.toasts.at(-1), "恢复成功"); checks++;
    assert.ok(plan[k].accept(w.type, w.buf)); checks++;
  });
  // Our default keeps the current password; the vendor writes the backup password.
  const safe = restorePlan(readBackup(makeBackup({ settings: other }, { redact: n % 2 === 0 })), current);
  eqBytes(safe[0].payload.slice(36, 40), current.slice(36, 40), "restore keeps the current password");
  eqBytes(safe[0].payload.slice(0, 18), current.slice(0, 18), "restore uses the current module id");
  // A runtime reply is A0 with live bytes 18-23: our accept() takes it.
  const reply = Uint8Array.from(safe[0].payload); reply.set(randBytes(6), 18);
  assert.ok(safe[0].accept(CMD.STATUS, reply)); checks++;

  // Backup: the vendor reads each block and uploads it as upper-case hex.
  const v2 = loadVendor("backup", { status: current, uid: "UID", server });
  v2.page.onShow();
  [["set", CMD.STATUS, [0], current], ["btn", CMD.SHORTCUTS, READ_TABLE, ab], ["ble", CMD.BLE_BUTTONS, READ_TABLE, ba]]
    .forEach(([id, type, req, data]) => {
      v2.page.btn(ev("backup", { id }));
      assert.equal(v2.sent.at(-1).type, type);
      eqBytes(v2.sent.at(-1).buf, req, `backup ${id}: read request`);
      v2.page.rx(type, Uint8Array.from(data));
      const ourHex = makeBackup({ [id === "set" ? "settings" : id === "btn" ? "shortcuts" : "bleButtons"]: data }, { redact: false });
      const block = ourHex.blocks.settings || ourHex.blocks.shortcuts || ourHex.blocks.bleButtons;
      assert.equal(v2.requests.at(-1), `fun=getBackup&id=UID&local=1&msg=backup&dataid=${id}&data=${block.hex}`);
      checks++;
    });
}

// ---------------------------------------------------------------- codec self-checks
{
  const f = encodeShortcuts(null, FACTORY_SHORTCUTS.map(([trigger, action]) => ({ trigger, action })));
  assert.equal(f[255], MAGIC); assert.equal(f[254], 0);
  assert.deepEqual(decodeShortcuts(f).map(e => [e.trigger, e.action]), FACTORY_SHORTCUTS);
  assert.equal(tableWriteBlocker(emptyTable()), null);
  assert.match(tableWriteBlocker(new Uint8Array(256)), /0x5A/);
  assert.match(tableWriteBlocker(new Uint8Array(10)), /256/);
  assert.throws(() => encodeShortcuts(null, Array(128).fill({ trigger: 1, action: 1 })));
  assert.throws(() => encodeBleButtons(null, Array(43).fill({ click: 0, dblClick: 0, idHex: "01020304" })));
  assert.throws(() => readBackup({ format: "x" }));
  checks += 8;
}

// Every edit path ran, and the vendor re-send path ran.
for (const op of OPS) assert.ok(seen["AB " + op] >= 50, `AB ${op} ran ${seen["AB " + op]} times`);
for (const op of BLE_OPS) assert.ok(seen["BA " + op] >= 50, `BA ${op} ran ${seen["BA " + op]} times`);
assert.ok(seen["vendor re-send"] >= 20, "vendor re-send path ran");
assert.ok(seen["press on a duplicate id"] >= 20, "press on a duplicate id ran");

console.log(`tables-vendor: ${checks} checks passed`);
console.log("coverage:", JSON.stringify(seen));
