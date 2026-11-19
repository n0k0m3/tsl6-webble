// Settings tab (vendor pages/set): every settings row, grouped by topic. A tap opens an option sheet with the
// help text above the options. Each change writes one A3 at once (same logic as before the redesign).
import { h, L, toast, confirmBox, showHelp, icon, chooseOption, toggle, plainLabel, groupHelpButton, extendHelp } from "../ui.js";
import { S, definePage, onBus, ask, savePref, log, connect, askPassword, isH2, go } from "../app.js";
import { h2Options, h2Has } from "../../lib/h2-menus.js";
import { BY_ID, decodeSettings, encodeSettings, optionsFor, appliesTo, writeBlocker, settingsEchoMatches, TIME_PROMPT_ZH } from "../../lib/tsl6-settings.js";

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
// App extras beyond the vendor menus: Scroll interval "On hands-on prompt" (prompt build, see the Firmware page).
const EXTRA = { promptBuild: true };
// Help for the prompt options, after the vendor text of "Scroll interval". Same span format as data/help.json.
const PROMPT_HELP = {
  en: [
    [[["", "When set to "], ["g", "On hands-on prompt"], ["", " (needs the prompt build: Tools → Firmware):"]],
      [["", "When AP assist is "], ["o", "on"], ["", ", the module scrolls the wheel -1 and +1 only when the car shows the hands-on prompt."]],
      [["", "It waits about the time in the option (random, +/-50 %). Then it sends one pair, and nothing more until the prompt goes away."]],
      [["", "Prompt build v2: if the nag goes on to the chime, it sends one more pair at each new level."]],
      [["", "The gap between -1 and +1 is the "], ["g", "Up/down tick gap"], ["", " +/-50 %, random."]],
      [["", "The Car tab shows the live state while it is open."]]],
    [[["", "Note: with the normal firmware, these options scroll every 2-3 s (about 0.6 s) or every 35-65 s (the others). The vendor Mini App does not know them: if you save settings there, it sets every 2-3 s."]]],
  ],
  zh: [
    [[["", "设置为"], ["g", "手扶提示时"], ["", "（需要提示版固件：工具 → 固件）："]],
      [["", "当"], ["o", "开启"], ["", "AP辅助后，只有车机显示手扶方向盘提示时，模块才操作滚轮减1加1。"]],
      [["", "它等待选项中的时间（随机±50%），然后操作一次减加，提示消失前不再操作。"]],
      [["", "提示版 v2：如果提示升级为提示音，每升一级再操作一次减加。"]],
      [["", "减1与加1之间的间隔为"], ["g", "加减时间间隔"], ["", "±50%随机。"]],
      [["", "车辆页打开时显示实时状态。"]]],
    [[["", "注：普通固件下，这些选项为每2-3秒（约0.6秒）或每35-65秒（其他）。厂家小程序不认识这些选项：在小程序里保存设置会改为每2-3秒。"]]],
  ],
};
extendHelp(H => {
  const base = H.help_time || { en: [], zh: [] };
  H.help_time = { en: [...(base.en || []), ...PROMPT_HELP.en], zh: [...(base.zh || []), ...PROMPT_HELP.zh] };
});
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
  const searchBox = h("div", { class: "set-search" }, icon("search", 18), searchInput);
  // The top row stays in the page across renders: a detached input ends IME (pinyin) composition and can close the iPhone keyboard.
  const legendSlot = h("span", { class: "slot" });
  const findBox = h("div", { class: "set-find" }, searchBox, legendSlot);
  const masterSlot = h("div", { class: "slot" });
  const topRow = h("div", { class: "set-top span" }, findBox, masterSlot);
  let picking = false;   // one option sheet at a time (the first open waits for help.json)
  // Case-insensitive; matches the English and the Chinese name, so either language finds a row.
  const hit = (...names) => names.some(n => n && String(n).toLowerCase().includes(query));
  const matches = id => !query || hit(label(id).en, label(id).zh);

  // Display names that differ from the codec label (the Car tab uses "AP resume" for the live switch).
  const EN_NAME = { apAutoOpenType: "AP resume mode" };
  const label = id => ({ en: EN_NAME[id] || BY_ID[id].label, zh: ZH && ZH[id] ? ZH[id].zh : null });
  function options(id, vals) {
    // The H2 board has its own menus, with their own Chinese text (lib/h2-menus.js).
    if (isH2()) return h2Options(id, vals[id], vals).map(([v, en, zh]) => [v, L(en, zh)]);
    const en = optionsFor(BY_ID[id], vals, S.hwType, EXTRA);
    let zh = ZH && ZH[id] && ZH[id].options;
    if (id === "lr" && [6, 8, 19].includes(S.hwType) && ZH) zh = ZH._lr68.options;
    if (id === "time" && ZH) zh = { ...TIME_PROMPT_ZH, ...(vals.rand === 0 ? ZH._timeFixed : ZH._timeRand).options };
    return en.map(([v, t]) => [v, L(t, zh && zh[v])]);
  }
  // Rows show the value without "(default)"; the sheet still marks the default option.
  const valueText = (id, vals) => {
    const o = options(id, vals).find(([v]) => v === vals[id]);
    return o ? plainLabel(o[1]) : `? (${vals[id]})`;
  };
  // True when the value differs from the factory default (the English option list marks the default).
  const changed = (id, vals) => {
    const o = optionsFor(BY_ID[id], vals, S.hwType, EXTRA).find(([v]) => v === vals[id]);
    return !!o && !/\(default\)/.test(o[1]) && optionsFor(BY_ID[id], vals, S.hwType, EXTRA).some(([, t]) => /\(default\)/.test(t));
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
    if (picking) return;
    picking = true;
    let v;
    // The help texts describe the TSL6. They are not shown for the H2 board.
    try { v = await chooseOption({ title: L(label(id)), options: options(id, vals), value: vals[id], help: isH2() ? null : help }); } finally { picking = false; }
    if (v == null || v === vals[id]) return;
    setTimeout(() => save(id, Number(v)), 0); // run the save after the sheet is gone
  }

  // A setting with exactly the options "Off" and "On" shows a switch. Returns [offValue, onValue] or null.
  function onOff(id, vals) {
    const o = optionsFor(BY_ID[id], vals, S.hwType, EXTRA);
    if (o.length !== 2) return null;
    const off = o.find(([, t]) => plainLabel(t) === "Off"), on = o.find(([, t]) => plainLabel(t) === "On");
    return off && on ? [off[0], on[0]] : null;
  }

  function item(id, vals, { sub = false, off = false } = {}) {
    const f = BY_ID[id];
    if (!f || !appliesTo(f, S.hwType) || vals[id] === undefined) return null;
    const bin = onOff(id, vals);
    if (bin) {
      // The switch writes at once. The name opens the help text (sub-rows have none).
      const sw = toggle({ checked: vals[id] === bin[1], disabled: busy, label: L(label(id)), onchange: v => save(id, v ? bin[1] : bin[0]) });
      sw.dataset.id = `set-${id}`;
      const name = h("div", { class: "li-title" }, h("span", null, L(label(id))), changed(id, vals) ? h("span", { class: "legend-dot", role: "img", "aria-label": L("Changed from default", "已改动") }) : null);
      return h("div", { class: "li" + (sub ? " sub" : "") + (off ? " off" : ""), "data-row": id },
        sub ? h("div", { class: "li-text" }, name)
          : h("button", { class: "li-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + L(label(id)), onclick: () => showHelp("help_" + id, L(label(id))) }, name),
        sw);
    }
    return h("button", {
      class: "li" + (sub ? " sub" : "") + (off ? " off" : ""), type: "button", "data-id": `set-${id}`, disabled: busy,
      onclick: () => pick(id, vals, sub ? null : "help_" + id),
    },
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(label(id))),
      changed(id, vals) ? h("span", { class: "legend-dot", role: "img", "aria-label": L("Changed from default", "已改动") }) : null)),
    h("div", { class: "li-trail" }, h("span", { class: "val" + (changed(id, vals) ? " changed" : "") }, valueText(id, vals)), h("span", { class: "chev" }, icon("chevron-right", 18))));
  }

  function group(title, rows, vals, foot) {
    const items = [];
    const groupHit = !!query && hit(title.en, title.zh); // a group title match shows the whole group
    for (const [id, subId] of rows) {
      if (!groupHit && !matches(id) && !(subId && matches(subId))) continue;
      const it = item(id, vals);
      if (!it) continue;
      items.push(it);
      // A sub-row stays visible (search finds it) but looks quiet while its parent is Off.
      const parentOff = (() => { const o = optionsFor(BY_ID[id], vals, S.hwType, EXTRA).find(([v]) => v === vals[id]); return !!o && plainLabel(o[1]) === "Off"; })();
      if (subId) { const s = item(subId, vals, { sub: true, off: parentOff }); if (s) items.push(s); }
    }
    if (!items.length) return [];
    const help = isH2() ? null : groupHelpButton(title, rows.map(r => r[0]).filter(id => BY_ID[id] && appliesTo(BY_ID[id], S.hwType) && vals[id] !== undefined).map(id => [L(label(id)), "help_" + id]));
    return [h("section", { class: "grp" }, h("div", { class: "sec-label" }, h("span", { class: "sec-title" }, h("span", null, L(title)), help)),
      h("div", { class: "card" }, items), foot ? h("p", { class: "sec-foot" }, L(foot)) : null)];
  }

  function render() {
    for (const c of [...el.children]) if (c !== topRow) c.remove();
    const link = S.link, p = S.status;
    el.className = "page" + (link && link.connected && p && !S.blank ? " cols" : " narrow");
    if (!link || !link.connected || !p || S.blank) {
      topRow.remove();
      const on = link && link.connected;
      // Connected, no status yet: the module has not answered. A blank status means "password needed".
      if (on && !p) {
        el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
          h("span", { class: "chip blue" }, icon("refresh-cw", 24)),
          h("h2", null, L("Waiting for the module", "等待模块应答")),
          h("p", null, L("The module has not sent its settings yet.", "模块尚未发送设置。")),
          h("div", { class: "es-btns" },
            h("button", { class: "btn primary", type: "button", onclick: () => link.readStatus().catch(() => {}) }, L("Read again", "重新读取")),
            link.authed ? null : h("button", { class: "btn", type: "button", onclick: () => askPassword("manual") }, L("Enter password", "输入密码"))))));
        return;
      }
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
    const master = h("div", { class: "card lead master" }, (() => {
      const f = "mianSwitch";
      return h("button", { class: "li first", type: "button", "data-id": "set-mianSwitch", disabled: busy, onclick: () => pick(f, vals, "help_mianSwitch") },
        h("span", { class: "chip" + (moduleOff ? "" : " on") }, icon("power", 24)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Master switch", ZH && ZH[f] ? ZH[f].zh : "总开关"))),
          h("div", { class: "li-sub" }, moduleOff ? L("All functions are off", "所有功能已停用") : L("All functions are active", "所有功能已启用"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, valueText(f, vals)), h("span", { class: "chev" }, icon("chevron-right", 18))));
    })());
    if (topRow.parentNode !== el) el.prepend(topRow);
    // The H2 board has no master switch. Its op mode (Active or Listen-Only) is on the Board page, with a confirm.
    const B = isH2() ? S.link.board : null;
    const opCard = B && B.status ? h("div", { class: "card lead master" },
      h("button", { class: "li first", type: "button", "data-id": "set-opmode", onclick: () => go("board") },
        h("span", { class: "chip" + (B.status.opMode === 1 ? " on" : "") }, icon("radio", 24)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Op mode", "运行模式"))),
          h("div", { class: "li-sub" }, B.status.opMode === 1 ? L("The board sends scroll ticks on Vehicle CAN", "模块向车辆CAN发送滚轮操作") : L("The board never sends", "模块从不发送"))),
        h("div", { class: "li-trail" }, h("span", { class: "val" }, B.status.opMode === 1 ? L("Active", "主动") : L("Listen-Only", "只听")), h("span", { class: "chev" }, icon("chevron-right", 18))))) : null;
    masterSlot.replaceChildren(opCard || master);
    findBox.hidden = moduleOff;
    if (moduleOff) {
      el.append(h("p", { class: "sec-foot span" }, L("The module is off. Turn it on to see the other settings.", "模块已停用。启用后可查看其他设置。")));
      return;
    }
    // The legend shows only when a row carries the changed dot.
    const shownIds = [...GROUPS.flatMap(g => g.rows.flat().filter(Boolean)), ...(S.prefs.lab ? LAB : [])];
    const anyChanged = shownIds.some(id => BY_ID[id] && vals[id] !== undefined && appliesTo(BY_ID[id], S.hwType) && changed(id, vals));
    // Top row: search (with the legend) and the master switch; one row on desktop, stacked on a phone.
    legendSlot.replaceChildren(...(anyChanged ? [h("span", { class: "legend" }, h("span", { class: "legend-dot", "aria-hidden": "true" }), L("Changed from default", "已改动的设置"))] : []));
    const groupsBefore = el.childElementCount;
    // A board with the "rand" row uses the exact timer interval when that row is Off.
    const exactNote = h2Has("rand") ? { en: " (exact when Random interval is Off)", zh: "（滚轮随机时间关闭时为精确值）" } : { en: "", zh: "" };
    const H2_FOOT = { en: `The board draws each time at random: delay and gap +/- 50 %, timer interval +/- 20 %${exactNote.en}. Exact values: Tools > Board.`, zh: `模块的每个时间都是随机的：延时和间隔±50%，定时间隔±20%${exactNote.zh}。精确值：工具 > 模块。` };
    for (const g of GROUPS) el.append(...group(g, g.rows, vals, isH2() ? H2_FOOT : g.foot));
    if (query) {
      if (S.prefs.lab) el.append(...group({ en: "Lab", zh: "实验室" }, LAB.map(id => [id]), vals)); // search finds Lab rows too
      if (el.childElementCount === groupsBefore) el.append(h("p", { class: "set-none span" }, L("No setting matches.", "没有匹配的设置。")));
      return;
    }

    if (isH2()) { // no Lab rows for the board
      el.append(h("p", { class: "foot span" }, L("Each change saves to the board at once.", "每项修改会立即保存到模块。")));
      return;
    }
    // Lab: a local switch. The vendor app asks for a code from its server here.
    const labItem = h("button", { class: "li first", type: "button", "data-id": "set-lab", onclick: async () => {
      if (picking) return;
      picking = true;
      let v;
      try {
        v = await chooseOption({ title: L("Lab functions", "实验室功能"), help: "help_test", value: S.prefs.lab ? 1 : 0,
          options: [[0, L("Off (default)", "关闭(默认)")], [1, L("On", "开启")]] });
      } finally { picking = false; }
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
      if (S.link && S.link.connected && S.link.authed) Promise.resolve(S.link.readStatus()).catch(() => {});
    },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
