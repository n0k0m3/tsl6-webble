// Settings tab (vendor pages/set): every settings row, grouped by topic. A tap opens an option sheet with the
// help text above the options. Each change writes one A3 at once (same logic as before the redesign).
import { h, L, btn, toast, confirmBox, showHelp, clear, icon, chooseOption, toggle, plainLabel } from "../ui.js";
import { S, definePage, onBus, ask, savePref, log, connect, askPassword } from "../app.js";
import { BY_ID, decodeSettings, encodeSettings, optionsFor, appliesTo, writeBlocker, settingsEchoMatches } from "../../lib/tsl6-settings.js";

let ZH = null;
async function zhLabels() {
  if (!ZH) { try { ZH = await (await fetch(new URL("../../data/settings-zh.json", import.meta.url))).json(); } catch { ZH = {}; } }
  return ZH;
}

// Topic groups. [id, subId] = a row and its sub-setting (the vendor "..." picker), shown as an indented row.
const GROUPS = [
  { en: "Autopilot", zh: "Autopilot", rows: [["apAutoOpenType", "apAutoOpenTime"], ["oneClickOpenAP"], ["APSpeedExit"], ["fsd"]] },
  { en: "AP assist (no-nag)", zh: "AP辅助（免打扰）",
    rows: [["automdr"], ["ModeMDR"], ["lr"], ["time"], ["rand"], ["enable_save"], ["jg"], ["jj"], ["dblclickMDR"]] },
  { en: "Lights", zh: "灯光", rows: [["dynamicBrakeLight"], ["apHighBeam"], ["blinkHighBeam"], ["pluseHighBeam", "pluseHighBeamAndLowBeam"],
    ["pluseFrontFogLight"], ["pluseRearFogLight"], ["turnLightPriority"], ["openDoorHazardLight"], ["backHazardLight"]] },
  { en: "Horn", zh: "喇叭", rows: [["gentryHorn", "gentryHornCount"], ["pluseHorn", "longPluseHorn"], ["hornLinkedHighBeam"], ["highBeamLinkedHorn"]] },
  { en: "Driving", zh: "驾驶", rows: [["KERS"], ["stoppingMode"], ["autoSportMode"], ["autoParkBrake"], ["OffAPAutoWiper"]] },
  { en: "Doors and charging", zh: "车门与充电", rows: [["frontRightEasyAccess"], ["TimeOpenFrontBox"], ["TimeOpenChargeDoor"]] },
  { en: "Module", zh: "模块", rows: [["beep"], ["led"], ["BLEPWR"]] },
];
const LAB = ["airAutoArid", "backHazardRearFogLight", "steerAssistanceLighting"]; // the seat-belt rows need vendor admin: not shown
// The vendor opens the help text after these change to a value > 0.
const HELP_ON_SET = new Set(["apAutoOpenType", "stoppingMode", "steerAssistanceLighting", "backHazardRearFogLight"]);

