// Battery info page (vendor pages/batteryInfo, 电池信息): HV pack, cell voltages, DC-DC converter.
// The page sends D0 01 on enter, polls D0 02/03/04 for the open tab, and sends D0 00 when it stops.
// The factory-capacity override stays in this browser. Nothing goes to the module.
import { h, L, clear, dialog, toast, icon } from "../ui.js";
import { S, definePage, onBus, send, log } from "../app.js";
import {
  TYPE, BATTERY_TABS, BATTERY_START, BATTERY_STOP, BATTERY_FIRST_POLL_MS, batteryPoll, batteryPollMs,
  decodeBatteryPack, batteryPackView, resetCells, applyCellGroup, decodeDcdc, dcdcView,
} from "../../lib/tsl6-live.js";

function loadCss(name) {
  if (document.querySelector(`link[data-page-css="${name}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href: new URL(`./${name}.css`, import.meta.url).href, "data-page-css": name }));
}

// User factory capacity in kWh (vendor storage key "battFull"). 0 = use the module value.
const CAP_KEY = "tsl6.battFull";
function readCap() { try { const v = Number(JSON.parse(localStorage.getItem(CAP_KEY))); return v > 0 ? v : 0; } catch { return 0; } }
function writeCap(v) { try { if (v > 0) localStorage.setItem(CAP_KEY, JSON.stringify(v)); else localStorage.removeItem(CAP_KEY); } catch { /* storage blocked */ } }

// The module answers only after the BLE password.
const ready = () => !!(S.link && S.link.connected && (S.link.authed || (S.status && !S.blank)));

const TAB_EN = { pack: "HV battery", cells: "Cells", dcdc: "DC-DC" }; // short, so the three tabs fit one line

definePage("battery", () => {
  loadCss("battery");
  const el = h("div", { class: "page bat" });
  let tab = 0;
  let pack = null;            // last decoded D0 reply
  let dcdc = null;            // last dcdcView
  let cells = resetCells();
  let shown = false, started = false, timer = 0, wake = null;
  const offs = [];

  // ---------------------------------------------------------------- layout
  const segBtns = BATTERY_TABS.map((t, i) => h("button", { type: "button", onclick: () => selectTab(i) }, L(TAB_EN[t.id], t.zh)));
  const head = h("div", { class: "bat-head" });
  const list = h("div", { class: "bat-list" });
  // Pack tab: a summary card, then one card per group. Cells and DC-DC tabs: one card.
  const sum = h("div", { class: "bat-sum" });
  const groups = h("div", { class: "bat-groups" });
  const packWrap = h("div", null, h("div", { class: "card pad bat-sum-card" }, sum), groups);
  const card = h("div", { class: "bat-card" }, head, h("div", { class: "bat-rule" }), list);
  el.append(
    h("div", { class: "seg", role: "tablist" }, segBtns),
    packWrap, card,
    h("p", { class: "sec-foot" }, L("For reference only. The car maker's data is the authority.", "本数据仅供参考，以车企官方数据为准")),
  );

  // SI unit spelling on screen (the codec keeps the vendor text "KWH", "KW", "KM" for its vendor diff test).
  // Large numbers get a thousands separator; "℃" becomes "°C" (the Barlow font has no ℃ glyph).
  const units = t => String(t).replace(/ KWH\b/g, " kWh").replace(/ KW\b/g, " kW").replace(/ KM\b/g, " km")
    .replace(/\s*℃/g, " °C").replace(/(\d) %/g, "$1%").replace(/(^|[^.\d])(\d{4,})(?=[.\s]|$)/g, (m, p, d) => p + d.replace(/\B(?=(\d{3})+$)/g, ",")); // no lookbehind: older iOS
  // Pack tab groups (presentation only; every row of the module stays).
  const GROUP = {
    voltage: "pack", current: "pack", power: "pack", temp: "pack", heating: "pack",
    socCar: "energy", socReal: "energy", range: "energy", energyRemain: "energy", energyReserve: "energy", factoryCap: "energy",
    cellMax: "cells", cellMin: "cells", cellDelta: "cells",
    charged: "life", discharged: "life", odo: "life",
  };
  const GROUP_NAME = { pack: ["Pack", "电池包"], energy: ["Charge and range", "电量与里程"], cells: ["Cell voltage", "单体电压"], life: ["Lifetime", "累计"] };
  const ORDER = ["energy", "pack", "cells", "life"];

  // Value rows, keyed by id. Texts change in place so that a tap on the capacity value is not lost.
  let rowKey = null;
  const rowEls = new Map();
  function syncRows(rows, grouped = false) {
    const key = (grouped ? "g:" : "") + rows.map(r => r.id).join(",");
    if (key !== rowKey) {
      rowKey = key;
      rowEls.clear();
      clear(list); clear(groups);
      const empty = () => h("p", { class: "bat-empty" }, ready() ? L("Waiting for data", "等待数据") : L("Connect to the module first.", "请先连接蓝牙"));
      if (!rows.length) (grouped ? groups : list).append(grouped ? h("div", { class: "card pad" }, empty()) : empty());
      let g = null, box = list;
      for (const r of rows) {
        if (grouped && r.group !== g) {
          g = r.group; box = h("div", { class: "card bat-group" });
          groups.append(h("section", { class: "grp" }, h("div", { class: "sec-label" }, L(...GROUP_NAME[g])), box));
        }
        const txt = h("span");
        const val = r.tap
          ? h("button", { type: "button", class: "bat-val bat-link", onclick: editCap, "aria-label": r.label + ": " + L("change", "修改") }, txt, icon("chevron-right", 18))
          : h("span", { class: "bat-val" }, txt);
        const lab = h("span", { class: "bat-lab" });
        const e = h("div", { class: "bat-row" }, lab, val);
        rowEls.set(r.id, { e, lab, val, txt });
        box.append(e);
      }
    }
    for (const r of rows) {
      const x = rowEls.get(r.id);
      x.lab.textContent = r.label;
      x.txt.textContent = units(r.text);
      x.e.className = "bat-row" + (r.cls ? " " + r.cls : "");
    }
  }

  function packRows() {
    const v = batteryPackView(pack, readCap());
    if (v.error) return { odo: "0", rows: [] };
    const userCap = readCap() > 0;
    const rows = v.rows.map(r => {
      let text = r.text;
      if (r.id === "factoryCap" && text === "设置") text = L("Set", "设置");
      if (r.id === "heating") text = L(r.en, r.text);
      if (r.id === "factoryCap" && userCap) text += L(" (local)", "（本机）");
      return { id: r.id, label: L(r.label, r.zh), text, tap: r.tappable, cls: r.max ? "max" : r.min ? "min" : "", group: GROUP[r.id] };
    });
    rows.push({ id: "odo", label: L("Odometer", "总里程"), text: v.odometerText + " km", group: "life" });
    rows.sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group)); // stable: module order inside a group
    return { odo: v.odometerText, rows, view: v };
  }

  function render() {
    segBtns.forEach((b, i) => { b.classList.toggle("on", i === tab); b.setAttribute("aria-selected", String(i === tab)); });
    packWrap.hidden = tab !== 0; card.hidden = tab === 0;
    clear(head);
    if (tab === 0) {
      const v = pack ? packRows() : { odo: "0", rows: [] };
      // Summary: state of charge, range and pack power, rounded for reading at a glance.
      // The summary values leave the list, so that no value shows twice.
      const by = Object.fromEntries(v.rows.map(r => [r.id, r]));
      const num = id => (by[id] ? parseFloat(String(by[id].text).replace(/,/g, "")) : NaN);
      const socId = Number.isFinite(num("socReal")) ? "socReal" : "socCar";
      const stat = (id, unit, digits) => {
        const n = num(id);
        return h("div", { class: "bat-stat" },
          h("div", { class: "bat-stat-v" }, Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—", h("small", { class: unit === "%" ? "pct" : null }, unit)),
          h("div", { class: "bat-stat-l" }, by[id] ? by[id].label : ""));
      };
      clear(sum).append(stat(socId, "%", 1), stat("range", "km", 0), stat("power", "kW", 2));
      syncRows(v.rows.filter(r => ![socId, "range", "power"].includes(r.id)), true);
    } else if (tab === 1) {
      head.className = "bat-head center";
      const i = cells.reading;
      head.append(h("span", { class: i >= 0 ? "" : "muted" },
        i >= 0 ? L(`Reading cells ${i + 1} - ${i + 3}`, `正在读取 Cell ${i + 1} - ${i + 3}`) : L("Waiting for data", "等待读取")));
      renderCells();
    } else {
      head.className = "bat-head center";
      head.append(h("span", null, L("Vehicle DC-DC step-down converter data", "车辆DCDC降压模块数据")));
      syncRows(dcdc ? dcdc.rows.map(r => ({ id: r.id, label: L(r.label, r.zh), text: r.text })) : []);
    }
  }

  function renderCells() {
    rowKey = null;
    rowEls.clear();
    clear(list);
    const stat = (cls, en, zh, text) => h("div", { class: "bat-row strong " + cls }, h("span", null, L(en, zh)), h("span", null, text));
    list.append(
      stat("max", "Highest", "最高", cells.maxText + " V"),
      stat("min", "Lowest", "最低", cells.minText + " V"),
      stat("avg", "Average", "平均", cells.avgText + " V"),
      stat("delta", "Difference", "压差", cells.deltaText + " mV"),
    );
    const grid = h("div", { class: "bat-cells" });
    cells.cells.forEach(c => {                      // sparse array: forEach skips the holes
      grid.append(h("div", { class: "bat-cell" + (c.max ? " max" : c.min ? " min" : "") },
        h("span", { class: "bat-cell-n" }, "Cell " + c.cell), h("span", { class: "bat-cell-v" }, c.text)));
    });
    if (grid.firstChild) list.append(h("div", { class: "bat-rule" }), grid);
  }

  function selectTab(i) {
    if (i === tab) { cells = resetCells(); render(); return; } // the vendor resets the cell data on every tab tap
    tab = i;
    cells = resetCells();
    render();
  }

  // ---------------------------------------------------------------- factory capacity (local only)
  async function editCap() {
    const cur = readCap();
    const inp = h("input", { class: "dlg-input", type: "text", inputmode: "decimal", value: cur > 0 ? String(cur) : "", placeholder: "60.5", autocomplete: "off" });
    const body = h("div", null,
      h("p", { class: "dlg-text" }, L("Enter the battery factory capacity in kWh, for example 60.5.", "请输入电池出厂容量(单位KWH)\n例如:60.5")),
      inp,
      h("p", { class: "dlg-text bat-dlg-note" }, L("This browser keeps the value. The module does not get it. Reset shows the module value again.",
        "此数值仅保存在本浏览器，不会写入模块。恢复默认后显示模块数值。")));
    const p = dialog({
      title: L("Factory capacity", "出厂容量"), body,
      buttons: [{ label: L("Cancel", "取消"), value: null }, { label: L("Reset", "恢复默认"), value: "reset" }, { label: L("OK", "确定"), value: "ok", kind: "primary" }],
    });
    inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.closest(".dlg").querySelector(".dlg-btn.primary").click(); });
    setTimeout(() => inp.focus(), 30);
    const v = await p;
    if (v === "reset") { writeCap(0); toast(L("Module value restored", "已恢复模块数值"), "ok"); }
    else if (v === "ok") {
      const s = inp.value.trim();
      const n = Number(s);
      if (s === "") writeCap(0);
      else if (!Number.isFinite(n)) { toast(L("A number is required", "必须输入数字"), "bad"); return; }
      else if (n <= 0 || n > 500) { toast(L("Enter a value from 0.1 to 500", "请输入0.1到500之间的数值"), "bad"); return; }
      else writeCap(n);
    } else return;
    render();
  }

  // ---------------------------------------------------------------- stream control
  const active = () => shown && !document.hidden;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function tick() {
    timer = 0;
    if (!active() || !ready()) return;            // the status and conn events start it again
    if (!started) {
      started = true;
      send(TYPE.BATTERY, BATTERY_START, { read: true, quiet: true }).then(ok => { if (!ok) started = false; });
      schedule(BATTERY_FIRST_POLL_MS);
      return;
    }
    send(TYPE.BATTERY, batteryPoll(tab), { read: true, quiet: true });
    schedule(batteryPollMs(tab));
  }
  function kick() { if (!timer) tick(); }
  function stop() {
    clearTimeout(timer); timer = 0;
    if (started && S.link && S.link.connected) send(TYPE.BATTERY, BATTERY_STOP, { read: true, quiet: true });
    started = false;
  }

  // Keep the screen on while the page shows (the vendor does the same).
  async function keepAwake(on) {
    try {
      if (on && !wake && navigator.wakeLock && !document.hidden) {
        const w = await navigator.wakeLock.request("screen");
        if (!shown) { w.release(); return; }
        wake = w; w.addEventListener("release", () => { if (wake === w) wake = null; });
      } else if (!on && wake) { const w = wake; wake = null; await w.release(); }
    } catch { /* not supported or not allowed */ }
  }

  function onVis() {
    if (document.hidden) stop();
    else { keepAwake(true); kick(); }
  }

  function onFrame(fr) {
    if (fr.cmd === TYPE.BATTERY) {
      const d = decodeBatteryPack(fr.payload);
      if (d.error) { if (fr.payload.length > 1) log(`battery: ${d.error}`, "warn"); return; }
      pack = d;
      if (tab === 0) render();
    } else if (fr.cmd === TYPE.BATTERY_CELLS) {
      if (tab !== 1) return;                       // the vendor builds the cell list only on the cell tab
      const r = applyCellGroup(cells, fr.payload);
      if (r.error) { log(`battery: ${r.error}`, "warn"); return; }
      render();
    } else if (fr.cmd === TYPE.BATTERY_DCDC) {
      const d = decodeDcdc(fr.payload);
      if (d.error) { log(`battery: ${d.error}`, "warn"); return; }
      dcdc = dcdcView(d);
      if (tab === 2) render();
    }
  }

  render();
  return {
    el,
    title: { en: "Battery info", zh: "电池信息" },
    enter() {
      shown = true;
      offs.push(onBus("frame", onFrame));
      offs.push(onBus("status", kick));
      offs.push(onBus("conn", st => {
        if (!st.connected) { clearTimeout(timer); timer = 0; started = false; }
        rowKey = null; render();
        if (st.connected) kick();
      }));
      document.addEventListener("visibilitychange", onVis);
      keepAwake(true);
      kick();
    },
    leave() {
      shown = false;
      stop();
      offs.splice(0).forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
      keepAwake(false);
    },
    refresh() { render(); },
  };
});
