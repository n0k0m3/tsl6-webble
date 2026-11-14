// Device tab: connection (was the Bluetooth tab), module info, restart, preferences (was the Me tab).
import { h, L, btn, toast, confirmBox, clear, toggle, icon, chooseOption, getLang, setLang } from "../ui.js";
import { S, definePage, onBus, ask, go, savePref, setHwType, connect, disconnect, askPassword } from "../app.js";
import { WebLink, platformChunk, SAFE_CHUNK } from "../ble.js";
import { meInfo, buildA5 } from "../../lib/tsl6-status.js";

export const APP_BUILD = "2026-11-14";
const TYPES = [[6, "TSL6 (type 6)"], [8, "TSL6 (type 8)"], [19, "Type 19"], [7, "Type 7"], [5, "Type 5"], [3, "Type 3"]];

definePage("me", () => {
  const el = h("div", { class: "page", "data-page": "device" });
  let all = false;

  const chev = () => h("span", { class: "chev", style: { color: "var(--faint)" } }, icon("chevron-right", 18));
  const infoRow = (en, zh, value, first) => h("div", { class: "li" + (first ? " first" : "") },
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))),
    h("span", { class: "kv mono" }, value || "—"));
  const switchRow = (id, ico, en, zh, sen, szh, checked, onchange) => {
    const sw = toggle({ checked, label: L(en, zh), onchange });
    sw.dataset.id = `pref-${id}`;
    return [h("div", { class: "li" }, h("span", { class: "chip" }, icon(ico, 18)),
      h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), sen ? h("div", { class: "li-sub" }, L(sen, szh)) : null), sw), sw];
  };

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

  function connectionCard() {
    const link = S.link;
    const on = link && link.connected;
    const supported = S.mock || WebLink.available();
    if (!on) {
      const allBox = h("input", { type: "checkbox" });
      allBox.checked = all;
      allBox.addEventListener("change", () => { all = allBox.checked; });
      return h("div", { class: "card" },
        h("div", { class: "li first" }, h("span", { class: "chip" }, icon("bluetooth-off", 18)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Not connected", "未连接"))),
            h("div", { class: "li-sub" }, supported ? L("Pick TSL6 in the browser's Bluetooth list.", "在浏览器的蓝牙列表中选择 TSL6。")
              : L("This browser has no Web Bluetooth.", "此浏览器不支持网页蓝牙。"))),
          supported ? h("button", { class: "btn primary small", type: "button", "data-id": "connect", onclick: () => connect({ all }) }, L("Connect", "连接")) : null),
        supported ? h("label", { class: "li", style: { cursor: "pointer" } }, allBox,
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Show all devices", "显示所有设备"))),
            h("div", { class: "li-sub" }, L("Use it if the module does not appear.", "找不到模块时使用。")))) : null);
    }
    const sizes = [[platformChunk(), L(`${platformChunk()} bytes (default)`, `${platformChunk()} 字节（默认）`)], [SAFE_CHUNK, L("20 bytes (safe, slow)", "20 字节（稳定，较慢）")]];
    return h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip green" }, icon("bluetooth-connected", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, link.name)),
          h("div", { class: "li-sub" }, link.authed ? L("Connected · password accepted", "已连接 · 密码已验证") : L("Connected · password needed", "已连接 · 需要密码"))),
        h("button", { class: "btn small", type: "button", "data-id": "disconnect", onclick: () => disconnect() }, L("Disconnect", "断开"))),
      link.authed ? null : h("div", { class: "li" }, h("span", { class: "chip amber" }, icon("key-round", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("BLE password", "蓝牙密码"))),
          h("div", { class: "li-sub" }, L("The module sends data only after the password.", "模块需验证密码后才发送数据。"))),
        h("button", { class: "btn primary small", type: "button", "data-id": "enter-password", onclick: () => askPassword("manual") }, L("Enter password", "输入密码"))),
      h("div", { class: "li" }, h("span", { class: "chip" }, icon("activity", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Module reply", "模块应答"))),
          h("div", { class: "li-sub" }, S.status ? L(`Status received (${S.status.length} bytes)`, `已收到状态（${S.status.length} 字节）`) : L("No reply yet", "尚无应答"))),
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const p = await link.readStatus().catch(() => null);
          toast(p ? L("Status read", "读取成功") : L("No reply from the module.", "模块无应答"), p ? "ok" : "warn");
        } }, L("Read", "读取"))),
      h("button", { class: "li", type: "button", onclick: async () => {
        const v = await chooseOption({ title: L("Bytes per BLE write", "每次写入字节数"), options: sizes, value: link.chunk });
        if (v != null) { link.setChunk(Number(v)); render(); toast(L("Saved", "已保存"), "ok"); }
      } }, h("span", { class: "chip" }, icon("sliders-horizontal", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Bytes per BLE write", "每次写入字节数"))),
          h("div", { class: "li-sub" }, L("Drops to 20 after a write error", "写入出错时自动降为20"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, String(link.chunk)), chev())));
  }

  function render() {
    clear(el);
    const m = S.status ? meInfo(S.status) : null;
    el.append(h("h1", { class: "lg-title" }, L("Device", "设备")));
    el.append(h("div", { class: "sec-label" }, L("Connection", "连接")), connectionCard());

    el.append(h("div", { class: "sec-label" }, L("Module", "模块")), h("div", { class: "card" },
      infoRow("Device ID", "设备ID", m && m.moduleId, true),
      infoRow("MAC", "设备MAC", m && m.mac),
      m && m.vin ? infoRow("Vehicle VIN", "车辆VIN", m.vin) : null,
      infoRow("Firmware", "固件版本", m && m.runVersion),
      infoRow("Bootloader", "BOOT版本", m && m.bootVersion),
      infoRow("App build", "应用版本", APP_BUILD)));
    el.append(h("p", { class: "sec-foot" }, L("The version comes from the module (status byte 2). The vendor app may show a different number from its server.",
      "版本号来自模块（状态字节2）。原厂小程序可能显示其服务器提供的版本号。")));

    el.append(h("div", { class: "sec-label" }, L("Actions", "操作")), h("div", { class: "card" },
      h("button", { class: "li first", type: "button", "data-id": "restart", onclick: restart },
        h("span", { class: "chip blue" }, icon("refresh-cw", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Restart module", "重启模块")))), chev()),
      h("button", { class: "li", type: "button", "data-id": "clear-cache", onclick: clearCache },
        h("span", { class: "chip" }, icon("trash-2", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Clear saved data", "清除缓存"))),
          h("div", { class: "li-sub" }, L("Saved passwords and options in this browser", "此浏览器中保存的密码与选项"))), chev())));

    const lang = h("div", { class: "seg", style: { margin: 0, width: "140px" } },
      ["en", "zh"].map(l => h("button", { type: "button", class: getLang() === l ? "on" : "", onclick: () => setLang(l) }, l === "en" ? "EN" : "中文")));
    const [gaugeRow, gaugeSw] = switchRow("autoGauge", "gauge", "Open gauges on connect", "自动进入仪表", null, null, S.prefs.autoGauge,
      async v => { savePref("autoGauge", v); gaugeSw.set(v); });
    const [driveRow, driveSw] = switchRow("allowDrive", "shield-alert", "Allow driving-system controls", "允许驾驶系统控制",
      "Motor off, ESP off, service mode, CAN send", "关闭电机、关闭ESP、维护模式、CAN发送", S.prefs.allowDrive, async v => {
        if (v && !(await confirmBox({
          en: "This allows: rear motor off, front motor off, ESP off, Tesla service mode and raw CAN send. They change how the car drives and brakes. Use them only when the car is parked and you know the result. Allow?",
          zh: "将允许：关闭后电机、关闭前电机、关闭ESP、特斯拉维护模式以及CAN原始数据发送。这些功能会改变车辆的驱动与制动。仅在驻车且明确后果时使用。确定允许吗?",
        }, L("Warning", "警告"), L("Allow", "允许"), { focusCancel: true }))) return;
        savePref("allowDrive", v); driveSw.set(v);
      });
    const [skipRow, skipSw] = switchRow("skipUntested", "triangle-alert", "No warning for untested commands", "不再提示未测试指令", null, null, S.prefs.skipUntested,
      async v => { savePref("skipUntested", v); skipSw.set(v); });
    el.append(h("div", { class: "sec-label" }, L("Preferences", "偏好设置")), h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip" }, icon("languages", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Language", "语言")))), lang),
      h("button", { class: "li", type: "button", "data-id": "pref-hwType", onclick: async () => {
        const v = await chooseOption({ title: L("Device type", "设备类型"), options: TYPES, value: S.hwType });
        if (v != null) { setHwType(Number(v)); render(); toast(L("Saved", "已保存"), "ok"); }
      } }, h("span", { class: "chip" }, icon("cpu", 18)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Device type", "设备类型"))),
          h("div", { class: "li-sub" }, L("The vendor app gets it from its server.", "原厂小程序从服务器获取。"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, (TYPES.find(t => t[0] === S.hwType) || [0, String(S.hwType)])[1]), chev())),
      gaugeRow, driveRow, skipRow));

    el.append(h("div", { class: "sec-label" }, L("About", "关于")), h("div", { class: "card pad" },
      h("p", { style: { margin: "0 0 8px", fontSize: "14.5px" } }, L(
        "This app replaces the vendor WeChat Mini App. It runs in your browser and makes no network calls. Shortcut names and help texts are a copy of the vendor server data from 2026-11-13.",
        "本应用替代原厂微信小程序，在浏览器中运行，不进行任何网络请求。快捷指令名称与帮助说明取自原厂服务器（2026-11-13）。")),
      h("p", { style: { margin: 0, fontSize: "13.5px", color: "var(--muted)" } }, L(
        "Not affiliated with the module maker or Tesla. Use at your own risk. Work only while the car is parked.",
        "与模块厂商及特斯拉无关。风险自负。请仅在驻车时操作。"))));
  }

  const offs = [];
  render();
  return {
    el,
    enter() { offs.push(onBus("status", render)); offs.push(onBus("conn", render)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
