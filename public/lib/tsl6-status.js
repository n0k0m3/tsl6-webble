// TSL6 status page codec: live state, Status tab controls, Me tab data, Settings action buttons.
// Source: static analysis of the vendor Mini App (see docs/miniapp-protocol.md).
// Pure functions: no BLE, no DOM. Works in the browser and in Node.
// Device types 6 and 8 (TSL6) share every rule in this file. Other types are listed only where the vendor gates differ.

export const CMD = { A0: 0xa0, A1: 0xa1, A2: 0xa2, A4: 0xa4, A5: 0xa5, A6: 0xa6, A7: 0xa7, A8: 0xa8, A9: 0xa9, C1: 0xc1 };

// Payload offsets of the live-state bytes. The vendor names are kept.
export const OFF = { esp: 3, fxp: 18, on: 19, timer: 20, dat0: 22, dat1: 23 };
export const LIVE_LEN = 24;
export const UID_FROM = 4;
export const UID_TO = 18; // exclusive: UID14 = bytes 4..17

export const A2_RELEASE = 6;      // wheel button released
export const A7_RELEASE = 16;     // seat move button released
export const A7_POWER_OFF = 17;   // vendor shows it only in factory mode 2
export const A7_SERVICE_MODE = 255;
// A7 values that need an explicit override: power off, motors off, ESP off, Tesla service mode.
export const A7_HARD_GATED = Object.freeze([17, 47, 49, 51, 255]);

const PRESS = ["touchstart"];

// ------------------------------------------------------------------ Status tab rows (screen order, hw_ver 6/8)
// state: [byte name, bit]. The switch shows bit = 1 as "on".
// types: the vendor template shows the row for these hw_ver values.
// danger: none | module | car | drive | service. "drive" and "service" touch driving systems.
// vendorConfirm: the dialog that the vendor shows before it sends. null = the vendor sends at once.
const ALL = [3, 5, 6, 7, 8, 19];
const NEW4 = [6, 7, 8, 19];
const NEW3 = [6, 8, 19];

const sw = (id, zh, en, help, handler, state, extra = {}) =>
  ({ id, kind: "switch", zh, en, help, handler, state, ...extra });

