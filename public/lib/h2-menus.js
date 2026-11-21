// Menus of the H2 board (M5Stack NanoH2 + Unit Mini CAN) in terms of the TSL6 settings fields.
// Pure data: no BLE, no DOM, no imports. lib/tsl6-settings.js and lib/scrl-tsl6.js both use it.
//
// The app shows the board as one more device type. The board keeps its settings in milliseconds. The TSL6 pages
// work with small menu values in status bytes. Each table here maps a menu value to the board value.

// Device type of the board in this app. The TSL6 types are 3, 5, 6, 7, 8, 19.
export const H2_TYPE = 100;

// Settings fields that every board has. Every other field is hidden for the board, unless it is a ported feature.
export const H2_FIELDS = Object.freeze(["time", "jg", "jj"]);

// Ported TSL6 settings (firmware SCRL_FEATURES, since firmware 0.3.0). The board has one when its Settings JSON has
// the key. The key is the TSL6 setting ID, and the value is the TSL6 raw value. [id, highest value the board takes]
export const H2_FEATURES = Object.freeze([["lr", 2], ["rand", 1]]);

// Feature keys of the connected board. The board link sets them after each Settings read.
let boardKeys = new Set();
let boardTsl6 = false;
export function h2SetBoardSettings(settings) {
  boardKeys = new Set(H2_FEATURES.map(([id]) => id).filter(id => settings && Number.isInteger(settings[id])));
  boardTsl6 = !!settings && typeof settings.tsl6 === "string" && /^[0-9a-f]{56}$/i.test(settings.tsl6);
}
export const h2Has = id => boardKeys.has(id);

// TSL6 car features engine (firmware 0.5.0): the board runs the TSL6 car code. Its Settings JSON has "tsl6", the
// 28 settings bytes of the TSL6 (A3 status bytes 24-35, then 59-74) as hex. The board then shows the TSL6 car and
// lab rows of device type H2_TSL6_TYPE. Not shown:
//   - the "basic" rows (buzzer, LED, BLE power): the board has none of them,
//   - the "scroll" rows other than the board's own: the board's Scroll Ack sends the ticks,
//   - mianSwitch: the board has its op mode (Board page) for that,
//   - KERS and stoppingMode: the TSL6 code writes 0x334 bits that differ from the 2026-11-20 car capture
//     (stopping mode at d3 bits 3:2, regen at d0 bit 7). Not shown until the engine writes the right bits.
export const h2HasTsl6 = () => boardTsl6;
export const H2_TSL6_TYPE = 6;
export const H2_TSL6_GROUPS = Object.freeze(["car", "lab"]);
export const H2_TSL6_HIDDEN = Object.freeze(["mianSwitch", "KERS", "stoppingMode", "frontLeftBuckle", "frontRightBuckle", "rearBuckle"]);
// Factory "tsl6" value of the board: every car feature off.
export const H2_TSL6_FACTORY = "0000ff010100000001010000" + "0".repeat(32);
// True for a TSL6 settings field that the board's engine takes. f = a field of lib/tsl6-settings.js.
export const h2Tsl6Field = f => boardTsl6 && H2_TSL6_GROUPS.includes(f.group) && !H2_TSL6_HIDDEN.includes(f.id) &&
  (!f.types || f.types.includes(H2_TSL6_TYPE));
// Highest board value of a ported feature, or undefined for another field.
export const h2FeatureMax = id => (H2_FEATURES.find(([k]) => k === id) || [])[1];
// Every settings field of the connected board.
export const h2Fields = () => [...H2_FIELDS, ...H2_FEATURES.map(([id]) => id).filter(h2Has)];
// Car tab rows that the board has.
export const H2_ROWS = Object.freeze(["apAssist"]);

// A board value that no menu entry holds (set on the Board page). The menu shows it, and cannot select it.
export const H2_CUSTOM = 15;

