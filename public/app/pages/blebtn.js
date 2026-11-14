// BLE buttons (vendor pages/blebtn, 蓝牙按钮设置): the BA table of paired BLE buttons with a click and a
// double-click action each. Pairing: BA 01, then the module sends a 6-byte "new button" message.
// A known button press sends a 7-byte message; the page shows the action names in a toast.
// Names and battery levels stay in this browser (localStorage, keys "id<n>" like the vendor).
import { h, L, clear, icon, iconBtn, btn, toast, confirmBox, promptBox, helpButton } from "../ui.js";
import { definePage, onBus, funlist, ask, go, log } from "../app.js";
import { decodeBleButtons, encodeBleButtons, parseBleNotify, BLE_SLOTS, BLE_PAIR_START, LABELS, CMD } from "../../lib/tsl6-tables.js";
import { openFnPicker, tryAction, fnLabel } from "../fnpicker.js";
import { linkState, linkStateText, readTable, writeTable, loadTablesCss, bleNames, bleBats, bleKey, setBleName, setBleBat, pruneBleStore } from "../tableio.js";
import { longPress, pill, moveBar } from "./shortcuts.js";

const PAIR_TIMEOUT_MS = 60000;

// Edit (rename) icon. ui.js has no pencil icon.
function pencil() {
  const s = icon("help", 20);
  s.firstChild.setAttribute("d", "M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4");
  return s;
}