export const STATUS_ROWS = [
  { id: "vehicleType", kind: "vehicleType", zh: "车辆类型", en: "Vehicle type", help: "help_vehicleType", types: [3, 5, 6, 8, 19],
    longpress: "displayVehicleType", note: "Long-press the label: send A0, then show the CAN1-3 state from the next status (types 6, 7, 8, 19)." },
  { id: "autoGauge", kind: "local", zh: "自动进入仪表", en: "Open gauges on connect", help: "help_autoGauge", types: NEW3,
    storageKey: "isAutoGauge", note: "Local switch. A button '仪表盘' (Gauges) opens the gauge page. No BLE." },
  sw("vehicleAPState", "车辆AP状态", "Car AP state", "help_vehicleAPState", "switchControl", ["on", 5], { btn: 42, types: NEW4, danger: "drive" }),
  sw("apAssist", "AP辅助状态", "AP assist (no-nag) active", "help_state", "enter", ["on", 0], { types: ALL, danger: "module" }),
  sw("apAutoState", "AP恢复状态", "AP resume active", "help_apAutoState", "setApAutoState", ["fxp", 0], { types: NEW4, danger: "module" }),
  sw("batteryHeat", "电池预热", "Battery preheat", "help_BatteryHeat", "switchControl", ["fxp", 1], { btn: 4, types: NEW4, danger: "car" }),
  sw("chargeDoor", "充电盖板", "Charge port door", "help_ChargeDoor", "switchControl", ["fxp", 2], { btn: 6, types: NEW3, danger: "car" }),
  sw("pulseHorn", "脉冲喇叭", "Pulse horn", "help_pluseHornSwitch", "switchControl", ["fxp", 6], { btn: 40, types: NEW3, danger: "car" }),
  sw("pulseHighBeam", "远光爆闪", "High-beam strobe", "help_pluseHighBeamSwitch", "switchControl", ["fxp", 7], { btn: 38, types: NEW4, danger: "car" }),
  sw("pulseFrontFog", "前雾灯爆闪", "Front fog strobe", "help_pluseFrontFogSwitch", "switchControl", ["on", 1], { btn: 30, types: NEW4, danger: "car" }),
  sw("pilotFrontFog", "前雾灯领航", "Front fog guide light", "help_pilotFrontFogSwitch", "switchControl", ["on", 2], { btn: 32, types: NEW4, danger: "car" }),
  sw("pulseRearFog", "后雾灯爆闪", "Rear fog strobe", "help_pluseRearFogSwitch", "switchControl", ["on", 3], { btn: 34, types: NEW4, danger: "car" }),
  sw("pilotRearFog", "后雾灯领航", "Rear fog guide light", "help_pilotRearFogSwitch", "switchControl", ["on", 4], { btn: 36, types: NEW4, danger: "car" }),
  sw("sportMode", "运动模式", "Sport mode", "help_sportMode", "switchControl", ["on", 6], { btn: 44, types: NEW3, danger: "drive" }),
  sw("offRearMotor", "关闭后电机", "Rear motor off", "help_offRearMotor", "switchControl", ["esp", 3], { btn: 50, types: NEW3, danger: "drive",
    helpOnEnable: { id: "help_offRearMotor", name: "关闭后电机" } }),
  sw("offFrontMotor", "关闭前电机", "Front motor off", "help_offFrunkMotor", "switchControl", ["esp", 1], { btn: 46, types: NEW4, danger: "drive",
    helpOnEnable: { id: "help_offFrunkMotor", name: "关闭前电机" } }),
  sw("offESP", "关闭ESP(漂移)", "ESP off (drift)", "help_offESP", "switchControl", ["esp", 2], { btn: 48, types: NEW4, danger: "drive",
    helpOnEnable: { id: "help_offESP", name: "关闭ESP" } }),
  sw("driverMassage", "主驾座椅按摩", "Driver seat massage", "help_MainMassage", "switchControl", ["fxp", 3], { btn: 18, types: NEW4, danger: "car" }),
  sw("passengerMassage", "副驾座椅按摩", "Passenger seat massage", "help_SlaveMassage", "switchControl", ["fxp", 4], { btn: 20, types: NEW3, danger: "car" }),
  { id: "driverSeat", kind: "seat", zh: "主驾座椅", en: "Driver seat", help: "help_MainSideControl", types: NEW3, danger: "car", buttons: [
    { btn: 26, icon: "shangxiazuoyou-3", glyph: "<", en: "Left" }, { btn: 27, icon: "shangxiazuoyou-", glyph: ">", en: "Right" },
    { btn: 28, icon: "shangxiazuoyou-2", glyph: "^", en: "Up" }, { btn: 29, icon: "shangxiazuoyou-1", glyph: "v", en: "Down" }] },
  { id: "driverMemory", kind: "memory", zh: "主驾记忆", en: "Driver seat memory", help: "help_sideMemory", types: NEW3, danger: "car", buttons: [
    { btn: 60, icon: "louying", en: "Camp mode" }, { btn: 58, icon: "lingzhongli", en: "Queen mode" },
    { btn: 52, text: "1", en: "Memory 1" }, { btn: 54, text: "2", en: "Memory 2" }, { btn: 56, text: "3", en: "Memory 3" }] },
  { id: "passengerSeat", kind: "seat", zh: "副驾座椅", en: "Passenger seat", help: "help_SlaveSideControl", types: NEW4, danger: "car", buttons: [
    { btn: 12, icon: "shangxiazuoyou-3", glyph: "<", en: "Left" }, { btn: 13, icon: "shangxiazuoyou-", glyph: ">", en: "Right" },
    { btn: 14, icon: "shangxiazuoyou-2", glyph: "^", en: "Up" }, { btn: 15, icon: "shangxiazuoyou-1", glyph: "v", en: "Down" }] },
  { id: "passengerMemory", kind: "memory", zh: "副驾记忆", en: "Passenger seat memory", help: "help_sideMemory", types: NEW3, danger: "car", buttons: [
    { btn: 70, icon: "louying", en: "Camp mode" }, { btn: 68, icon: "lingzhongli", en: "Queen mode" },
    { btn: 62, text: "1", en: "Memory 1" }, { btn: 64, text: "2", en: "Memory 2" }, { btn: 66, text: "3", en: "Memory 3" }] },
  { id: "openDoor", kind: "tap", zh: "开车门", en: "Open door", help: "help_openTheDoor", types: NEW4, danger: "car", buttons: [
    { btn: 0, icon: "zhujiashichemen", info: "左前门", en: "Front left door" },
    { btn: 1, icon: "fujiashichemen", info: "右前门", en: "Front right door" },
    { btn: 2, icon: "zuocehoupaichemen", info: "左后门", en: "Rear left door" },
    { btn: 3, icon: "youcehoupaichemen", info: "右后门", en: "Rear right door" }] },
  { id: "control", kind: "tap", zh: "控制", en: "Controls", help: "help_controlOther", types: NEW4, danger: "car", buttons: [
    { btn: 8, icon: "yinqinggai", info: "前备箱", en: "Frunk" },
    { btn: 9, icon: "houbeixiang", info: "后备箱", en: "Trunk" },
    { btn: 10, icon: "jichuxinxi", info: null, en: "Glovebox (not checked)" },
    { btn: 11, icon: "diandongzhediehoushijing", info: null, en: "Fold mirrors" },
    // Second line of the same row (types 6, 8, 19 only).
    { btn: 17, icon: "guanbi2", info: "下电", en: "Power off car", types: NEW3, vendorGate: "isAdmin == 2", danger: "drive" },
    { btn: 23, icon: "jiesuo", info: "解锁车辆", en: "Unlock car", types: NEW3 },
    { btn: 22, icon: "suoding", info: "锁定车辆", en: "Lock car", types: NEW3 }] },
  { id: "wheel", kind: "wheel", zh: "模拟滚轮", en: "Simulated scroll wheel", help: "help_simulate", types: ALL, danger: "car",
    longpress: "getVehicleType", note: "Long-press the label: send C1 (no payload). The reply shows a 32-bit value.", buttons: [
    { btn: 4, icon: "shangxiazuoyou-3", glyph: "<", en: "Left" }, { btn: 2, icon: "shangxiazuoyou-", glyph: ">", en: "Right" },
    { btn: 1, icon: "shangxiazuoyou-2", glyph: "^", en: "Up" }, { btn: 5, icon: "ok", glyph: "OK", en: "Press" },
    { btn: 3, icon: "shangxiazuoyou-1", glyph: "v", en: "Down" }] },
  { id: "countdown", kind: "countdown", zh: "操作倒计时", en: "Next action in", help: "help_countdown", types: ALL,
    shownWhen: "on bit 0", note: "Shows the timer (bytes 20-21, ms) and counts it down by 0.1 s every 100 ms." },
];

