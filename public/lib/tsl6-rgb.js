// TSL6 ambient light (RGB) codec, BLE command B9 (185).
// Layout from the vendor Mini App page "氛围灯设置" (ambient light settings).
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// Nothing in this file is tested on a car yet.

export const TYPE_RGB = 0xb9;

// Sub-commands. They are the first payload byte of a B9 frame that the app sends.
export const OP = { READ: 0, WRITE: 1, TRY: 2, CLEAR: 3 };

// The two tabs. The tab id is the second payload byte of every B9 frame that the app sends.
export const TAB = { ZONE: 0, CAR: 1 };
export const TABS = [
  { id: TAB.ZONE, label: "Zone link", zh: "分区联动", note: "Needs the ambient light module", noteZh: "此页面功能需安装氛围灯模块" },
  { id: TAB.CAR, label: "Whole-car effect", zh: "整车效果", note: "Needs factory ambient lights in the car", noteZh: "此页面需车辆有原厂氛围灯" },
];

// Rule table: 36 slots of 7 bytes, then 4 bytes that the app does not use.
export const TABLE_LEN = 256;
export const SLOT_LEN = 7;
export const SLOT_COUNT = 36;
export const TAIL_OFFSET = SLOT_COUNT * SLOT_LEN; // 252

// Slot layout (offsets in the slot):
//  0-1  little-endian word A: cmd bits 0-8, run bit 9, addr bits 10-15
//  2-4  colour R, G, B
//  5-6  little-endian word B: bright bits 0-4, breathe bits 5-9, blink bits 10-14, effect bit 15
// addr has two meanings. Tab 0: the lamp (LAMP). Tab 1: the whole-car effect (CAR_EFFECT).
// effect (bit 15) is the zone-link effect (ZONE_EFFECT). Tab 1 does not show it.
export const SLOT_FIELDS = {
  cmd: { word: 0, shift: 0, width: 9 },
  run: { word: 0, shift: 9, width: 1 },
  addr: { word: 0, shift: 10, width: 6 },
  bright: { word: 1, shift: 0, width: 5 },
  breathe: { word: 1, shift: 5, width: 5 },
  blink: { word: 1, shift: 10, width: 5 },
  effect: { word: 1, shift: 15, width: 1 },
};

// Rule 0 is fixed. The user cannot change its trigger or delete it.
export const RULE0_NAME = [
  { label: "Turn signal link", zh: "转向灯联动" },
  { label: "Default effect", zh: "默认效果" },
];
export const NO_TRIGGER = { label: "Select a trigger", zh: "请选择快捷指令" };

// ---------------------------------------------------------------- option lists (in the vendor package)
// Each entry: [raw value, English label, original Chinese label].

export const LAMP = [
  [1, "Left ambient light", "左氛围灯"],
  [2, "Right ambient light", "右氛围灯"],
  [3, "Left + right", "左 + 右"],
];

export const ZONE_EFFECT = [
  [0, "Default effect", "默认效果"],
  [1, "Custom", "自定义"],
];

// Whole-car effect. Rule 0 shows value 0 as "follow car"; other rules show "default effect".
export function carEffectOptions(index) {
  return [
    index > 0 ? [0, "Default effect", "默认效果"] : [0, "Follow car (default)", "跟随车机(默认)"],
    [1, "Custom", "自定义"],
    [2, "Whole-car gradient", "整车渐变"],
  ];
}

export function brightOptions(tab) {
  const list = [tab === TAB.CAR ? [0, "Follow car (default)", "跟随车机(默认)"] : [0, "0% (light off)", "亮度0%(关灯)"]];
  for (let n = 1; n <= 10; n++) list.push([n, `Car brightness +${n * 10}%`, `车机亮度+${n * 10}%`]);
  for (let n = 1; n <= 10; n++) list.push([10 + n, `Fixed ${n * 10}%`, `固定亮度 ${n * 10}%`]);
  return list;
}

export const BREATHE = [
  [0, "Off (default)", "关闭(默认)"],
  [1, "Fast", "快"],
  [2, "Medium", "中"],
  [3, "Slow", "慢"],
];

export const BLINK = [[0, "Off (default)", "关闭(默认)"]];
for (let n = 1; n <= 31; n++) {
  const mark = { 1: ["fast", "快"], 15: ["medium", "中"], 31: ["slow", "慢"] }[n];
  BLINK.push(mark ? [n, `${n} (${mark[0]})`, `>> ${mark[1]} <<`] : [n, String(n), String(n)]);
}