definePage("blebtn", () => {
  loadTablesCss();
  const el = h("div", { class: "page tbl-page" });
  let list = { btn: [], fun: [] };
  let table = null;      // last 256-byte BA table that the module sent
  let buttons = [];      // [{click, dblClick, id, idHex}]
  let busy = false, loading = false, failed = false, moving = -1, entered = false;
  let pairing = null;    // {name, timer, overlay} while BA 01 is active
  const offs = [];
  let api = null;

  const nameOf = b => bleNames()[bleKey(b.id)] || L(LABELS.bleButton);
  const entries = arr => arr.map(({ click, dblClick, idHex }) => ({ click, dblClick, idHex }));

  function setTable(t) {
    table = t;
    buttons = decodeBleButtons(t);
    pruneBleStore(buttons.map(b => b.id));
  }

  async function load() {
    if (loading || busy) return;
    if (linkState() !== "ok") { render(); return; }
    loading = true; failed = false; render();
    const t = await readTable(CMD.BLE_BUTTONS);   // BA 02 also ends pairing mode on the module
    loading = false;
    if (t) setTable(t); else failed = true;
    render();
  }

  async function commit(next, { deleted = false } = {}) {
    if (!table || busy) return { ok: false };
    let payload;
    try { payload = encodeBleButtons(table, entries(next)); } catch (e) { toast(e.message, "bad", 3000); return { ok: false }; }
    busy = true; render();
    const res = await writeTable(CMD.BLE_BUTTONS, payload);
    busy = false;
    if (res.reason === "cancel" || res.reason === "blocked") { render(); return res; }
    if (res.table) setTable(res.table);
    if (res.ok && deleted) toast(L("Deleted", "删除成功"), "ok");
    if (!res.table) { table = null; await load(); } else render();
    return res;
  }

  // ---------------------------------------------------------------- pairing
  function waitingOverlay(name) {
    const cancel = h("button", { class: "dlg-btn", type: "button", onclick: () => stopPairing(true) }, L("Cancel", "取消"));
    const box = h("div", { class: "dlg", role: "dialog", "aria-modal": "true", "aria-labelledby": "bb-wait-t" },
      h("h3", { id: "bb-wait-t" }, L("Press the BLE button", "请点击蓝牙按钮")),
      h("div", { class: "dlg-body" },
        h("div", { class: "bb-spin", "aria-hidden": "true" }),
        h("p", { class: "dlg-text" }, L(`Press the button that you want to add as "${name}". The module adds the first button that it hears.`,
          `请按下要添加为「${name}」的按钮。模块会添加第一个收到的按钮。`))),
      h("div", { class: "dlg-btns" }, cancel));
    const back = h("div", { class: "dlg-back" }, box);
    document.body.append(back);
    cancel.focus();
    return back;
  }
  function endPairing() {
    if (!pairing) return null;
    const p = pairing;
    pairing = null;
    clearTimeout(p.timer);
    if (p.overlay) p.overlay.remove();
    return p;
  }
  // Cancel, timeout or leave: end pairing mode on the module with BA 02 (it also sends the table).
  async function stopPairing(reread, why) {
    if (!endPairing()) return;
    if (why) toast(why, "warn", 2500);
    if (reread && linkState() === "ok") { table = null; await load(); }
    else if (linkState() === "ok") readTable(CMD.BLE_BUTTONS).catch(() => {});
  }

  async function add() {
    if (!table || busy || pairing) return;
    if (buttons.length >= BLE_SLOTS) { toast(L(`The table holds at most ${BLE_SLOTS} buttons.`, `最多 ${BLE_SLOTS} 个蓝牙按钮`), "warn"); return; }
    const v = await promptBox({ title: L("Add BLE button", "添加蓝牙按钮"), label: L("Enter a name for the new BLE button.", "输入要添加的蓝牙按钮名称"), maxlength: 24 });
    if (v == null || !entered) return;
    const name = v.trim() || L(LABELS.bleButton);
    pairing = { name, timer: 0, overlay: null };
    const r = await ask(CMD.BLE_BUTTONS, BLE_PAIR_START, { reply: [CMD.BLE_BUTTONS], accept: f => f.payload.length === 1, timeout: 3000 });
    if (!pairing) return;                      // ended while we waited (disconnect or leave)
    if (!r || r.payload[0] !== 1) {
      pairing = null;
      if (r) toast(L("The module did not start pairing.", "模块未进入配对"), "bad");
      return;
    }
    pairing.overlay = waitingOverlay(name);
    pairing.timer = setTimeout(() => stopPairing(true, L("No button was pressed. Pairing stopped.", "未收到按钮，已停止配对")), PAIR_TIMEOUT_MS);
  }

  async function onLearned(m) {
    if (!pairing) { log(`BA: new-button message ${m.idHex} without pairing, ignored`, "warn"); return; }
    if (buttons.some(b => b.idHex === m.idHex)) {
      setBleBat(m.id, m.battery);
      await stopPairing(true, L(`This button is already in the list (${nameOf(m)}).`, `此按钮已在列表中（${nameOf(m)}）`));
      return;
    }
    if (buttons.length >= BLE_SLOTS || !table) { await stopPairing(true, L("The table is full.", "蓝牙按钮已满")); return; }
    const p = endPairing();
    const res = await commit([...buttons, { click: m.click, dblClick: m.dblClick, idHex: m.idHex }]);
    if (buttons.some(b => b.idHex === m.idHex)) {
      setBleName(m.id, p.name);
      setBleBat(m.id, m.battery);
      if (res.ok) toast(L("Added", "添加成功"), "ok");
      render();
      requestAnimationFrame(() => { const last = el.querySelector(".bb-card:last-of-type"); if (last) last.scrollIntoView({ block: "nearest" }); });
    }
  }

  function onPress(m) {
    const b = buttons.find(x => x.idHex === m.idHex);
    const kind = L(m.double ? LABELS.dblClick : LABELS.click);
    const name = b ? nameOf(b) : L(LABELS.bleButton);
    let acts = [];
    if (b) {
      const val = m.double ? b.dblClick : b.click;
      for (const g of list.fun) for (const d of g.data || []) if (d.val !== 0 && d.val === val) acts.push(L({ en: d.name_en, zh: d.name }));
      if (!acts.length && val) acts = [fnLabel(list.fun, val)];
    }
    toast(`${name} ${kind}\n${acts.length ? acts.join(" ") : L(LABELS.pressNone)}`, "", 2200);
    if (setBleBat(m.id, m.battery) && !busy) render();
  }

  function onFrame(fr) {
    if (fr.cmd !== CMD.BLE_BUTTONS) return;
    const m = parseBleNotify(fr.payload);
    if (m.kind === "learned") onLearned(m);
    else if (m.kind === "press") onPress(m);
  }

  // ---------------------------------------------------------------- edits
  async function pick(i, field) {
    const v = await openFnPicker({ title: field === "click" ? L(LABELS.click) : L(LABELS.dblClick), groups: list.fun, value: buttons[i][field], kind: "action" });
    if (v == null || !entered) return;
    await commit(buttons.map((b, n) => (n === i ? { ...b, [field]: v } : b)));
  }
  async function rename(i) {
    const b = buttons[i];
    const v = await promptBox({ title: L("Rename button", "修改按钮名称"), value: bleNames()[bleKey(b.id)] || "", placeholder: L(LABELS.bleButton), maxlength: 24 });
    if (v == null) return;
    if (!v.trim()) { toast(L("The name must not be empty.", "按钮名称不能为空"), "warn"); return; }
    setBleName(b.id, v.trim());
    toast(L("Renamed", "修改成功"), "ok");
    render();
  }
  async function del(i) {
    if (!(await confirmBox(L("Delete this button?", "确定要删除此按钮吗")))) return;
    await commit(buttons.filter((_, n) => n !== i), { deleted: true });
  }
  async function delAll() {
    if (!(await confirmBox(L("Delete all BLE buttons?", "确定删除所有蓝牙按钮?")))) return;
    await commit([], { deleted: true });
  }
  async function move(a, b) {
    if (b < 0 || b >= buttons.length) return;
    const next = buttons.slice();
    [next[a], next[b]] = [next[b], next[a]];
    moving = b;
    await commit(next);
  }
  function openHost() {
    try { go("blehost"); }
    catch (e) {
      log(`blehost: ${e.message}`, "warn");
      toast(L("The BLE pairing page is not in this version yet.", "此版本暂无蓝牙配对页面"), "warn", 2500);
      api.enter();                            // go() called leave() before it failed
    }
  }

  // ---------------------------------------------------------------- render
  function card(b, i) {
    const bat = bleBats()[bleKey(b.id)];
    const actionRow = (field, lab) => h("div", { class: "row bb-row" },
      h("span", { class: "row-label" }, L(lab)),
      h("div", { class: "row-right" },
        pill(fnLabel(list.fun, b[field], LABELS.actionNone), () => pick(i, field), { disabled: busy, label: L(lab) }),
        h("button", { class: "link-btn", type: "button", disabled: busy || !b[field], onclick: () => tryAction(b[field]) }, L("Try", "尝试"))));
    const c = h("section", { class: "card bb-card" + (moving === i ? " moving" : "") },
      h("div", { class: "bb-head" },
        h("span", { class: "bb-name" }, `${i + 1}. ${nameOf(b)}`),
        bat != null ? h("span", { class: "bb-bat" }, L(`Battery: ${bat}%`, `电量:${bat}%`)) : null,
        h("button", { class: "ibtn flat on-mint", type: "button", disabled: busy, "aria-label": L("Rename", "修改名称"), onclick: () => rename(i) }, pencil()),
        h("button", { class: "ibtn flat on-mint", type: "button", disabled: busy, "aria-label": L("Delete", "删除"), onclick: () => del(i) }, icon("trash", 20))),
      actionRow("click", LABELS.click),
      actionRow("dblClick", LABELS.dblClick));
    if (moving === i) c.append(moveBar(i, buttons.length, { onmove: move, ondone: () => { moving = -1; render(); }, disabled: busy }));
    longPress(c, () => { if (!busy) { moving = i; render(); } });
    return c;
  }

  function render() {
    clear(el);
    const ready = !!table && linkState() === "ok";
    const hasFun = list.fun.length > 0;
    el.append(h("section", { class: "card tbl-toolbar" },
      helpButton("help_BLEBTN", { en: "BLE buttons", zh: "蓝牙按钮" }),
      h("div", { class: "tools" },
        h("button", { class: "ibtn link", type: "button", onclick: openHost, "aria-label": L("BLE pairing", "蓝牙配对"), title: L("BLE pairing", "蓝牙配对") }, icon("link", 22)),
        hasFun ? [
          iconBtn("trash", delAll, { label: L("Delete all", "删除全部"), disabled: !ready || busy || !buttons.length }),
          iconBtn("plus", add, { label: L("Add", "添加"), disabled: !ready || busy || !!pairing }),
        ] : null)));

    const st = linkState();
    if (st !== "ok") { el.append(h("section", { class: "card" }, h("p", { class: "empty" }, linkStateText(st)))); return; }
    if (loading && !table) { el.append(h("section", { class: "card" }, h("p", { class: "empty" }, L("Reading the BLE button table…", "正在读取蓝牙按钮…")))); return; }
    if (!table) {
      el.append(h("section", { class: "card" }, h("p", { class: "empty" }, failed
        ? L("The module did not send the BLE button table.", "未读取到蓝牙按钮数据") : L("No data yet.", "暂无数据")),
      h("div", { class: "tbl-center" }, btn({ en: "Read again", zh: "重新读取" }, load, { kind: "small" }))));
      return;
    }
    if (!buttons.length) el.append(h("section", { class: "card tbl-empty" }, L("The BLE button list is empty", "蓝牙按钮列表为空")));
    buttons.forEach((b, i) => el.append(card(b, i)));
    if (busy) el.append(h("p", { class: "foot tbl-busy" }, L("Writing to the module…", "正在写入…")));
    if (buttons.length) el.append(h("p", { class: "foot" }, L(
      "Names and battery levels are kept in this browser only. Long-press a card to move it.",
      "按钮名称和电量只保存在此浏览器中。长按卡片可移动顺序。")));
  }

  render();
  api = {
    el,
    title: { en: "BLE buttons", zh: "蓝牙按钮设置" },
    enter() {
      if (entered) return;
      entered = true;
      offs.push(onBus("frame", onFrame));
      offs.push(onBus("status", () => { if (!table && !loading && linkState() === "ok") load(); }));
      offs.push(onBus("conn", st => {
        if (!st.connected) { endPairing(); table = null; buttons = []; moving = -1; busy = false; loading = false; }
        render();
      }));
      funlist().then(l => { list = { btn: l.btn || [], fun: l.fun || [] }; render(); load(); });
    },
    leave() {
      entered = false;
      offs.splice(0).forEach(f => f());
      if (pairing) stopPairing(false);
    },
  };
  return api;
});