definePage("settings", () => {
  const el = h("div", { class: "page", "data-page": "settings" });
  let busy = false;
  // Search: the field lives across renders, so typing is not lost when a status frame comes in.
  let query = "";
  const searchInput = h("input", { type: "search", placeholder: L("Search settings", "搜索设置"), "aria-label": L("Search settings", "搜索设置"), "data-id": "set-search",
    autocomplete: "off", enterkeyhint: "search" });
  searchInput.addEventListener("input", () => { query = searchInput.value.trim().toLowerCase(); render(); });
  const searchBox = h("div", { class: "set-search span" }, icon("search", 18), searchInput);
  const matches = id => !query || L(label(id)).toLowerCase().includes(query);

  const label = id => ({ en: BY_ID[id].label, zh: ZH && ZH[id] ? ZH[id].zh : null });
  function options(id, vals) {
    const en = optionsFor(BY_ID[id], vals, S.hwType);
    let zh = ZH && ZH[id] && ZH[id].options;
    if (id === "lr" && [6, 8, 19].includes(S.hwType) && ZH) zh = ZH._lr68.options;
    if (id === "time" && ZH) zh = (vals.rand === 0 ? ZH._timeFixed : ZH._timeRand).options;
    return en.map(([v, t]) => [v, L(t, zh && zh[v])]);
  }
  // Rows show the value without "(default)"; the sheet still marks the default option.
  const valueText = (id, vals) => {
    const o = options(id, vals).find(([v]) => v === vals[id]);
    return o ? o[1].replace(/\s*\((default)\)|\s*[（(]默认[)）]/g, "") : `? (${vals[id]})`;
  };
  // True when the value differs from the factory default (the English option list marks the default).
  const changed = (id, vals) => {
    const o = optionsFor(BY_ID[id], vals, S.hwType).find(([v]) => v === vals[id]);
    return !!o && !/\(default\)/.test(o[1]) && optionsFor(BY_ID[id], vals, S.hwType).some(([, t]) => /\(default\)/.test(t));
  };

  async function save(id, raw) {
    if (busy) return;
    const base = S.status;
    if (!base || S.blank) { toast(L("Enter the BLE password first.", "请先输入蓝牙密码"), "warn"); return; }
    let payload;
    try { payload = encodeSettings(base, { [id]: raw }, S.hwType, id); } catch (e) { toast(e.message, "bad", 3000); return; }
    const why = writeBlocker(payload);
    if (why) { toast(why, "bad", 4000); return; }
    busy = true; render();
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

  async function pick(id, vals, help) {
    const v = await chooseOption({ title: L(label(id)), options: options(id, vals), value: vals[id], help });
    if (v == null || v === vals[id]) return;
    setTimeout(() => save(id, Number(v)), 0); // run the save after the sheet is gone
  }

  // A setting with exactly the options "Off" and "On" shows a switch. Returns [offValue, onValue] or null.
  function onOff(id, vals) {
    const o = optionsFor(BY_ID[id], vals, S.hwType);
    if (o.length !== 2) return null;
    const off = o.find(([, t]) => plainLabel(t) === "Off"), on = o.find(([, t]) => plainLabel(t) === "On");
    return off && on ? [off[0], on[0]] : null;
  }

  function item(id, vals, { sub = false, first = false } = {}) {
    const f = BY_ID[id];
    if (!f || !appliesTo(f, S.hwType) || vals[id] === undefined) return null;
    const bin = onOff(id, vals);
    if (bin) {
      // The switch writes at once. The name opens the help text (sub-rows have none).
      const sw = toggle({ checked: vals[id] === bin[1], disabled: busy, label: L(label(id)), onchange: v => save(id, v ? bin[1] : bin[0]) });
      sw.dataset.id = `set-${id}`;
      const name = h("div", { class: "li-title" }, h("span", null, L(label(id))), changed(id, vals) ? h("span", { class: "legend-dot", role: "img", "aria-label": L("Changed from default", "已改动") }) : null);
      return h("div", { class: "li" + (sub ? " sub" : "") + (first ? " first" : ""), "data-row": id },
        sub ? h("div", { class: "li-text" }, name)
          : h("button", { class: "li-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + L(label(id)), onclick: () => showHelp("help_" + id, L(label(id))) }, name),
        sw);
    }
    return h("button", {
      class: "li" + (sub ? " sub" : "") + (first ? " first" : ""), type: "button", "data-id": `set-${id}`, disabled: busy,
      onclick: () => pick(id, vals, sub ? null : "help_" + id),
    },
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(label(id))),
      changed(id, vals) ? h("span", { class: "legend-dot", role: "img", "aria-label": L("Changed from default", "已改动") }) : null)),
    h("div", { class: "li-trail" }, h("span", { class: "val" + (changed(id, vals) ? " changed" : "") }, valueText(id, vals)), h("span", { class: "chev" }, icon("chevron-right", 18))));
  }

  function group(title, rows, vals, foot) {
    const items = [];
    for (const [id, subId] of rows) {
      if (!matches(id) && !(subId && matches(subId))) continue;
      const it = item(id, vals);
      if (!it) continue;
      items.push(it);
      if (subId) { const s = item(subId, vals, { sub: true }); if (s) items.push(s); }
    }
    if (!items.length) return [];
    return [h("section", { class: "grp" }, h("div", { class: "sec-label" }, L(title)), h("div", { class: "card" }, items), foot ? h("p", { class: "sec-foot" }, L(foot)) : null)];
  }

  function render() {
    const hadFocus = document.activeElement === searchInput;
    clear(el);
    const link = S.link, p = S.status;
    el.className = "page" + (link && link.connected && p && !S.blank ? " cols" : " narrow");
    if (!link || !link.connected || !p || S.blank) {
      const on = link && link.connected;
      el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip" + (on ? " amber" : " blue") }, icon(on ? "key-round" : "bluetooth", 24)),
        h("h2", null, on ? L("Enter the BLE password", "请输入蓝牙密码") : L("Not connected", "未连接")),
        h("p", null, on ? L("The module sends its settings after it accepts the password.", "模块验证密码后才会发送设置。")
          : L("Connect to the module to read and change its settings.", "连接模块后即可读取和修改设置。")),
        on ? h("button", { class: "btn primary", type: "button", onclick: () => askPassword("manual") }, L("Enter password", "输入密码"))
          : h("button", { class: "btn primary", type: "button", "data-id": "connect", onclick: () => connect() }, L("Connect", "连接")))));
      return;
    }
    const vals = decodeSettings(p);
    const moduleOff = vals.mianSwitch === 1;

    // Master switch first. While the module is off, the vendor app hides every other row.
    el.append(h("div", { class: "card lead master span" }, (() => {
      const f = "mianSwitch";
      return h("button", { class: "li first", type: "button", "data-id": "set-mianSwitch", disabled: busy, onclick: () => pick(f, vals, "help_mianSwitch") },
        h("span", { class: "chip" + (moduleOff ? "" : " on") }, icon("power", 24)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Master switch", ZH && ZH[f] ? ZH[f].zh : "总开关"))),
          h("div", { class: "li-sub" }, moduleOff ? L("All functions are off", "所有功能已停用") : L("All functions are active", "所有功能已启用"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, valueText(f, vals)), h("span", { class: "chev" }, icon("chevron-right", 18))));
    })()));
    if (moduleOff) {
      el.append(h("p", { class: "sec-foot span" }, L("The module is off. Turn it on to see the other settings.", "模块已停用。启用后可查看其他设置。")));
      return;
    }
    // The legend shows only when a row carries the changed dot.
    const shownIds = [...GROUPS.flatMap(g => g.rows.flat().filter(Boolean)), ...(S.prefs.lab ? LAB : [])];
    const anyChanged = shownIds.some(id => BY_ID[id] && vals[id] !== undefined && appliesTo(BY_ID[id], S.hwType) && changed(id, vals));
    el.insertBefore(searchBox, el.firstChild);
    if (hadFocus) searchInput.focus();
    const groupsBefore = el.childElementCount;
    for (const g of GROUPS) el.append(...group(g, g.rows, vals, g.foot));
    const firstHead = el.querySelector(".grp .sec-label");
    if (anyChanged && firstHead) firstHead.append(h("span", { class: "sec-side legend" }, h("span", { class: "legend-dot", "aria-hidden": "true" }), L("Changed", "已改动")));
    if (query) {
      if (el.childElementCount === groupsBefore) el.append(h("p", { class: "set-none span" }, L("No setting matches.", "没有匹配的设置。")));
      return;
    }

    // Lab: a local switch. The vendor app asks for a code from its server here.
    const labItem = h("button", { class: "li first", type: "button", "data-id": "set-lab", onclick: async () => {
      const v = await chooseOption({ title: L("Lab functions", "实验室功能"), help: "help_test", value: S.prefs.lab ? 1 : 0,
        options: [[0, L("Off (default)", "关闭(默认)")], [1, L("On", "开启")]] });
      if (v == null || (v === 1) === S.prefs.lab) return;
      if (v === 1 && !(await confirmBox({
        en: "Lab functions may be unstable. Use them with care. (The vendor app asks for a code from its server here. This app has no server, so it asks only for this confirmation.)",
        zh: "实验室功能谨慎使用(可能不稳定)。原厂小程序需输入服务器提供的实验码，本应用无服务器，仅需确认。",
      }))) return;
      savePref("lab", v === 1); render();
    } },
    h("span", { class: "chip" + (S.prefs.lab ? " amber" : "") }, icon("activity", 22)),
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Lab functions", "实验室功能"))),
      h("div", { class: "li-sub" }, L("Experimental rows", "实验功能"))),
    h("div", { class: "li-trail" }, h("span", { class: "val" }, S.prefs.lab ? L("On", "开启") : L("Off", "关闭")), h("span", { class: "chev" }, icon("chevron-right", 18))));
    const labRows = S.prefs.lab ? LAB.map(id => item(id, vals)).filter(Boolean) : [];
    el.append(h("section", { class: "grp" }, h("div", { class: "sec-label" }, L("Lab", "实验室")), h("div", { class: "card" }, labItem, labRows)));
    el.append(h("p", { class: "foot span" }, L("Each change saves to the module at once.", "每项修改会立即保存到模块。")));
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
