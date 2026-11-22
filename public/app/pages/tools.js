// Tools tab: the vendor settings-page buttons and the tool pages, in one list.
// Restore defaults and service mode keep their vendor confirms and gates.
import { h, L, icon, toast, clear } from "../ui.js";
import { S, definePage, onBus, ask, send, go, isH2 } from "../app.js";
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

// [id, icon, chip color, en, zh, sub en, sub zh, action]
// Tools that the BLE board has. Every other tool is hidden for the board.
const GROUPS = [
  { en: "BLE board", zh: "BLE模块", h2: true, items: [
    ["board", "cpu", "", "Board", "模块", "State, op mode, counters, pairing", "状态、运行模式、计数器、配对", () => go("board")],
    ["boardfw", "hard-drive-download", "", "Board firmware", "模块固件", "Update over Bluetooth", "通过蓝牙更新", () => go("boardfw")],
    ["capture", "activity", "", "Capture", "采集", "Record Vehicle CAN to a file", "将车辆CAN记录到文件", () => go("capture")],
  ] },
  { en: "Car features", zh: "车辆功能", items: [
    ["shortcuts", "workflow", "", "Shortcuts", "快捷指令", "A car event runs a car action", "车辆事件触发车辆动作", () => go("shortcuts")],
    ["blebtn", "radio", "", "BLE buttons", "蓝牙按钮", "Remote buttons and their actions", "遥控按钮及其动作", () => go("blebtn")],
    ["rgb", "palette", "", "Ambient light", "原厂氛围灯", "Zone rules and effects", "分区联动与整车效果", () => go("rgb")],
    ["gauge", "gauge", "", "Gauges", "仪表盘", "Full-screen dashboard", "全屏仪表", () => go("gauge")],
  ] },
  { en: "Data", zh: "数据", items: [
    ["battery", "battery-medium", "", "Battery", "电池信息", "Pack, cells and DC-DC", "动力电池、单体电压、DCDC", () => go("battery")],
    ["backup", "database-backup", "", "Backup and restore", "备份恢复", "Settings, shortcuts and buttons in one file", "设置、快捷指令和按钮存为一个文件", () => go("backup")],
    ["log", "file-text", "", "Log and capture", "日志与抓包", "Frames sent and received", "收发数据帧", () => go("log")],
  ] },
  { en: "Module", zh: "模块", items: [
    ["password", "key-round", "", "Change password", "修改密码", "The BLE password of the module", "模块的蓝牙密码", () => go("password")],
    ["firmware", "hard-drive-download", "", "Firmware", "固件", "Flash a runtime image", "刷写运行固件", () => go("firmware")],
    ["reset", "rotate-ccw", "red", "Restore defaults", "恢复默认", "Resets every module setting", "重置模块所有设置", restoreDefaults],
  ] },
  { en: "Advanced", zh: "高级", items: [
    ["blehost", "bluetooth-searching", "", "BLE host pairing", "蓝牙配对", "Devices that the module connects to", "模块连接的蓝牙设备", () => go("blehost")],
    ["debug", "terminal", "", "CAN debug", "数据调试模式", "Watch and send CAN frames", "查看与发送CAN数据", () => go("debug")],
    ["service", "wrench", "red", "Tesla service mode", "特斯拉维护模式", "Car in P, driving-system controls on", "P档，并允许驾驶系统控制", serviceMode],
  ] },
];

definePage("tools", () => {
  const el = h("div", { class: "page cols", "data-page": "tools" });
  function render() {
    clear(el);
    // While the module is off, the vendor settings-page tools hide; the tools that the old Me tab always showed stay.
    const moduleOff = !!S.status && !S.blank && decodeSettings(S.status).mianSwitch === 1;
    for (const g of GROUPS) {
      if (g.h2 && !isH2()) continue; // the board group shows only for a board
      const items = g.items.filter(([id]) => (isH2() ? h2Tools().includes(id) : !moduleOff || ["password", "reset", "firmware", "log", "battery", "blehost", "debug", "gauge"].includes(id)));
      if (!items.length) continue;
      el.append(h("section", { class: "grp" }, h("div", { class: "sec-label" }, L(g.en, g.zh)),
        h("div", { class: "card" }, items.map(([id, ico, color, en, zh, sen, szh, fn], i) =>
          h("button", { class: "li" + (i === 0 ? " first" : "") + (color === "red" ? " danger" : ""), type: "button", "data-id": `tool-${id}`, onclick: fn },
            h("span", { class: "chip " + color }, icon(ico, 22)),
            h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), h("div", { class: "li-sub" }, L(sen, szh))),
            h("span", { class: "chev" }, icon("chevron-right", 18)))))));
    }
    if (moduleOff) el.append(h("p", { class: "sec-foot span" }, L("The module is off, so most tools are hidden. Turn it on in Settings.", "模块已停用，大部分工具已隐藏。请在设置中启用。")));
  }
  const offs = [];
  render();
  return {
    el,
    refresh: render,
    enter() { offs.push(onBus("status", render)); offs.push(onBus("conn", render)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