// Option list for a field of a rule. index = position of the rule in the tab (0 = fixed rule).
export function optionsFor(field, tab, index) {
  switch (field) {
    case "addr": return tab === TAB.ZONE ? LAMP : carEffectOptions(index);
    case "effect": return ZONE_EFFECT;
    case "bright": return brightOptions(tab);
    case "breathe": return BREATHE;
    case "blink": return BLINK;
    default: return null;
  }
}

// Label for a raw value. A value that no menu lists keeps its number.
export function optionLabel(list, val) {
  const o = list.find(e => e[0] === val);
  return o ? o[1] : `Unknown (${val})`;
}

// ---------------------------------------------------------------- server list (not in the package)
// The trigger names come from the vendor server (fun=funlist.js, key "btn"). Shape:
//   [{ name: "<group>", data: [{ val: <trigger id>, name: "<trigger>", title?: "...", attemp?: 1 }] }]
// This module does not hold any names. The caller passes the list.
// If two entries have the same id, the last one wins (as in the vendor page).
export function triggerName(tab, index, cmd, btnGroups) {
  if (index === 0) return RULE0_NAME[tab] ?? RULE0_NAME[0];
  let found = NO_TRIGGER;
  for (const g of btnGroups ?? []) for (const t of g.data ?? []) if (t.val == cmd) found = { label: t.name, zh: t.name };
  return found;
}

// ---------------------------------------------------------------- colour
const hex2 = n => n.toString(16).padStart(2, "0").toUpperCase();
export const rgbToHex = ([r, g, b]) => hex2(r) + hex2(g) + hex2(b);
export function hexToRgb(s) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (!m) throw new Error("colour must be RRGGBB");
  return [1, 2, 3].map(i => parseInt(m[i], 16));
}

// HSV to RGB with the same rounding as the vendor picker.
// h in degrees (0-360), s and v in 0-255. Each input is rounded to 2 decimals after scaling.
// Output channels use floor.
export function hsvToRgb(h, s, v) {
  const H = Number((h / 360).toFixed(2));
  const S = Number((s / 255).toFixed(2));
  const V = Number((v / 255).toFixed(2));
  const sector = Math.floor(6 * H);
  const f = 6 * H - sector;
  const p = V * (1 - S), q = V * (1 - f * S), t = V * (1 - (1 - f) * S);
  const rgb = [[V, t, p], [q, V, p], [p, V, t], [p, q, V], [t, p, V], [V, p, q]][((sector % 6) + 6) % 6];
  return rgb.map(c => Math.floor(255 * c));
}

// Colour for a tap on the colour wheel.
// dx, dy = tap position minus the top-left corner of the wheel, in px. size = wheel diameter in px.
// The wheel has hue 0 (red) at the top, hue grows clockwise, and saturation grows from the centre.
// The vendor uses brightness 255 always.
export function wheelColor(dx, dy, size, brightness = 255) {
  const x = Number((dx * (100 / size)).toFixed(0)) - 50;
  const y = -(Number((dy * (100 / size)).toFixed(0)) - 50);
  const h = Number(((((5 * Math.PI) / 2 - Math.atan2(y, x)) % (2 * Math.PI)) * 180 / Math.PI).toFixed(0));
  let s = Number((Math.sqrt(x * x + y * y) / 50 * 255).toFixed(0));
  if (s === 0) s = 1; else if (s > 255) s = 255;
  return { h, s, v: brightness, rgb: hsvToRgb(h, s, brightness) };
}

// ---------------------------------------------------------------- slots and table
function getField(words, f) { return (words[f.word] >>> f.shift) & ((1 << f.width) - 1); }

export function decodeSlot(table, i) {
  const o = i * SLOT_LEN;
  const words = [table[o] | (table[o + 1] << 8), table[o + 5] | (table[o + 6] << 8)];
  const r = {};
  for (const [k, f] of Object.entries(SLOT_FIELDS)) r[k] = getField(words, f);
  r.color = [table[o + 2], table[o + 3], table[o + 4]];
  return r;
}

// 7 bytes for one rule. Each field is masked to its width (the vendor does not mask).
export function encodeSlot(rule) {
  const words = [0, 0];
  for (const [k, f] of Object.entries(SLOT_FIELDS)) {
    const v = Number(rule[k] ?? 0) & ((1 << f.width) - 1);
    words[f.word] |= v << f.shift;
  }
  const c = typeof rule.color === "string" ? hexToRgb(rule.color) : (rule.color ?? [0, 0, 0]);
  return Uint8Array.of(words[0] & 255, words[0] >>> 8, c[0] & 255, c[1] & 255, c[2] & 255, words[1] & 255, words[1] >>> 8);
}