export const ROW_BY_ID = Object.fromEntries(STATUS_ROWS.map(r => [r.id, r]));
export const SWITCHES = STATUS_ROWS.filter(r => r.kind === "switch");

// Seat memory: tap = recall (value = btn), long-press = save (value = btn + 1).
const MEMORY_TEXT = [
  ["恢复记忆 1 主驾座椅到?", "Move the driver seat to memory 1?"],
  ["确定要将当前主驾座椅位置保存到记忆 1 ?", "Save the driver seat position to memory 1?"],
  ["恢复记忆 2 主驾座椅到?", "Move the driver seat to memory 2?"],
  ["确定要将当前主驾座椅位置保存到记忆 2 ?", "Save the driver seat position to memory 2?"],
  ["恢复记忆 3 主驾座椅到?", "Move the driver seat to memory 3?"],
  ["确定要将当前主驾座椅位置保存到记忆 3 ?", "Save the driver seat position to memory 3?"],
  ["执行主驾女王模式?", "Run driver queen mode?"],
  ["确定要将当前主驾座椅位置保存到女王模式", "Save the driver seat position to queen mode"],
  ["执行主驾露营模式?", "Run driver camp mode?"],
  ["确定要将当前主驾座椅位置保存到露营模式", "Save the driver seat position to camp mode"],
  ["恢复记忆 1 副驾座椅到?", "Move the passenger seat to memory 1?"],
  ["确定要将当前副驾座椅位置保存到记忆 1 ?", "Save the passenger seat position to memory 1?"],
  ["恢复记忆 2 副驾座椅到?", "Move the passenger seat to memory 2?"],
  ["确定要将当前副驾座椅位置保存到记忆 2 ?", "Save the passenger seat position to memory 2?"],
  ["恢复记忆 3 副驾座椅到?", "Move the passenger seat to memory 3?"],
  ["确定要将当前副驾座椅位置保存到记忆 3 ?", "Save the passenger seat position to memory 3?"],
  ["执行副驾女王模式?", "Run passenger queen mode?"],
  ["确定要将当前副驾座椅位置保存到女王模式", "Save the passenger seat position to queen mode"],
  ["执行副驾露营模式?", "Run passenger camp mode?"],
  ["确定要将当前副驾座椅位置保存到露营模式", "Save the passenger seat position to camp mode"],
];

