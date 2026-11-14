// Tools tab: the vendor settings-page buttons and the tool pages, in one list.
// Restore defaults and service mode keep their vendor confirms and gates.
import { h, L, icon, toast, clear } from "../ui.js";
import { S, definePage, onBus, ask, send, go } from "../app.js";
import { SET_ACTIONS, buildA4, serviceModeCommand } from "../../lib/tsl6-status.js";

async function restoreDefaults() {
  if (!S.status) return toast(L("Connect to the module first.", "请先连接蓝牙"));
  const a = SET_ACTIONS.find(x => x.id === "reset");
  const c = buildA4(S.status);
  const r = await ask(c.type, c.payload, { confirm: a.confirm, timeout: 3000 });
  if (r) { toast(L("Defaults restored", "恢复默认设置成功"), "ok"); setTimeout(() => S.link.readStatus().catch(() => {}), 500); }
}
async function serviceMode() {
  const c = serviceModeCommand({ allowDangerous: true });
  if (await send(c.type, c.payload, { danger: "service", confirm: { en: c.confirm.en, zh: c.confirm.zh.replace(/\r/g, "") } })) toast(L("Sent", "指令已发送"), "ok");
}

// [id, icon, chip color, en, zh, sub en, sub zh, action]
const GROUPS = [
  { en: "Car features", zh: "车辆功能", items: [
    ["shortcuts", "workflow", "blue", "Shortcuts", "快捷指令", "Run a car action from a button or an event", "用按键或事件触发车辆动作", () => go("shortcuts")],
    ["blebtn", "radio", "blue", "BLE buttons", "蓝牙按钮", "Pair remote buttons and set their actions", "配对蓝牙按钮并设置动作", () => go("blebtn")],
    ["rgb", "palette", "blue", "Ambient light", "原厂氛围灯", "Zone rules and whole-car effects", "分区联动与整车效果", () => go("rgb")],
    ["gauge", "gauge", "blue", "Gauges", "仪表盘", "Full-screen dashboard", "全屏仪表", () => go("gauge")],
  ] },
  { en: "Data", zh: "数据", items: [
    ["battery", "battery-medium", "green", "Battery", "电池信息", "Pack, cells and DC-DC", "动力电池、单体电压、DCDC", () => go("battery")],
    ["backup", "database-backup", "green", "Backup and restore", "备份恢复", "Save settings, shortcuts and buttons to a file", "将设置、快捷指令和按钮保存为文件", () => go("backup")],
    ["log", "file-text", "green", "Log and capture", "日志与抓包", "Frames sent and received", "收发数据帧", () => go("log")],
  ] },
  { en: "Module", zh: "模块", items: [
    ["password", "key-round", "amber", "Change password", "修改密码", "The BLE password of the module", "模块的蓝牙密码", () => go("password")],
    ["firmware", "hard-drive-download", "amber", "Firmware", "固件", "Flash the runtime (opens the flasher)", "刷写固件（打开刷写页面）", () => { location.href = "flash.html"; }],
    ["reset", "rotate-ccw", "red", "Restore defaults", "恢复默认", "Reset every setting of the module", "将模块所有设置恢复默认", restoreDefaults],
  ] },
  { en: "Advanced", zh: "高级", items: [
    ["blehost", "bluetooth-searching", "", "BLE host pairing", "蓝牙配对", "Devices that the module connects to", "模块连接的蓝牙设备", () => go("blehost")],
    ["debug", "terminal", "", "CAN debug", "数据调试模式", "Watch and send CAN frames", "查看与发送CAN数据", () => go("debug")],
    ["service", "wrench", "red", "Tesla service mode", "特斯拉维护模式", "Car in P. Needs driving-system controls", "需挂P档，需允许驾驶系统控制", serviceMode],
  ] },
];

definePage("tools", () => {
  const el = h("div", { class: "page", "data-page": "tools" });
  function render() {
    clear(el);
    el.append(h("h1", { class: "lg-title" }, L("Tools", "工具")));
    // Like the vendor app: while the module is off, only restore defaults and change password stay.
    const moduleOff = S.status && !S.blank && S.status.length > 28 && ((S.status[28] >> 3) & 1) === 1;
    for (const g of GROUPS) {
      const items = g.items.filter(([id]) => !moduleOff || ["password", "reset", "firmware", "log"].includes(id));
      if (!items.length) continue;
      el.append(h("div", { class: "sec-label" }, L(g.en, g.zh)),
        h("div", { class: "card" }, items.map(([id, ico, color, en, zh, sen, szh, fn], i) =>
          h("button", { class: "li" + (i === 0 ? " first" : "") + (color === "red" ? " danger" : ""), type: "button", "data-id": `tool-${id}`, onclick: fn },
            h("span", { class: "chip " + color }, icon(ico, 18)),
            h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), h("div", { class: "li-sub" }, L(sen, szh))),
            h("span", { class: "chev", style: { color: "var(--faint)" } }, icon("chevron-right", 18))))));
    }
    if (moduleOff) el.append(h("p", { class: "sec-foot" }, L("The module is off, so most tools are hidden. Turn it on in Settings.", "模块已停用，大部分工具已隐藏。请在设置中启用。")));
  }
  const offs = [];
  render();
  return {
    el,
    enter() { offs.push(onBus("status", render)); offs.push(onBus("conn", render)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
