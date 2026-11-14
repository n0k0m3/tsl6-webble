// Me tab (vendor pages/my): module info, restart, firmware, tools, advanced options.
import { h, L, row, section, btn, toast, confirmBox, alertBox, clear, picker, toggle, icon, helpButton } from "../ui.js";
import { S, definePage, onBus, ask, go, savePref, setHwType, rerender } from "../app.js";
import { meInfo, buildA5 } from "../../lib/tsl6-status.js";

export const APP_BUILD = "2026-11-14";

const TYPES = [[6, "TSL6 (type 6)"], [8, "TSL6 (type 8)"], [19, "Type 19"], [7, "Type 7"], [5, "Type 5"], [3, "Type 3"]];

definePage("me", () => {
  const el = h("div", { class: "page" });

  function info(label, value, { mono = true, iconName } = {}) {
    return h("div", { class: "row" },
      h("div", { class: "row-left" }, iconName ? h("span", { style: { color: "var(--warn)" } }, icon(iconName, 22)) : null,
        h("span", { class: "row-label" }, L(label))),
      h("span", { class: "kv" + (mono ? " mono" : "") }, value || "—"));
  }
  function nav(label, id, iconName) {
    return h("button", { class: "row navrow", type: "button", onclick: () => go(id) },
      h("div", { class: "row-left" }, h("span", { style: { color: "var(--mint-d)" } }, icon(iconName, 22)), h("span", { class: "row-label" }, L(label))),
      h("span", { class: "kv" }, "›"));
  }

  async function restart() {
    if (!S.status) return toast(L("Connect to the module first.", "请先连接蓝牙"));
    const c = buildA5(S.status);
    const r = await ask(c.type, c.payload, { confirm: { en: "Restart the module?", zh: "确定要重启模块吗?" }, timeout: 3000 });
    if (r) toast(L("Module restarted", "重启模块成功"), "ok");
  }
  async function clearCache() {
    if (!(await confirmBox({ en: "Clear the data that this app keeps in this browser (saved BLE passwords and options)?", zh: "确定清除本应用在此浏览器中保存的数据（蓝牙密码与选项）吗?" }))) return;
    try { for (const k of Object.keys(localStorage)) if (k.startsWith("tsl6.") && k !== "tsl6.lang") localStorage.removeItem(k); } catch { /* storage blocked */ }
    toast(L("Cleared", "已清除"), "ok");
    setTimeout(() => location.reload(), 600);
  }

  function render() {
    clear(el);
    const m = S.status ? meInfo(S.status) : null;
    const link = S.link;
    el.append(section(null,
      info({ en: "Device name", zh: "设备名称" }, link && link.connected ? link.name : "", { mono: false, iconName: "me" }),
      info({ en: "Device ID", zh: "设备ID" }, m && m.moduleId, { iconName: "log" }),
      info({ en: "Device MAC", zh: "设备MAC" }, m && m.mac, { iconName: "ble" }),
      m && m.vin ? info({ en: "Vehicle VIN", zh: "车辆VIN" }, m.vin, { iconName: "frunk" }) : null,
      h("div", { class: "row" },
        h("div", { class: "row-left" }, h("span", { style: { color: "var(--mint-d)" } }, icon("flash", 22)), h("span", { class: "row-label" }, L("Firmware", "固件版本"))),
        h("div", { class: "row-right" },
          h("a", { class: "btn small", href: "flash.html#flash" }, L("Flash firmware", "刷写固件")),
          h("span", { class: "kv mono" }, m ? `${m.runVersion}` : "—"))),
      info({ en: "Bootloader", zh: "BOOT版本" }, m && m.bootVersion),
      info({ en: "App build", zh: "应用版本" }, APP_BUILD),
    ));
    el.append(h("p", { class: "foot" }, L(
      "The version comes from the module (status byte 2). The vendor app may show a different number from its server.",
      "版本号来自模块（状态字节2）。原厂小程序可能显示其服务器提供的版本号。")));

    el.append(section(null,
      h("button", { class: "row navrow", type: "button", onclick: restart },
        h("div", { class: "row-left" }, h("span", { style: { color: "#3b82f6" } }, icon("power", 22)), h("span", { class: "row-label" }, L("Restart module", "重启模块"))), h("span", { class: "kv" }, "›")),
      h("button", { class: "row navrow", type: "button", onclick: clearCache },
        h("div", { class: "row-left" }, h("span", { style: { color: "var(--warn)" } }, icon("trash", 22)), h("span", { class: "row-label" }, L("Clear cache", "清除缓存"))), h("span", { class: "kv" }, "›"))));

    el.append(section({ en: "Tools", zh: "工具" },
      nav({ en: "Battery info", zh: "电池信息" }, "battery", "battery"),
      nav({ en: "Gauges", zh: "仪表盘" }, "gauge", "gauge"),
      nav({ en: "BLE host pairing", zh: "蓝牙配对" }, "blehost", "ble"),
      nav({ en: "CAN debug", zh: "数据调试模式" }, "debug", "log"),
      nav({ en: "Log and capture", zh: "日志与抓包" }, "log", "log")));

    const drive = toggle({ checked: S.prefs.allowDrive, label: L("Allow driving-system controls", "允许驾驶系统控制"), onchange: async v => {
      if (v && !(await confirmBox({
        en: "This allows: rear motor off, front motor off, ESP off, Tesla service mode and raw CAN send. They change how the car drives and brakes. Use them only when the car is parked and you know the result. Allow?",
        zh: "将允许：关闭后电机、关闭前电机、关闭ESP、特斯拉维护模式以及CAN原始数据发送。这些功能会改变车辆的驱动与制动。仅在驻车且明确后果时使用。确定允许吗?",
      }, L("Warning", "警告"), L("Allow", "允许")))) return;
      savePref("allowDrive", v); drive.set(v);
    } });
    const skip = toggle({ checked: S.prefs.skipUntested, label: L("No warning for untested commands", "不再提示未测试指令"), onchange: async v => { savePref("skipUntested", v); skip.set(v); } });
    el.append(section({ en: "Advanced", zh: "高级" },
      row({ en: "Device type", zh: "设备类型" }, { note: L("The vendor app gets it from its server.", "原厂小程序从服务器获取") },
        picker({ value: S.hwType, options: TYPES, onchange: v => { setHwType(v); toast(L("Saved", "已保存"), "ok"); } })),
      row({ en: "Allow driving-system controls", zh: "允许驾驶系统控制" }, { note: L("off by default", "默认关闭") }, drive),
      row({ en: "No warning for untested commands", zh: "不再提示未测试指令" }, {}, skip)));

    el.append(section({ en: "About", zh: "关于" }, h("div", { class: "form" },
      h("p", { style: { margin: 0 } }, L(
        "This app replaces the vendor WeChat Mini App. It runs in your browser and makes no network calls. Shortcut names and help texts are a copy of the vendor server data from 2026-11-13.",
        "本应用替代原厂微信小程序，在浏览器中运行，不进行任何网络请求。快捷指令名称与帮助说明取自原厂服务器（2026-11-13）。")),
      h("p", { style: { margin: 0, color: "var(--muted)" } }, L(
        "Not affiliated with the module maker or Tesla. Use at your own risk. Work only while the car is parked.",
        "与模块厂商及特斯拉无关。风险自负。请仅在驻车时操作。")))));
  }

  const offs = [];
  render();
  return {
    el,
    enter() { offs.push(onBus("status", render)); offs.push(onBus("conn", render)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