// ------------------------------------------------------------------ A7 value table
// value -> { en, zh, danger, gate }. Built from the rows above.
export const A7_VALUES = (() => {
  const t = {};
  const put = (v, en, zh, danger) => { t[v] = { value: v, en, zh, danger, hardGate: A7_HARD_GATED.includes(v) }; };
  for (const r of SWITCHES) if (r.handler === "switchControl") {
    put(r.btn, `${r.en}: off`, `${r.zh} 关`, r.danger === "drive" ? "car" : r.danger);
    put(r.btn + 1, `${r.en}: on`, `${r.zh} 开`, r.danger);
  }
  for (const r of STATUS_ROWS) {
    if (r.kind === "seat") for (const b of r.buttons) put(b.btn, `${r.en}: ${b.en} (hold)`, r.zh, "car");
    if (r.kind === "memory") for (const b of r.buttons) {
      put(b.btn, `${r.en}: recall ${b.en}`, MEMORY_TEXT[b.btn - 52][0], "car");
      put(b.btn + 1, `${r.en}: save ${b.en}`, MEMORY_TEXT[b.btn + 1 - 52][0], "car");
    }
    if (r.kind === "tap") for (const b of r.buttons) put(b.btn, b.en, b.info || r.zh, b.danger || "car");
  }
  put(A7_RELEASE, "Seat move: release", "松开", "car");
  put(A7_SERVICE_MODE, "Tesla service mode", "特斯拉维护模式", "service");
  // The "off" value of a drive switch restores the car. Keep the "on" value as drive.
  for (const v of [46, 48, 50]) t[v].danger = "car";
  return Object.freeze(t);
})();

// ------------------------------------------------------------------ builders
const u8 = a => Uint8Array.from(a);

function uid14(status) {
  if (!status || status.length < UID_TO) {
    // The vendor sends 14 zero bytes here. We refuse instead.
    throw new Error(`status payload too short for UID14 (${status ? status.length : 0} < ${UID_TO})`);
  }
  return u8(Array.from(status).slice(UID_FROM, UID_TO));
}

export const buildA0 = () => ({ type: CMD.A0, payload: new Uint8Array(0) });
export const buildC1 = () => ({ type: CMD.C1, payload: new Uint8Array(0) });
export const buildA1 = on => ({ type: CMD.A1, payload: u8([on ? 1 : 0]) });
export const buildA6 = on => ({ type: CMD.A6, payload: u8([on ? 1 : 0]) });
export const buildA4 = status => ({ type: CMD.A4, payload: uid14(status) });
export const buildA5 = status => ({ type: CMD.A5, payload: uid14(status) });

export function buildA2(id) {
  if (![1, 2, 3, 4, 5, A2_RELEASE].includes(id)) throw new Error(`A2: unknown wheel button ${id}`);
  return { type: CMD.A2, payload: u8([id]) };
}

// A7 car control. Hard-gated values need { allowDangerous: true }. Unknown values need { allowUnknown: true }.
export function buildA7(value, opts = {}) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`A7: bad value ${value}`);
  if (A7_HARD_GATED.includes(value) && !opts.allowDangerous) {
    throw new Error(`A7 ${value} (${A7_VALUES[value].en}) is hard-gated: pass { allowDangerous: true }`);
  }
  if (!A7_VALUES[value] && !opts.allowUnknown) throw new Error(`A7: value ${value} is not used by the vendor app`);
  return { type: CMD.A7, payload: u8([value]) };
}

// A9 change BLE password: status bytes 0..17 + old key (4 ASCII) + new key (4 ASCII) = 26 bytes.
// We accept only printable ASCII (0x20..0x7E). Runtime V1.0.00 rejects an A3 write when bytes 36..39
// (the stored password) are not printable, so a bad password could block later settings writes.
export function buildA9(status, oldKey, newKey) {
  if (!status || status.length < 18) throw new Error("A9: status payload too short (< 18)");
  for (const [name, k] of [["old", oldKey], ["new", newKey]]) {
    if (typeof k !== "string" || k.length !== 4) throw new Error(`A9: ${name} key must have 4 characters`);
    for (const ch of k) { const c = ch.charCodeAt(0); if (c < 0x20 || c > 0x7e) throw new Error(`A9: ${name} key must be printable ASCII`); }
  }
  const p = new Uint8Array(26);
  for (let i = 0; i < 18; i++) p[i] = status[i];
  const s = oldKey + newKey;
  for (let i = 0; i < 8; i++) p[18 + i] = s.charCodeAt(i);
  return { type: CMD.A9, payload: p };
}

