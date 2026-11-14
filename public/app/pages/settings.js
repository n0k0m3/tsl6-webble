// Settings tab (vendor pages/set): action buttons and the settings rows. Each change writes one A3 at once.
import { h, L, row, section, picker, btn, toast, confirmBox, showHelp, clear, pressable } from "../ui.js";
import { S, definePage, onBus, ask, send, go, savePref, log } from "../app.js";
import { BY_ID, decodeSettings, encodeSettings, optionsFor, appliesTo, writeBlocker, settingsEchoMatches } from "../../lib/tsl6-settings.js";
import { SET_ACTIONS, buildA4, serviceModeCommand } from "../../lib/tsl6-status.js";

let ZH = null;
async function zhLabels() {
  if (!ZH) { try { ZH = await (await fetch(new URL("../../data/settings-zh.json", import.meta.url))).json(); } catch { ZH = {}; } }
  return ZH;
}

// Screen order (vendor, hw_ver 6/8). sub = the "..." picker of the row.
const CAR = [
  ["mianSwitch"], ["apAutoOpenType", "apAutoOpenTime"], ["oneClickOpenAP"], ["APSpeedExit"], ["fsd"], ["OffAPAutoWiper"],
  ["dynamicBrakeLight"], ["apHighBeam"], ["blinkHighBeam"], ["pluseHighBeam", "pluseHighBeamAndLowBeam"], ["pluseFrontFogLight"],
  ["pluseRearFogLight"], ["gentryHorn", "gentryHornCount"], ["pluseHorn", "longPluseHorn"], ["hornLinkedHighBeam"],
  ["highBeamLinkedHorn"], ["turnLightPriority"], ["openDoorHazardLight"], ["backHazardLight"], ["KERS"], ["stoppingMode"],
  ["autoSportMode"], ["autoParkBrake"], ["frontRightEasyAccess"], ["TimeOpenFrontBox"], ["TimeOpenChargeDoor"],
];
const LAB = ["airAutoArid", "backHazardRearFogLight", "steerAssistanceLighting"]; // the seat-belt rows need vendor admin: not shown
const BASIC = ["beep", "led", "BLEPWR"];
const ASSIST = ["automdr", "ModeMDR", "lr", "time", "rand", "enable_save", "jg", "jj", "dblclickMDR"];
// The vendor opens the help text after these change to a value > 0.
const HELP_ON_SET = new Set(["apAutoOpenType", "stoppingMode", "steerAssistanceLighting", "backHazardRearFogLight"]);

const ACTION_COLOR = { reset: "#F6931F", backup: "#C36FE4", xgblePass: "#33a6e9", btn: "#4CAF50", battery: "#777", blebtn: "#33a6e9", service: "#F6931F", rgb: "#C36FE4" };
const ACTION_ROWS = [["reset", "backup", "xgblePass"], ["btn", "battery", "blebtn"], ["service", null, "rgb"]];

