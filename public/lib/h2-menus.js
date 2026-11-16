// Menus of the H2 board (M5Stack NanoH2 + Unit Mini CAN) in terms of the TSL6 settings fields.
// Pure data: no BLE, no DOM, no imports. lib/tsl6-settings.js and lib/scrl-tsl6.js both use it.
//
// The app shows the board as one more device type. The board keeps its settings in milliseconds. The TSL6 pages
// work with small menu values in status bytes. Each table here maps a menu value to the board value.

// Device type of the board in this app. The TSL6 types are 3, 5, 6, 7, 8, 19.
export const H2_TYPE = 100;

// Settings fields that the board has. Every other field is hidden for the board.
export const H2_FIELDS = Object.freeze(["time", "jg", "jj"]);
// Car tab rows that the board has.
export const H2_ROWS = Object.freeze(["apAssist"]);

// A board value that no menu entry holds (set on the Board page). The menu shows it, and cannot select it.
export const H2_CUSTOM = 15;

// "time": the trigger and its time. Prompt values are the same as for the TSL6 prompt build.
//   [menu value, board mode (0 prompt, 1 timer), board delay_ms or interval_ms]
export const H2_TIME = Object.freeze([
  [9, 0, 300], [0, 0, 600], [10, 0, 1000], [11, 0, 1500], [12, 0, 2000], [13, 0, 3000], [14, 0, 5000],
  [1, 1, 2500], [2, 1, 5000], [3, 1, 7500], [4, 1, 10000],
]);
// "jg": gap between the two ticks. [menu value, board gap_ms]
export const H2_GAP = Object.freeze([
  [1, 100], [2, 200], [3, 300], [4, 400], [5, 500], [6, 600], [7, 700], [8, 800], [9, 900], [10, 1000],
  [11, 1500], [12, 2000],
]);
// "jj": tick order. [menu value, board pattern]. The board has "one tick only" where the TSL6 has "alternate" and "random".
export const H2_ORDER = Object.freeze([[1, 0], [0, 1], [2, 2], [3, 3]]);

const secs = ms => (ms / 1000).toString();
// The board draws each timer interval from the mean +/- 20 %.
const range = ms => `${secs(ms * 0.8)}-${secs(ms * 1.2)}`;

// Menu options of a board field: [value, English label, Chinese label].
// current = the value now. H2_CUSTOM is listed only when it is the current value.
export function h2Options(id, current) {
  let list = [];
  if (id === "time") {
    list = H2_TIME.map(([v, mode, ms]) => (mode === 0
      ? [v, `On hands-on prompt, after about ${secs(ms)} s${ms === 600 ? " (default)" : ""}`, `手扶提示时，约${secs(ms)}秒后${ms === 600 ? "(默认)" : ""}`]
      : [v, `Every ${range(ms)} s, while AP is active`, `AP激活时，每${range(ms)}秒`]));
  } else if (id === "jg") {
    list = H2_GAP.map(([v, ms]) => [v, `${secs(ms)} s${ms === 100 ? " (default)" : ""}`, `${secs(ms)}秒${ms === 100 ? "(默认)" : ""}`]);
  } else if (id === "jj") {
    const text = { 0: ["Down, then up (default)", "先减后加(默认)"], 1: ["Up, then down", "先加后减"], 2: ["Up only", "只加"], 3: ["Down only", "只减"] };
    list = H2_ORDER.map(([v, pattern]) => [v, ...text[pattern]]);
  }
  if (current === H2_CUSTOM && id !== "jj") list.push([H2_CUSTOM, "Custom value (Board page)", "自定义值（模块页）"]);
  return list;
}
