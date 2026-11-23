// Device tab: the hardware and its upkeep. Connection, the module or board, firmware, data files, maintenance,
// advanced tools and preferences. The tool rows come from tools.js and keep their data-id "tool-<id>".
import { h, L, toast, confirmBox, clear, toggle, icon, chooseOption, getLang, setLang, helpButton } from "../ui.js";
import { S, definePage, onBus, ask, savePref, setHwType, connect, disconnect, askPassword, go, isH2 } from "../app.js";
import { toolRows, toolGroup, offNote } from "./tools.js";
import { CHUNK_STEPS, resetReasonName, boardName, boardOf, CAN_NAMES } from "../../lib/scrl.js";
const linkInfo = () => (S.link && S.link.board ? S.link.board.info : null);
import { WebLink, platformChunk, SAFE_CHUNK } from "../ble.js";
import { meInfo, buildA5, ROW_BY_ID } from "../../lib/tsl6-status.js";

export const APP_BUILD = "2026-11-18";
const TYPES = [[6, "TSL6 (type 6)"], [8, "TSL6 (type 8)"], [19, "Type 19"], [7, "Type 7"], [5, "Type 5"], [3, "Type 3"]];

definePage("me", () => {
  const el = h("div", { class: "page cols", "data-page": "device" });
  let all = false;

  const chev = () => h("span", { class: "chev" }, icon("chevron-right", 18));
  const grp = (...kids) => h("section", { class: "grp" }, kids);
  // Mono only for IDs (hex, MAC, VIN); versions and dates use the text face.
  const infoRow = (en, zh, value, first, mono = false) => h("div", { class: "li" + (first ? " first" : "") },
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))),
    h("span", { class: "kv" + (mono ? " mono" : "") }, value || "—"));
  // A long value (a list) goes under its label, so the label does not wrap.
  const stackRow = (en, zh, value) => h("div", { class: "li stack" },
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh))), h("div", { class: "li-sub kv-sub" }, value || "—")));
  const switchRow = (id, ico, en, zh, sen, szh, checked, onchange, tone = "") => {
    const sw = toggle({ checked, label: L(en, zh), onchange });
    sw.dataset.id = `pref-${id}`;
    // The telltale lights with the switch.
    const chip = h("span", { class: "chip " + tone + (checked ? " on" : "") }, icon(ico, 22));
    const set = sw.set;
    sw.set = v => { set(v); chip.classList.toggle("on", !!v); };
    return [h("div", { class: "li" }, chip,
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
        h("div", { class: "li first" }, h("span", { class: "chip" }, icon("bluetooth-off", 22)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Not connected", "未连接"))),
            h("div", { class: "li-sub" }, supported ? L("Pick TSL6, or SCRL-xxxx for a BLE board, in the browser's Bluetooth list.", "在浏览器的蓝牙列表中选择 TSL6，BLE模块请选择 SCRL-xxxx。")
              : L("This browser has no Web Bluetooth.", "此浏览器不支持网页蓝牙。"))),
          supported ? h("button", { class: "btn primary small", type: "button", "data-id": "connect", onclick: () => connect({ all }) }, L("Connect", "连接")) : null),
        supported ? h("label", { class: "li check-row" }, allBox,
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Show all devices", "显示所有设备"))),
            h("div", { class: "li-sub" }, L("Use it if the module does not appear.", "找不到模块时使用。")))) : null);
    }
    // The H2 board uses this size only for its firmware update, and steps down after a cut write.
    const sizes = isH2() ? CHUNK_STEPS.map(n => [n, n === platformChunk() ? L(`${n} bytes (default)`, `${n} 字节（默认）`) : L(`${n} bytes`, `${n} 字节`)])
      : [[platformChunk(), L(`${platformChunk()} bytes (default)`, `${platformChunk()} 字节（默认）`)], [SAFE_CHUNK, L("20 bytes (safe, slow)", "20 字节（稳定，较慢）")]];
    return h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip green" }, icon("bluetooth-connected", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, link.name)),
          h("div", { class: "li-sub" }, link.boot ? L("Boot mode: flash a runtime with Update firmware below", "升级模式：请用下方「更新固件」刷写运行固件")
            : link.authed ? L("Connected", "已连接") : L("Connected, password needed", "已连接，需要密码"))),
        h("button", { class: "btn small", type: "button", "data-id": "disconnect", onclick: () => disconnect() }, L("Disconnect", "断开"))),
      link.authed || link.boot ? null : h("div", { class: "li" }, h("span", { class: "chip amber" }, icon("key-round", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("BLE password", "蓝牙密码"))),
          h("div", { class: "li-sub" }, L("The module sends data only after the password.", "模块需验证密码后才发送数据。"))),
        h("button", { class: "btn primary small", type: "button", "data-id": "enter-password", onclick: () => askPassword("manual") }, L("Enter password", "输入密码"))),
      h("div", { class: "li" }, h("span", { class: "chip" }, icon("activity", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Module reply", "模块应答"))),
          h("div", { class: "li-sub" }, S.status ? L(`Status received (${S.status.length} bytes)`, `已收到状态（${S.status.length} 字节）`) : L("No reply yet", "尚无应答"))),
        h("button", { class: "btn small", type: "button", onclick: async () => {
          const p = await link.readStatus().catch(() => null);
          toast(p ? L("Status read", "读取成功") : L("No reply from the module.", "模块无应答"), p ? "ok" : "warn");
        } }, L("Read", "读取"))),
      h("button", { class: "li", type: "button", onclick: async () => {
        const v = await chooseOption({ title: L("Bytes per BLE write", "每次写入字节数"), options: sizes, value: link.chunk });
        if (v != null) { link.setChunk(Number(v)); render(); toast(L("Saved", "已保存"), "ok"); }
      } }, h("span", { class: "chip" }, icon("sliders-horizontal", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Bytes per BLE write", "每次写入字节数"))),
          h("div", { class: "li-sub" }, isH2() ? L("For the firmware update. Steps down after a cut write", "用于固件更新。写入被截断后自动减小") : L("Drops to 20 after a write error", "写入出错时自动降为20"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, String(link.chunk)), chev())));
  }

  function render() {
    clear(el);
    const m = S.status ? meInfo(S.status) : null;
    el.append(grp(h("div", { class: "sec-label" }, L("Connection", "连接")), connectionCard()));

    // Upkeep of the module: one Firmware row (the runtime of a TSL6, the image of a board), password, restart, defaults.
    const restartRow = h("button", { class: "li", type: "button", "data-id": "restart", onclick: restart },
      h("span", { class: "chip" }, icon("refresh-cw", 22)),
      h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Restart module", "重启模块")))));
    el.append(grp(h("div", { class: "sec-label" }, L("Maintenance", "维护")), h("div", { class: "card" },
      ...toolRows(["firmware", "boardfw", "password"]), restartRow, ...toolRows(["reset"]))));
    el.append(toolGroup("Data", "数据", ["backup", "log", "capture"]) || "");
    el.append(toolGroup("Advanced", "高级", ["blehost", "debug", "service"]) || "");
    const off = offNote(["backup", "service"]);
    if (off) el.append(off);

    // The module or board details come after the actions: the actions are the jobs of this tab, the details a lookup.
    const info = isH2() && S.link.board ? S.link.board.info : null;
    if (info) {
      // BLE board: its own Info, not the TSL6 status bytes.
      const bo = boardOf(info);
      el.append(grp(h("div", { class: "sec-label" }, L(boardName(info), boardName(info, true))), h("div", { class: "card" },
        ...toolRows(["board"]),
        infoRow("Board type", "模块类型", bo.id),
        infoRow("Chip", "芯片", bo.chip),
        infoRow("CAN controller", "CAN 控制器", CAN_NAMES[bo.can] || bo.can),
        infoRow("Board ID", "模块ID", info.id, false, true),
        infoRow("Firmware", "固件版本", info.fw ? `${info.fw} (${info.build || "?"})` : null),
        infoRow("Built", "构建时间", info.built),
        infoRow("ESP-IDF", "ESP-IDF", info.idf),
        stackRow("Last reset reasons", "最近复位原因", Array.isArray(info.rst_log) ? info.rst_log.map(resetReasonName).join(", ") : null),
        infoRow("App build", "应用版本", APP_BUILD))));
    } else el.append(grp(h("div", { class: "sec-label" }, L("Module", "模块")), h("div", { class: "card" },
      infoRow("Device ID", "设备ID", m && m.moduleId, true, true),
      infoRow("MAC", "设备MAC", m && m.mac, false, true),
      m && m.vin ? infoRow("Vehicle VIN", "车辆VIN", m.vin, false, true) : null,
      infoRow("Firmware", "固件版本", m && m.runVersion),
      infoRow("Bootloader", "BOOT版本", m && m.bootVersion),
      infoRow("App build", "应用版本", APP_BUILD)),
    h("p", { class: "sec-foot" }, L("The module reports the firmware version. The vendor app may show another number.",
      "版本号由模块报告。原厂小程序可能显示其他版本号。"))));

    const lang = h("div", { class: "seg" },
      ["en", "zh"].map(l => h("button", { type: "button", class: getLang() === l ? "on" : "", onclick: () => setLang(l) }, l === "en" ? "EN" : "中文")));
    // The vendor shows this row only for the device types of the autoGauge row; its help text stays reachable.
    const ag = ROW_BY_ID.autoGauge;
    const autoGaugeShown = !ag.types || ag.types.includes(S.hwType);
    const [gaugeRow, gaugeSw] = switchRow("autoGauge", "gauge", "Open gauges on connect", "自动进入仪表", null, null, S.prefs.autoGauge,
      async v => { savePref("autoGauge", v); gaugeSw.set(v); });
    gaugeRow.querySelector(".li-title").append(helpButton(ag.help, { en: ag.en, zh: ag.zh }));
    const [driveRow, driveSw] = switchRow("allowDrive", "shield-alert", "Allow driving-system controls", "允许驾驶系统控制",
      "Motor off, ESP off, service mode, CAN send", "关闭电机、关闭ESP、维护模式、CAN发送", S.prefs.allowDrive, async v => {
        if (v && !(await confirmBox({
          en: "This allows: rear motor off, front motor off, ESP off, Tesla service mode and raw CAN send. They change how the car drives and brakes. Use them only when the car is parked and you know the result. Allow?",
          zh: "将允许：关闭后电机、关闭前电机、关闭ESP、特斯拉维护模式以及CAN原始数据发送。这些功能会改变车辆的驱动与制动。仅在驻车且明确后果时使用。确定允许吗?",
        }, L("Warning", "警告"), L("Allow", "允许"), { focusCancel: true }))) return;
        savePref("allowDrive", v); driveSw.set(v);
      }, "t-amber");
    const [skipRow, skipSw] = switchRow("skipUntested", "triangle-alert", "No warning for untested commands", "不再提示未测试指令", null, null, S.prefs.skipUntested,
      async v => { savePref("skipUntested", v); skipSw.set(v); });
    el.append(grp(h("div", { class: "sec-label" }, L("Preferences", "偏好设置")), h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip" }, icon("languages", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Language", "语言")))), lang),
      // An H2 board sets the type by itself: plain text, not a picker. The picker is for the TSL6 only.
      isH2() ? h("div", { class: "li", "data-id": "pref-hwType" }, h("span", { class: "chip" }, icon("cpu", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Device type", "设备类型"))),
          h("div", { class: "li-sub" }, L(`BLE board: ${boardName(linkInfo())}. Set by the board.`, `BLE模块：${boardName(linkInfo(), true)}。由模块决定。`))))
        : h("button", { class: "li", type: "button", "data-id": "pref-hwType", onclick: async () => {
          const v = await chooseOption({ title: L("Device type", "设备类型"), options: TYPES, value: S.hwType });
          if (v != null) { setHwType(Number(v)); render(); toast(L("Saved", "已保存"), "ok"); }
        } }, h("span", { class: "chip" }, icon("cpu", 22)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Device type", "设备类型"))),
            h("div", { class: "li-sub" }, L("The vendor app gets it from its server.", "原厂小程序从服务器获取。"))),
          h("div", { class: "li-trail" }, h("span", { class: "val" }, (TYPES.find(t => t[0] === S.hwType) || [0, String(S.hwType)])[1]), chev())),
      autoGaugeShown ? gaugeRow : null, driveRow, skipRow,
      h("button", { class: "li", type: "button", "data-id": "clear-cache", onclick: clearCache },
        h("span", { class: "chip" }, icon("trash-2", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Clear saved data", "清除缓存"))),
          h("div", { class: "li-sub" }, L("Saved passwords and options in this browser", "此浏览器中的密码与选项"))), chev()))));

    el.append(grp(h("div", { class: "sec-label" }, L("About", "关于")), h("div", { class: "card pad about" },
      h("p", null, L(
        "This app replaces the vendor WeChat Mini App. It runs in your browser and makes no network calls. Shortcut names and help texts are a copy of the vendor server data from 2026-11-13.",
        "本应用替代原厂微信小程序，在浏览器中运行，不进行任何网络请求。快捷指令名称与帮助说明取自原厂服务器（2026-11-13）。")),
      h("p", { class: "small" }, L(
        "Not affiliated with the module maker or Tesla. Use at your own risk. Work only while the car is parked.",
        "与模块厂商及特斯拉无关。风险自负。请仅在驻车时操作。")))));
  }

  const offs = [];
  render();
  return {
    el,
    enter() { offs.push(onBus("status", render)); offs.push(onBus("conn", render)); },
    refresh: render, // Back from a sub-page (auto gauges) must not show a stale link card
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