// Vendor input checks for the password form, in vendor order. Returns null or { zh, en }.
export function validatePasswordChange(oldKey, newKey, confirmKey) {
  if (oldKey.length !== 4) return { zh: "原密码必须为4位", en: "The old password must have 4 characters" };
  if (newKey.length !== 4) return { zh: "新密码必须为4位", en: "The new password must have 4 characters" };
  if (oldKey === newKey) return { zh: "原密码不能和新密码相同", en: "The new password must differ from the old password" };
  if (newKey !== confirmKey) return { zh: "新密码必须和确认新密码相同", en: "The two new passwords do not match" };
  // Our extra check (the vendor has none). buildA9 needs printable ASCII in both keys.
  for (const ch of oldKey + newKey) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e) return { zh: null, en: "Use letters, digits or ASCII symbols only" };
  }
  return null;
}

// ------------------------------------------------------------------ control commands
// Switch row -> command. on = the new switch position.
export function switchCommand(id, on, opts = {}) {
  const r = ROW_BY_ID[id];
  if (!r || r.kind !== "switch") throw new Error(`no switch ${id}`);
  if (r.handler === "enter") return { ...buildA1(on), help: null };
  if (r.handler === "setApAutoState") return { ...buildA6(on), help: null };
  const v = r.btn + (on ? 1 : 0);
  // The vendor shows the help text when one of these turns on. It does not wait for a confirm.
  const help = on && r.helpOnEnable ? r.helpOnEnable : null;
  return { ...buildA7(v, opts), help };
}

// Seat move (A7) and wheel (A2) buttons: one frame on press, one on release.
export function holdCommand(rowId, btn, phase) {
  const r = ROW_BY_ID[rowId];
  if (!r || !r.buttons.some(b => b.btn === btn)) throw new Error(`no button ${btn} in ${rowId}`);
  const pressed = PRESS.includes(phase) || phase === "press";
  if (r.kind === "seat") return buildA7(pressed ? btn : A7_RELEASE);
  if (r.kind === "wheel") return buildA2(pressed ? btn : A2_RELEASE);
  throw new Error(`${rowId} is not a hold row`);
}

// Seat memory: tap = recall, long-press = save. Both ask first.
export function memoryCommand(rowId, btn, longpress) {
  const r = ROW_BY_ID[rowId];
  if (!r || r.kind !== "memory" || !r.buttons.some(b => b.btn === btn)) throw new Error(`no memory button ${btn} in ${rowId}`);
  const v = btn + (longpress ? 1 : 0);
  const [zh, en] = MEMORY_TEXT[v - 52];
  return { ...buildA7(v), confirm: { zh, en } };
}

// Door and control buttons. A button with "info" asks "确定打开<info>?" first.
export function tapCommand(rowId, btn, opts = {}) {
  const r = ROW_BY_ID[rowId];
  const b = r && r.kind === "tap" && r.buttons.find(x => x.btn === btn);
  if (!b) throw new Error(`no button ${btn} in ${rowId}`);
  const confirm = b.info ? { zh: `确定打开${b.info}?`, en: `Open: ${b.en}?` } : null;
  return { ...buildA7(btn, opts), confirm };
}

// ------------------------------------------------------------------ live state
const bit = (v, n) => ((v >> n) & 1) === 1;