definePage("settings", () => {
  const el = h("div", { class: "page" });
  let busy = false;

  function label(id) {
    const f = BY_ID[id];
    return { en: f.label, zh: ZH && ZH[id] ? ZH[id].zh : null };
  }
  function options(id, vals) {
    const f = BY_ID[id];
    const en = optionsFor(f, vals, S.hwType);
    let zh = ZH && ZH[id] && ZH[id].options;
    if (id === "lr" && [6, 8, 19].includes(S.hwType) && ZH) zh = ZH._lr68.options;
    if (id === "time" && ZH) zh = (vals.rand === 0 ? ZH._timeFixed : ZH._timeRand).options;
    return en.map(([v, t]) => [v, L(t, zh && zh[v])]);
  }

  async function save(id, raw, sel) {
    if (busy) return;
    const base = S.status;
    if (!base || S.blank) { toast(L("Enter the BLE password first.", "请先输入蓝牙密码"), "warn"); render(); return; }
    let payload;
    try { payload = encodeSettings(base, { [id]: raw }, S.hwType, id); } catch (e) { toast(e.message, "bad", 3000); render(); return; }
    const why = writeBlocker(payload);
    if (why) { toast(why, "bad", 4000); render(); return; }
    busy = true; if (sel) sel.disabled = true;
    try {
      let ok = false;
      for (let a = 0; a < 2 && !ok; a++) {
        const r = await ask(0xa3, payload, { reply: [0xa0, 0xa3], timeout: 3000, quiet: true });
        ok = !!r && settingsEchoMatches(payload, r.payload);
        if (r && !ok) log(`A3 echo differs (try ${a + 1}/2)`, "warn");
      }
      toast(ok ? L("Saved", "保存成功") : L("The module did not confirm the change.", "模块未确认此修改"), ok ? "ok" : "bad");
      if (ok && raw > 0 && HELP_ON_SET.has(id)) showHelp("help_" + id, L(label(id)));
    } finally {
      busy = false;
      render();
    }
  }

  function settingRow(id, vals, subId) {
    const f = BY_ID[id];
    if (!f || !appliesTo(f, S.hwType) || vals[id] === undefined) return null;
    const ctl = picker({ value: vals[id], options: options(id, vals), label: L(label(id)), onchange: (v, s) => save(id, v, s) });
    const extra = [];
    if (subId && vals[subId] !== undefined) {
      const sub = picker({ value: vals[subId], options: options(subId, vals), label: L(label(subId)), text: "···", onchange: (v, s) => save(subId, v, s) });
      sub.classList.add("sub-btn");
      extra.push(sub);
    }
    return row(label(id), { help: "help_" + id, helpTitle: label(id) }, ...extra, ctl);
  }

  async function onAction(id) {
    const a = SET_ACTIONS.find(x => x.id === id);
    if (id === "reset") {
      if (!S.status) return toast(L("Connect to the module first.", "请先连接蓝牙"));
      const c = buildA4(S.status);
      const r = await ask(c.type, c.payload, { confirm: a.confirm, timeout: 3000 });
      if (r) { toast(L("Defaults restored", "恢复默认设置成功"), "ok"); setTimeout(() => S.link.readStatus().catch(() => {}), 500); }
    } else if (id === "service") {
      const c = serviceModeCommand({ allowDangerous: true });
      if (await send(c.type, c.payload, { danger: "service", confirm: { en: c.confirm.en, zh: c.confirm.zh.replace(/\r/g, "") } })) toast(L("Sent", "指令已发送"), "ok");
    } else {
      go({ backup: "backup", xgblePass: "password", btn: "shortcuts", battery: "battery", blebtn: "blebtn", rgb: "rgb" }[id]);
    }
  }

  function render() {
    clear(el);
    const p = S.status;
    const ready = p && !S.blank;
    const vals = ready ? decodeSettings(p) : {};
    const moduleOff = vals.mianSwitch === 1;

    // Action buttons (always shown; navigation buttons hide while the module is off, as in the vendor app).
    const grid = h("div", { class: "act-grid" });
    for (const line of ACTION_ROWS) for (const id of line) {
      if (!id) { grid.append(h("span")); continue; }
      const a = SET_ACTIONS.find(x => x.id === id);
      const hide = moduleOff && a.gate;
      if (hide) { grid.append(h("span")); continue; }
      const b = btn({ en: a.en, zh: a.zh }, () => onAction(id), { color: ACTION_COLOR[id], kind: "act" });
      if (id === "service") b.classList.add("wide");
      grid.append(b);
    }
    el.append(h("section", { class: "card pad" }, grid));

    if (!ready) {
      el.append(section(null, h("p", { class: "empty" }, !p
        ? L("Connect to the module to read the settings.", "请先连接蓝牙")
        : L("Enter the BLE password to read the settings.", "请先输入蓝牙密码"))));
      return;
    }

    const car = [];
    for (const [id, sub] of CAR) {
      if (moduleOff && id !== "mianSwitch") continue;
      car.push(settingRow(id, vals, sub));
    }
    if (!moduleOff) {
      const lab = picker({
        value: S.prefs.lab ? 1 : 0, label: L("Lab functions", "实验室功能"),
        options: [[0, L("Off (default)", "关闭(默认)")], [1, L("On", "开启")]],
        onchange: async (v, s) => {
          if (v === 1 && !(await confirmBox({
            en: "Lab functions may be unstable. Use them with care. (The vendor app asks for a code from its server here. This app has no server, so it asks only for this confirmation.)",
            zh: "实验室功能谨慎使用(可能不稳定)。原厂小程序需输入服务器提供的实验码，本应用无服务器，仅需确认。",
          }))) { s.value = "0"; return; }
          savePref("lab", v === 1); render();
        },
      });
      const r = row({ en: "Lab functions", zh: "实验室功能" }, { help: "help_test", helpTitle: { en: "Lab functions", zh: "实验室功能" }, cls: "lab" }, lab);
      car.push(r);
      if (S.prefs.lab) for (const id of LAB) car.push(settingRow(id, vals));
    }
    el.append(section({ en: "Basic functions", zh: "基本功能设置" }, car));
    if (moduleOff) return;
    el.append(section({ en: "Basic parameters", zh: "基本参数设置" }, BASIC.map(id => settingRow(id, vals))));
    el.append(section({ en: "AP assist parameters", zh: "AP辅助参数设置" }, ASSIST.map(id => settingRow(id, vals))));
  }

  const offs = [];
  render();
  return {
    el,
    enter() {
      zhLabels().then(() => render());
      offs.push(onBus("status", () => { if (!busy) render(); }));
      offs.push(onBus("conn", () => render()));
      if (S.link && S.link.connected && S.link.authed) S.link.readStatus().catch(() => {});
    },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