// All 36 slots, in slot order, plus the 4 tail bytes. A slot is "used" if it is slot 0 or its cmd is not 0.
export function decodeTable(table) {
  if (table.length !== TABLE_LEN) throw new Error(`B9 table must be ${TABLE_LEN} bytes, got ${table.length}`);
  const slots = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    const s = decodeSlot(table, i);
    s.slot = i;
    s.used = i === 0 || s.cmd !== 0;
    slots.push(s);
  }
  return { slots, tail: Uint8Array.from(table.subarray(TAIL_OFFSET)) };
}

// The rules that the vendor page shows: slot 0, then every slot with cmd != 0, in slot order.
// The position in this list is the rule index that the page shows and that TRY uses.
export function rulesFromTable(table) {
  return decodeTable(table).slots.filter(s => s.used);
}

// Build a 256-byte table from a rule list. Rules go into slots 0..n-1 in list order.
// Unused slots are 0. The 4 tail bytes come from `base` (the last table the module sent), or 0.
export function encodeTable(rules, base) {
  if (rules.length > SLOT_COUNT) throw new RangeError(`at most ${SLOT_COUNT} rules, got ${rules.length}`);
  const t = new Uint8Array(TABLE_LEN);
  rules.forEach((r, i) => t.set(encodeSlot(r), i * SLOT_LEN));
  if (base) t.set(base.subarray ? base.subarray(TAIL_OFFSET, TABLE_LEN) : base.slice(TAIL_OFFSET, TABLE_LEN), TAIL_OFFSET);
  return t;
}

// A new rule, as the vendor "+" button makes it. It is not sent until the user changes a field.
// cmd 1 is a placeholder trigger. The vendor saves it as is if the user changes another field first.
export function newRule(tab) {
  return { cmd: 1, run: 1, addr: tab === TAB.ZONE ? 3 : 1, color: [0xff, 0x00, 0xff], bright: 20, breathe: 0, blink: 0, effect: 1 };
}

// Move a rule (index >= 1). Rule 0 stays first.
export function moveRule(rules, from, to) {
  if (from < 1 || to < 1 || from >= rules.length || to >= rules.length) throw new RangeError("rule 0 cannot move");
  const out = rules.slice();
  const [r] = out.splice(from, 1);
  out.splice(to, 0, r);
  return out;
}

// Remove a rule (index >= 1).
export function removeRule(rules, index) {
  if (index < 1 || index >= rules.length) throw new RangeError("rule 0 cannot be removed");
  return rules.filter((_, i) => i !== index);
}

// ---------------------------------------------------------------- frames (payloads of a B9 frame)
export const buildRead = tab => Uint8Array.of(OP.READ, tab);
export const buildTry = (tab, index) => Uint8Array.of(OP.TRY, tab, index);
export const buildClear = tab => Uint8Array.of(OP.CLEAR, tab); // deletes every rule of the tab (vendor: "delete all")
export function buildWrite(tab, table) {
  if (table.length !== TABLE_LEN) throw new Error(`B9 table must be ${TABLE_LEN} bytes`);
  const p = new Uint8Array(2 + TABLE_LEN);
  p[0] = OP.WRITE; p[1] = tab; p.set(table, 2);
  return p;
}

// Module reply to B9. The reply does not name the tab; it is for the last tab that the app asked for.
export function parseReply(p) {
  if (p.length === 1 && p[0] === 0xff) return { kind: "noModule" }; // vendor: "请先安装 氛围灯模块"
  if (p.length === TABLE_LEN) return { kind: "table", table: Uint8Array.from(p) };
  return { kind: "unknown", length: p.length };
}

// True if the reply holds the table that a write sent (the vendor compares all 256 bytes).
export function echoMatches(sentTable, reply) {
  if (reply.length !== sentTable.length) return false;
  for (let i = 0; i < reply.length; i++) if (reply[i] !== sentTable[i]) return false;
  return true;
}

// ---------------------------------------------------------------- page rows (vendor template conditions)
// Rows that the vendor page shows for a rule, in screen order.
export function rowsFor(tab, index, rule) {
  const rows = ["header"];
  if (tab === TAB.ZONE) {
    if (index >= 1) rows.push("addr", "effect");
    if (rule.effect) {
      if (rule.bright > 0) rows.push("color");
      rows.push("bright");
      if (rule.bright > 0) rows.push("breathe");
      if (index >= 1 && rule.bright > 0) rows.push("blink");
    }
  } else {
    rows.push("addr"); // whole-car effect picker
    if (rule.addr === 1) rows.push("color");
    if (index === 0 || rule.addr > 0) rows.push("bright");
    if (rule.addr > 0) rows.push("breathe", "blink");
  }
  return rows;
}

// The vendor shows the TRY button in the effect row. Tab 0 has no effect row for rule 0.
export const canTry = (tab, index) => tab === TAB.CAR || index >= 1;
