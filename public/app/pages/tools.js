// Tool rows: the vendor settings-page buttons and the tool pages. The tabs show them where their job is.
// Restore defaults and service mode keep their vendor confirms and gates.
import { h, L, icon, toast } from "../ui.js";
import { S, ask, send, go, isH2 } from "../app.js";
import { SET_ACTIONS, buildA4, serviceModeCommand } from "../../lib/tsl6-status.js";
import { decodeSettings } from "../../lib/tsl6-settings.js";
import { h2Tools, h2HasEngine } from "../../lib/h2-menus.js";

async function restoreDefaults() {
  if (!S.status) return toast(L("Connect to the module first.", "请先连接蓝牙"));
  const a = SET_ACTIONS.find(x => x.id === "reset");
  const c = buildA4(S.status);
  // For the H2 board the link writes the board defaults. The confirm says what they are.
  const confirm = isH2() ? (h2HasEngine() ? {
    en: "Restore the board settings to their defaults? Scroll Ack goes off and the board goes to Listen-Only. The TSL6 car features go back to their factory settings, with the shortcuts and the BLE buttons. The bonds and the passkey stay.",
    zh: "将模块设置恢复为默认值吗？免打扰关闭，模块进入只听模式。TSL6车辆功能恢复出厂设置，快捷指令和蓝牙按钮也一并恢复。配对和配对码保留。",
  } : {
    en: "Restore the board settings to their defaults? Scroll Ack goes off and the board goes to Listen-Only. The bonds and the passkey stay.",
    zh: "将模块设置恢复为默认值吗？免打扰关闭，模块进入只听模式。配对和配对码保留。",
  }) : a.confirm;
  const r = await ask(c.type, c.payload, { confirm, timeout: 3000 });
  if (r) { toast(L("Defaults restored", "恢复默认设置成功"), "ok"); setTimeout(() => S.link.readStatus().catch(() => {}), 500); }
}
async function serviceMode() {
  const c = serviceModeCommand({ allowDangerous: true });
  if (await send(c.type, c.payload, { danger: "service", confirm: { en: c.confirm.en, zh: c.confirm.zh.replace(/\r/g, "") } })) toast(L("Sent", "指令已发送"), "ok");
}

// Each tool row sits on the tab where its job is. There is no Tools tab.
//   Car: the car readouts (battery, gauges). Settings: the module rules (shortcuts, BLE buttons, ambient light).
//   Device: the board, the firmware, the data files and the upkeep of the module.
// A row keeps its data-id "tool-<id>", its gate and its confirm on every tab.
// [icon, chip color, en, zh, sub en, sub zh, action]
const TOOLS = {
  board: ["circuit-board", "", "Board", "模块", "Op mode, live state, counters, pairing", "运行模式、实时状态、计数器、配对", () => go("board")],
  boardfw: ["hard-drive-download", "", "Update firmware", "更新固件", "Update the board over Bluetooth", "通过蓝牙更新模块", () => go("boardfw")],
  capture: ["activity", "", "Capture", "采集", "Record Vehicle CAN to a file", "将车辆CAN记录到文件", () => go("capture")],
  shortcuts: ["workflow", "", "Shortcuts", "快捷指令", "A car event runs a car action", "车辆事件触发车辆动作", () => go("shortcuts")],
  blebtn: ["radio", "", "BLE buttons", "蓝牙按钮", "Remote buttons and their actions", "遥控按钮及其动作", () => go("blebtn")],
  rgb: ["palette", "", "Ambient light", "原厂氛围灯", "Zone rules and effects", "分区联动与整车效果", () => go("rgb")],
  gauge: ["gauge", "", "Gauges", "仪表盘", "Full-screen dashboard", "全屏仪表", () => go("gauge")],
  battery: ["battery-medium", "", "Battery", "电池信息", "Pack, cells and DC-DC", "动力电池、单体电压、DCDC", () => go("battery")],
  backup: ["database-backup", "", "Backup and restore", "备份恢复", "Settings, shortcuts and buttons in one file", "设置、快捷指令和按钮存为一个文件", () => go("backup")],
  log: ["file-text", "", "Log and capture", "日志与抓包", "Frames sent and received", "收发数据帧", () => go("log")],
  password: ["key-round", "", "Change password", "修改密码", "The BLE password of the module", "模块的蓝牙密码", () => go("password")],
  firmware: ["hard-drive-download", "", "Update firmware", "更新固件", "Update the runtime, or recover a module in boot mode", "更新运行固件，或恢复处于升级模式的模块", () => go("firmware")],
  reset: ["rotate-ccw", "red", "Restore defaults", "恢复默认", "Resets every module setting", "重置模块所有设置", restoreDefaults],
  blehost: ["bluetooth-searching", "", "BLE host pairing", "蓝牙配对", "Devices that the module connects to", "模块连接的蓝牙设备", () => go("blehost")],
  debug: ["terminal", "", "CAN debug", "数据调试模式", "Watch and send CAN frames", "查看与发送CAN数据", () => go("debug")],
  service: ["wrench", "amber", "Tesla service mode", "特斯拉维护模式", "Needs P and driving-system controls allowed", "需要P档，并允许驾驶系统控制", serviceMode],
};
// Rows that run an action behind a confirm: the label of their trailing button.
const ACTION = { reset: ["Restore", "恢复"], service: ["Start", "启动"] };
// The tools that the old Me tab showed. They stay while the module is off; the other tools hide, as in the vendor app.
const WHEN_OFF = ["password", "reset", "firmware", "log", "battery", "blehost", "debug", "gauge"];
export const moduleOff = () => !!S.status && !S.blank && decodeSettings(S.status).mianSwitch === 1;
// The tools of this list that the connected device has now.
export function toolsShown(ids) {
  const off = moduleOff();
  return ids.filter(id => (isH2() ? h2Tools().includes(id) : id !== "board" && id !== "boardfw" && id !== "capture" && (!off || WHEN_OFF.includes(id))));
}
// The rows of the tools in ids that the device has, in the order of ids.
export function toolRows(ids) {
  return toolsShown(ids).map(id => {
    const [ico, color, en, zh, sen, szh, fn] = TOOLS[id];
    return h("button", { class: "li" + (color === "red" ? " danger" : color === "amber" ? " caution" : ""), type: "button", "data-id": `tool-${id}`, onclick: fn },
      h("span", { class: "chip " + color }, icon(ico, 22)),
      h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), h("div", { class: "li-sub" }, L(sen, szh))),
      ACTION[id] ? h("span", { class: "btn small" + (color === "red" ? " danger-text" : ""), "aria-hidden": "true" }, L(...ACTION[id]))
        : h("span", { class: "chev" }, icon("chevron-right", 18)));
  });
}
// One titled group of tool rows (and extra rows), or null when the device has none of them.
export function toolGroup(en, zh, ids, extra = []) {
  const rows = [...toolRows(ids), ...extra.filter(Boolean)];
  if (!rows.length) return null;
  return h("section", { class: "grp" }, h("div", { class: "sec-label" }, L(en, zh)), h("div", { class: "card" }, rows));
}
// The note under a tab while the module is off and some of its tools hide. ids: the tools of that tab.
export function offNote(ids) {
  if (isH2() || !moduleOff() || !ids.some(id => !WHEN_OFF.includes(id))) return null;
  return h("p", { class: "sec-foot span" }, L("The module is off, so some rows are hidden. Turn it on with the master switch in Settings.", "模块已停用，部分选项已隐藏。请在设置中打开总开关。"));
}