// Decode the live part of a status payload (A0, A1 or A3 reply).
// The vendor clears on/fxp/dat0/dat1 when byte 3 bit 0 is 0 (boot mode) or the payload is shorter than 18.
// We also clear esp in that case (the vendor keeps the previous esp value).
// live = false when the payload is shorter than 24 bytes: then the timer is 0 and missing bytes read as 0.
export function decodeLiveState(p, hwType = 6) {
  const u = p instanceof Uint8Array ? p : Uint8Array.from(p);
  const runtimeOk = u.length >= 18 && (u[3] & 1) === 1;
  const live = runtimeOk && u.length >= LIVE_LEN;
  // A byte that the payload does not cover reads as 0 (the vendor reads undefined, which the template shows as 0).
  const at = i => (runtimeOk && i < u.length ? u[i] : 0);
  const raw = { esp: at(OFF.esp), fxp: at(OFF.fxp), on: at(OFF.on), dat0: at(OFF.dat0), dat1: at(OFF.dat1) };
  const timerMs = live ? u[20] | (u[21] << 8) : 0;
  // A status read before the BLE password has bytes 18..39 set to 0 (runtime V1.0.00).
  let blank = false;
  if (u.length >= 40) { blank = true; for (let i = 18; i < 40; i++) if (u[i] !== 0) { blank = false; break; } }
  const toggles = {};
  for (const r of SWITCHES) toggles[r.id] = bit(raw[r.state[0]], r.state[1]);
  return {
    length: u.length,
    runtimeOk,
    live,
    blank,
    raw,
    timerMs,
    timerText: (timerMs / 1000).toFixed(1), // the vendor shows this + " 秒后"
    assistActive: bit(raw.on, 0),             // shows the countdown block
    harnessUnplugged: bit(raw.on, 7),         // "线束未插好"
    can: [bit(raw.dat1, 0), bit(raw.dat1, 1), bit(raw.dat1, 2)],
    vehicle: vehicleTypeFromStatus(raw, hwType),
    toggles,
  };
}

// Text of the vendor CAN dialog (long-press on "车辆类型"). Only types 6, 7, 8, 19.
export function canStateText(dat1) {
  const s = ["未连接", "已连接"];
  return {
    zh: `CAN1: ${s[(dat1 >> 0) & 1]}\r\nCAN2: ${s[(dat1 >> 1) & 1]}\r\nCAN3: ${s[(dat1 >> 2) & 1]} `,
    en: [0, 1, 2].map(i => `CAN${i + 1}: ${(dat1 >> i) & 1 ? "connected" : "not connected"}`).join("\n"),
  };
}

