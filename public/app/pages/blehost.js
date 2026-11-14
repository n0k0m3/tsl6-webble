// BLE host pairing page (vendor pages/bleHost, 蓝牙配对). The module scans for BLE devices (for example
// BLE buttons) and pairs them. Enter: F0 scan start, then the paired list every 1 s. Leave: F0 scan stop.
import { h, L, clear, icon, toast } from "../ui.js";
import { S, definePage, onBus, send } from "../app.js";
import {
  TYPE, uid14FromStatus, bleHostScanStart, bleHostScanStop, bleHostList, bleHostPair, bleHostDelete,
  createBleHostState, applyBleHost, macDisplay, rssiBars,
} from "../../lib/tsl6-live.js";

function loadCss(name) {
  if (document.querySelector(`link[data-page-css="${name}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href: new URL(`./${name}.css`, import.meta.url).href, "data-page-css": name }));
}
const ready = () => !!(S.link && S.link.connected && (S.link.authed || (S.status && !S.blank)));
const uid = () => uid14FromStatus(S.status || (S.link && S.link.status) || new Uint8Array(0));
const FIRST_LIST_MS = 200, LIST_MS = 1000;

definePage("blehost", () => {
  loadCss("blehost");
  const el = h("div", { class: "page bh" });
  const st = createBleHostState();
  let shown = false, started = false, timer = 0;
  const offs = [];

  // ---------------------------------------------------------------- layout
  const pairedCard = h("div", { class: "bh-card" });
  const foundCard = h("div", { class: "bh-card" });
  const findBtn = h("button", { type: "button", class: "btn small bh-find", onclick: toggleScan });
  el.append(
    h("div", { class: "bh-label" }, L("Paired devices", "已配对设备")),
    pairedCard,
    h("div", { class: "bh-label bh-label-row" }, h("span", null, L("Nearby devices", "附近设备")), findBtn),
    foundCard,
  );

  function bars(rssi) {
    const lit = rssiBars(rssi);
    return h("span", { class: "bh-sig", title: rssi + " dBm" },
      h("span", { class: "bh-bars", "aria-hidden": "true" }, [0, 1, 2, 3, 4, 5].map(i => h("i", { class: i < lit ? "on" : "" }))),
      h("span", { class: "bh-dbm" }, rssi + "dbm"));
  }

  // Keyed list: a row element stays while its MAC stays. Only its texts change, so a tap is not lost on a redraw.
  const pairedRows = new Map(), foundRows = new Map();
  function syncList(card, rows, entries, make) {
    const keep = new Set(entries.map(([mac]) => mac));
    for (const [mac, r] of rows) if (!keep.has(mac)) { r.el.remove(); rows.delete(mac); }
    const empty = card.querySelector(".bh-empty");
    if (!entries.length) { if (!empty) card.append(h("p", { class: "bh-empty" }, L("The list is empty", "列表为空"))); return; }
    if (empty) empty.remove();
    let prev = null;
    for (const [mac, d] of entries) {
      let r = rows.get(mac);
      if (!r) { r = make(mac); rows.set(mac, r); }
      r.update(d);
      const at = prev ? prev.nextSibling : card.firstChild;
      if (at !== r.el) card.insertBefore(r.el, at);
      prev = r.el;
    }
  }

  // Row parts that change: name, MAC line, and the right side (battery, signal). They take no pointer events.
  function rowParts(mac) {
    const name = h("div", { class: "bh-name" });
    const sub = h("div", { class: "bh-mac" });
    const dyn = h("span", { class: "bh-dyn" });
    let sig = "";
    const update = (d, withConn) => {
      const s = JSON.stringify([d.name, d.rssi, d.battery, d.connected, withConn]);
      if (s === sig) return;
      sig = s;
      name.textContent = d.name || L("(no name)", "(无名称)");
      const put = (e, ...kids) => clear(e).append(...kids.filter(k => k != null)); // native append prints null
      put(sub, macDisplay(mac), withConn && d.connected ? h("span", { class: "bh-conn" }, " " + L("Connected", "已连接")) : null);
      put(dyn,
        d.battery > 0 ? h("span", { class: "bh-batt", title: L("Battery", "电量") }, icon("battery", 16), String(Math.min(d.battery, 99))) : null,
        !withConn || d.connected ? bars(d.rssi) : null);
    };
    return { name, sub, dyn, update };
  }
  function pairedRow(mac) {
    const p = rowParts(mac);
    const del = h("button", { type: "button", class: "bh-del", "aria-label": L("Delete", "删除") + " " + macDisplay(mac), onclick: () => remove(mac) }, icon("trash", 20));
    const el = h("div", { class: "bh-row" },
      h("span", { class: "bh-ico paired" }, icon("ble", 24)),
      h("div", { class: "bh-text" }, p.name, p.sub),
      h("div", { class: "bh-right" }, p.dyn, del));
    return { el, update: d => p.update(d, true) };
  }
  function foundRow(mac) {
    const p = rowParts(mac);
    const el = h("button", { type: "button", class: "bh-row bh-tap", onclick: () => pair(mac), "aria-label": L("Pair", "配对") + " " + macDisplay(mac) },
      h("span", { class: "bh-ico" }, icon("ble", 24)),
      h("div", { class: "bh-text" }, p.name, p.sub),
      h("div", { class: "bh-right" }, p.dyn));
    return { el, update: d => p.update({ ...d, battery: 0 }, false) };
  }

  function render() {
    syncList(pairedCard, pairedRows, Object.entries(st.paired), pairedRow);
    syncList(foundCard, foundRows, Object.entries(st.found), foundRow);
    clear(findBtn).append(...(st.scanning ? [h("span", { class: "bh-spin", "aria-hidden": "true" }), L("Stop", "停止")] : [L("Search", "搜索")]));
    findBtn.setAttribute("aria-busy", String(st.scanning));
  }

  // ---------------------------------------------------------------- actions
  const tx = (body, opts) => send(TYPE.BLE_HOST, body, opts);

  async function toggleScan() {
    if (!ready()) { toast(L("Connect to the module first.", "请先连接蓝牙")); return; }
    const wasScanning = st.scanning;
    if (!wasScanning) st.found = {};
    if (!(await tx(wasScanning ? bleHostScanStop(uid()) : bleHostScanStart(uid()), { read: true }))) return;
    st.scanning = !wasScanning;
    render();
  }

  async function pair(mac) {
    const d = st.found[mac];
    if (!d) return;
    await tx(bleHostPair(uid(), d.addrType, mac, d.nameBytes));
  }

  async function remove(mac) {
    const d = st.paired[mac];
    if (!d) return;
    const ok = await tx(bleHostDelete(uid(), d.addrType, mac), { confirm: { en: "Delete this BLE device?", zh: "确定要删除此蓝牙设备吗?" } });
    if (ok) { delete st.paired[mac]; render(); }
  }

  function onReply(p) {
    const r = applyBleHost(st, p);
    if (r.error && r.kind !== "list") return;
    if (r.kind === "status") {
      const s = r.status;
      toast(L(s.en, s.zh || s.en), s.kind === 1 ? "ok" : s.kind === 0 ? "bad" : "", s.kind === -1 ? 15000 : 2000);
    }
    if (r.kind === "scan" || r.kind === "list") render();
  }

  // ---------------------------------------------------------------- lifecycle
  const active = () => shown && !document.hidden;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(tick, ms); }
  function tick() {
    timer = 0;
    if (!active() || !ready()) return;            // the status and conn events start it again
    if (!started) {
      started = true;
      tx(bleHostScanStart(uid()), { read: true, quiet: true }).then(ok => { if (!ok) started = false; });
      schedule(FIRST_LIST_MS);
      return;
    }
    tx(bleHostList(uid()), { read: true, quiet: true });
    schedule(LIST_MS);
  }
  function kick() { if (!timer) tick(); }
  function stop() {
    clearTimeout(timer); timer = 0;
    if (started && S.link && S.link.connected) tx(bleHostScanStop(uid()), { read: true, quiet: true });
    started = false;
    st.found = {};
    st.scanning = false;
    render();
  }
  function onVis() { if (document.hidden) stop(); else kick(); }

  render();
  return {
    el,
    title: { en: "BLE pairing", zh: "蓝牙配对" },
    enter() {
      shown = true;
      offs.push(onBus("frame", fr => { if (fr.cmd === TYPE.BLE_HOST) onReply(fr.payload); }));
      offs.push(onBus("status", kick));
      offs.push(onBus("conn", c => {
        if (!c.connected) { clearTimeout(timer); timer = 0; started = false; st.scanning = false; st.found = {}; render(); }
        else kick();
      }));
      document.addEventListener("visibilitychange", onVis);
      kick();
    },
    leave() {
      shown = false;
      stop();
      offs.splice(0).forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
    },
    refresh() { render(); },
  };
});