// "time": the trigger and its time. Prompt values are the same as for the TSL6 prompt build.
//   [menu value, board mode (0 prompt, 1 timer), board delay_ms or interval_ms]
// Timer values 5 to 8 use the TSL6 menu numbers for 15-20 s to 30-35 s. Each board value is the middle of
// the TSL6 range, and the board adds its own +/- 20 % (the labels show the real range). Only a board that
// reports a longer Timer interval (Info "imax", firmware 0.3.2) has them.
export const H2_TIME = Object.freeze([
  [9, 0, 300], [0, 0, 600], [10, 0, 1000], [11, 0, 1500], [12, 0, 2000], [13, 0, 3000], [14, 0, 5000],
  [1, 1, 2500], [2, 1, 5000], [3, 1, 7500], [4, 1, 10000],
  [5, 1, 17500], [6, 1, 22500], [7, 1, 27500], [8, 1, 32500],
]);
// Longest Timer interval of the connected board, in ms. The board link sets it from Info (scrl.js intervalMax).
let intervalMax = 10000;
export function h2SetIntervalMax(ms) { intervalMax = ms; }
// The "time" entries that the connected board takes.
export const h2Times = () => H2_TIME.filter(([, mode, ms]) => mode === 0 || ms <= intervalMax);
// "jg": gap between the two ticks. [menu value, board gap_ms]
export const H2_GAP = Object.freeze([
  [1, 100], [2, 200], [3, 300], [4, 400], [5, 500], [6, 600], [7, 700], [8, 800], [9, 900], [10, 1000],
  [11, 1500], [12, 2000],
]);
// "jj": tick order. [menu value, board pattern]. Firmware 0.2.0 has "one tick only" where the TSL6 has "alternate"
// and "random". Firmware 0.3.0 has the TSL6 values (board patterns 4 and 5), and it came with "lr" and "rand".
export const H2_ORDER_OLD = Object.freeze([[1, 0], [0, 1], [2, 2], [3, 3]]);
export const H2_ORDER_TSL6 = Object.freeze([[1, 0], [0, 1], [2, 4], [3, 5]]);
export const h2Order = () => (h2Has("rand") ? H2_ORDER_TSL6 : H2_ORDER_OLD);

const secs = ms => (ms / 1000).toString();
// The board draws each timer interval from the mean +/- 20 %, or uses the mean when "rand" is 0.
const range = (ms, exact) => (exact ? secs(ms) : `${secs(ms * 0.8)}-${secs(ms * 1.2)}`);

// Menu options of a board field: [value, English label, Chinese label].
// current = the value now. H2_CUSTOM is listed only when it is the current value.
// values = the decoded values of the other fields (the "time" labels depend on "rand").
export function h2Options(id, current, values) {
  let list = [];
  if (id === "time") {
    const exact = h2Has("rand") && values && values.rand === 0;
    list = h2Times().map(([v, mode, ms]) => (mode === 0
      ? [v, `On hands-on prompt, after about ${secs(ms)} s${ms === 600 ? " (default)" : ""}`, `手扶提示时，约${secs(ms)}秒后${ms === 600 ? "(默认)" : ""}`]
      : [v, `Every ${range(ms, exact)} s, while AP is active`, `AP激活时，每${range(ms, exact)}秒`]));
  } else if (id === "jg") {
    list = H2_GAP.map(([v, ms]) => [v, `${secs(ms)} s${ms === 100 ? " (default)" : ""}`, `${secs(ms)}秒${ms === 100 ? "(默认)" : ""}`]);
  } else if (id === "jj") {
    const text = { 0: ["Down, then up (default)", "先减后加(默认)"], 1: ["Up, then down", "先加后减"], 2: ["Up only", "只加"], 3: ["Down only", "只减"],
      4: ["Alternate", "交替"], 5: ["Random", "随机"] };
    list = h2Order().map(([v, pattern]) => [v, ...text[pattern]]);
  } else if (id === "lr" && h2Has("lr")) {
    list = [[0, "Left wheel, volume (default)", "左滚轮，音量(默认)"], [1, "Right wheel, speed", "右滚轮，速度"],
      [2, "Left and right, alternate", "左右交替"]];
  } else if (id === "rand" && h2Has("rand")) {
    list = [[0, "Off: the exact timer interval", "关：固定间隔"], [1, "On (default)", "开(默认)"]];
  }
  if (current === H2_CUSTOM && (id === "time" || id === "jg")) list.push([H2_CUSTOM, "Custom value (Board page)", "自定义值（模块页）"]);
  return list;
}