// C1 reply: 4 bytes, shown as a 32-bit little-endian value.
export function formatC1Reply(b) {
  const h = x => (x & 0xff).toString(16).padStart(2, "0").toUpperCase();
  return { zh: `返回值：0x${h(b[3])}${h(b[2])}${h(b[1])}${h(b[0])}`, value: ((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0 };
}

// ------------------------------------------------------------------ vehicle type
// Vendor WXS m.getVehicleType(hw_ver, dat0 & 31, (esp >> 4) & 15, (dat0 >> 7) & 1).
const MAKES_HW5 = [
  ["未识别", "Not detected"], ["特斯拉普通3Y", "Tesla Model 3/Y"], ["特斯拉焕新3Y", "Tesla Model 3/Y (refresh)"],
  ["特斯拉老SX", "Tesla Model S/X (old)"], ["特斯拉新SX", "Tesla Model S/X (new)"], ["小鹏P7", "XPeng P7"], ["小鹏", "XPeng"],
  ["理想", "Li Auto"], ["阿维塔", "Avatr"], ["奔驰", "Mercedes-Benz"], ["小米SU7", "Xiaomi SU7"], ["小米YU7", "Xiaomi YU7"],
  ["智界R7/S7", "Luxeed R7/S7"], ["小鹏M03老款", "XPeng MONA M03 (old)"], ["岚图-梦想家", "Voyah Dreamer"],
  ["岚图-知音/FREE", "Voyah Zhiyin/FREE"], ["其它", "Other"],
];
const MAKES = [
  ["未识别", "Not detected"], ["特斯拉", "Tesla"], ["问界M5新款", "AITO M5 (new)"], ["问界M7老款", "AITO M7 (old)"],
  ["问界M7新款", "AITO M7 (new)"], ["问界/享界/尊界/尚界", "AITO / Stelato / Maextro / Shangjie"],
  ["问界M5-ADS4.0+", "AITO M5 ADS 4.0+"], ["其它", "Other"],
];
const TESLA_MODELS = [
  ["未识别", "not detected"], ["老款3", "Model 3 (old)"], ["老款Y", "Model Y (old)"], ["普通3", "Model 3"], ["普通Y", "Model Y"],
  ["焕新3", "Model 3 Highland"], ["焕新Y", "Model Y Juniper"], ["新S", "Model S (new)"], ["新X", "Model X (new)"],
  ["焕新YL", "Model Y L"], ["新款焕新3", "Model 3 Highland (new)"], ["其它", "other"],
];

export const VEHICLE_TABLES = Object.freeze({ MAKES_HW5, MAKES, TESLA_MODELS });

// Returns { make, model, performance, zh, en, known }.
// zh equals the vendor text for every known input. For a raw value outside the vendor lists,
// known = false and the text names the raw value (the vendor shows "undefined" or nothing).
export function vehicleTypeText(hwType, make, model, performance) {
  const makes = hwType === 5 ? MAKES_HW5 : MAKES;
  const m = makes[make];
  let known = !!m;
  let zh = m ? m[0] : `未知(${make})`;
  let en = m ? m[1] : `Unknown vehicle (${make})`;
  if ((hwType === 6 || hwType === 8 || hwType === 19) && make === 1) {
    const t = TESLA_MODELS[model];
    if (t) { zh += t[0]; en += ` ${t[1]}`; } else { known = false; zh += `未知(${model})`; en += ` unknown model (${model})`; }
    if (performance) { zh += "P"; en += " Performance"; }
  }
  return { make, model, performance: !!performance, zh, en, known };
}

// Vehicle type from the live bytes: make = dat0 bits 0-4, Tesla model = esp (byte 3) bits 4-7, P = dat0 bit 7.
// detected = make != 0 (the vendor shows the text in green, else orange).
export function vehicleTypeFromStatus(raw, hwType) {
  const make = raw.dat0 & 31, model = (raw.esp >> 4) & 15, perf = (raw.dat0 >> 7) & 1;
  return { ...vehicleTypeText(hwType, make, model, perf), detected: make !== 0 };
}

// ------------------------------------------------------------------ replies
export function decodeA7Reply(p) {
  // Only "A7 01 xx" has a meaning in the vendor app: result of a seat memory save.
  if (p[0] === 1 && (p[1] === 0 || p[1] === 1)) {
    return p[1] ? { ok: true, zh: "保存成功", en: "Saved" } : { ok: false, zh: "保存失败,请重调座椅", en: "Save failed. Adjust the seat again" };
  }
  return null;
}

export function decodeA9Reply(p) {
  return [
    { ok: false, zh: "原密码错误", en: "Wrong old password" },
    { ok: true, zh: "密码修改成功", en: "Password changed" },
    { ok: false, zh: "密码位数不对", en: "Wrong password length" },
  ][p[0]] || { ok: false, zh: null, en: `Unknown A9 reply ${p[0]}` };
}

export const REPLY_TEXT = Object.freeze({
  [CMD.A4]: { zh: "恢复默认设置成功", en: "Defaults restored" },
  [CMD.A5]: { zh: "重启模块成功", en: "Module restarted" },
  0xbb: { zh: "指令已发送", en: "Command sent" },
  0xbc: { zh: "操作成功", en: "Done" },
});

// ------------------------------------------------------------------ Me tab
// Vendor version text: 16-bit value -> "V" + hex digit + "." + hex digit + "." + 2 hex digits. 0x4100 -> "V4.1.00".
export function formatVersion(v) {
  const h = (((v >>> 8) & 0xff) << 8 | (v & 0xff)).toString(16).padStart(4, "0").toUpperCase();
  return `V${h[0]}.${h[1]}.${h.slice(-2)}`;
}

const hexs = (a, sep = "") => Array.from(a, b => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);

// Module data that the Me tab shows from the status payload (no server).
export function meInfo(p) {
  const u = p instanceof Uint8Array ? p : Uint8Array.from(p);
  if (u.length < 18) return null;
  let vin = "";
  if (u.length === 178) vin = u[46] !== 0xff ? String.fromCharCode(...u.slice(46, 63)) : "";
  else if (u.length >= 58 && u[40] === 1) vin = String.fromCharCode(...u.slice(41, 58));
  return {
    moduleId: hexs(u.slice(4, 16)),
    mac: hexs(Array.from(u.slice(12, 18)).reverse(), ":"),
    bootVersion: formatVersion(u[1] << 8),
    runVersion: formatVersion(u[2] << 8),
    vin,
  };
}

// Storage keys that the vendor "清除缓存" (clear cache) removes. Kept: bleKeyErr, isAdmin, showDebug, showTest, moveid.
export const CLEAR_CACHE_KEYS = Object.freeze(["deviceId", "ble_key", "hw_id", "deviceinfo", "msgId", "url", "FunListJs",
  "set", "btn", "isAutoGauge", "TSLServiceMode", "pagelen"]);

export const ME_ROWS = [
  { id: "name", zh: "设备名称", en: "Device name", source: "server (getinfo.name)" },
  { id: "moduleId", zh: "设备ID", en: "Device ID", source: "status bytes 4-15" },
  { id: "mac", zh: "设备MAC", en: "Device MAC", source: "status bytes 12-17, reversed" },
  { id: "vin", zh: "车辆VIN", en: "Vehicle VIN", source: "status VIN block", shownWhen: "VIN present" },
  { id: "authTime", zh: "激活时间", en: "Activation time", source: "server (getinfo.auth_time)", shownWhen: "auth_time set and not 0000-00-00 00:00:00" },
  { id: "bootVersion", zh: "BOOT版本", en: "Bootloader version", source: "status byte 1, server may override", shownWhen: "factory mode or newer bootloader on server" },
  { id: "runVersion", zh: "固件版本", en: "Firmware version", source: "status byte 2, server may override" },
  { id: "appDate", zh: "小程序更新日期", en: "App build date", source: "fixed text" },
  { id: "reboot", zh: "重启模块", en: "Restart module", cmd: CMD.A5, confirm: { zh: "确定要重启模块吗?", en: "Restart the module?" } },
  { id: "clear", zh: "清除缓存", en: "Clear cache", cmd: null, confirm: { zh: "确定清除小程序的缓存吗?", en: "Clear the app cache?" } },
];

// The vendor asks to turn off AP assist (A1 00) before a bootloader OTA when on bit 0 is set (types 3/5/6/7/8/19).
export const OTA_PRECHECK = Object.freeze({ zh: "升级前必须先关闭免打扰\r\n\r\n确定现在关闭吗?", en: "Turn off AP assist before the update. Turn it off now?" });

// ------------------------------------------------------------------ Settings tab action buttons (hw_ver 6/8)
// gate: extra template condition. All buttons hide while the password form is open.
const SERVICE_TEXT = '(模块需升级到V4.0.45或以上)\r\n车辆必须在P档\r\n\r\n免责声明：\r\n使用此功能进入特斯拉维护模式造成的一切后果由使用者承担。\r\n\r\n点击"确定"即表示接受此声明。';

export const SET_ACTIONS = [
  { id: "reset", zh: "恢复默认", en: "Restore defaults", cmd: CMD.A4, danger: "module",
    confirm: { zh: "确定要将所有参数恢复默认设置吗？", en: "Restore all settings to defaults?" } },
  { id: "backup", zh: "备份恢复", en: "Backup and restore", nav: "pages/backup/backup", gate: "mianSwitch == 0" },
  { id: "xgblePass", zh: "修改密码", en: "Change password", form: "password", cmd: CMD.A9, danger: "module",
    confirm: { zh: "确定要修改密码吗？", en: "Change the password?" } },
  { id: "btn", zh: "快捷指令", en: "Shortcuts", nav: "pages/btn/btn", gate: "mianSwitch == 0",
    longpress: "toggle showBate (内测功能开启 / 内测功能关闭)" },
  { id: "battery", zh: "电池信息", en: "Battery info", nav: "pages/batteryInfo/batteryInfo", gate: "mianSwitch == 0" },
  { id: "blebtn", zh: "蓝牙按钮", en: "BLE buttons", nav: "pages/blebtn/blebtn", gate: "mianSwitch == 0" },
  { id: "service", zh: "特斯拉维护模式", en: "Tesla service mode", cmd: CMD.A7, value: A7_SERVICE_MODE, danger: "service", gate: "mianSwitch == 0",
    confirm: { zh: SERVICE_TEXT, en: "Needs module V4.0.45 or later. The car must be in P. Disclaimer: you accept all results of entering Tesla service mode. Tap OK to accept." },
    vendorGate: "factory mode or hw_ver 19; else a server beta code" },
  { id: "rgb", zh: "原厂氛围灯设置", en: "Factory ambient light", nav: "pages/rgb/rgb", gate: "mianSwitch == 0" },
];

export function serviceModeCommand(opts = {}) {
  return { ...buildA7(A7_SERVICE_MODE, opts), confirm: SET_ACTIONS.find(a => a.id === "service").confirm };
}
