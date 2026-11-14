// Shortcut commands (vendor pages/btn, 快捷指令设置): the AB table of (trigger, action) pairs.
// Each change writes the whole 256-byte table at once and checks the echo.
import { h, L, clear, icon, iconBtn, btn, toast, confirmBox, helpButton } from "../ui.js";
import { definePage, onBus, funlist } from "../app.js";
import { decodeShortcuts, encodeShortcuts, SHORTCUT_SLOTS, LABELS, CMD } from "../../lib/tsl6-tables.js";
import { openFnPicker, tryAction, fnLabel } from "../fnpicker.js";
import { linkState, linkStateText, readTable, writeTable, loadTablesCss } from "../tableio.js";

// Long press on a card (600 ms, no big move) calls onlong. The click after a long press is dropped.
export function longPress(el, onlong, ms = 600) {
  let t = 0, x = 0, y = 0, fired = false;
  el.addEventListener("pointerdown", e => {
    fired = false; x = e.clientX; y = e.clientY; clearTimeout(t);
    t = setTimeout(() => { fired = true; onlong(); }, ms);
  });
  el.addEventListener("pointermove", e => { if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 12) clearTimeout(t); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener("click", e => { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } }, true);
  el.addEventListener("contextmenu", e => e.preventDefault());
}

// A pill button that opens a picker (looks like the vendor picker text with a chevron).
export function pill(text, onclick, { disabled, label } = {}) {
  return h("button", { class: "tpick", type: "button", onclick, disabled, "aria-label": label ? `${label}: ${text}` : null },
    h("span", { class: "tpick-t" }, text), icon("chevron-down", 16));
}

// Up / down / done bar for the card in move mode.
export function moveBar(i, n, { onmove, ondone, disabled }) {
  return h("div", { class: "move-bar" },
    h("span", { class: "move-note" }, L("Move", "移动")),
    iconBtn("up", () => onmove(i, i - 1), { label: L("Move up", "上移"), disabled: disabled || i === 0 }),
    iconBtn("down", () => onmove(i, i + 1), { label: L("Move down", "下移"), disabled: disabled || i >= n - 1 }),
    btn({ en: "Done", zh: "完成" }, ondone, { kind: "small" }));
}

definePage("shortcuts", () => {
  loadTablesCss();
  const el = h("div", { class: "page tbl-page" });
  let list = { btn: [], fun: [] };
  let table = null;      // last 256-byte AB table that the module sent
  let rows = [];         // [{trigger, action}] in table order
  let draft = false;     // an unsaved new row at the end (no trigger yet)
  let busy = false, loading = false, failed = false, moving = -1, entered = false;
  const offs = [];

  async function load() {
    if (loading || busy) return;
    if (linkState() !== "ok") { render(); return; }
    loading = true; failed = false; render();
    const t = await readTable(CMD.SHORTCUTS);
    loading = false;
    if (t) setTable(t); else failed = true;
    render();
  }
  function setTable(t) { table = t; rows = decodeShortcuts(t).map(({ trigger, action }) => ({ trigger, action })); }

  // Write the rows. Render from the module reply in every case.
  async function commit(next, { deleted = false } = {}) {
    if (!table || busy) return false;
    let payload;
    try { payload = encodeShortcuts(table, next); } catch (e) { toast(e.message, "bad", 3000); return false; }
    busy = true; render();
    const res = await writeTable(CMD.SHORTCUTS, payload);
    busy = false;
    if (res.reason === "cancel" || res.reason === "blocked") { render(); return false; }
    if (res.table) setTable(res.table);
    if (res.ok && deleted) toast(L("Deleted", "删除成功"), "ok");
    if (!res.table) { table = null; await load(); } else render();
    return res.ok;
  }

  async function pickTrigger(i) {
    const cur = i < rows.length ? rows[i].trigger : 0;
    const v = await openFnPicker({ title: L("Trigger", "快捷指令"), groups: list.btn, value: cur, kind: "trigger" });
    if (v == null || !entered) return;
    if (i >= rows.length) {               // the draft row gets its trigger: write it now
      await commit([...rows, { trigger: v, action: 0 }]);
      if (rows.length > i) draft = false;   // the module table has the new row
      render();
      return;
    }
    await commit(rows.map((r, n) => (n === i ? { ...r, trigger: v } : r)));
  }
  async function pickAction(i) {
    const v = await openFnPicker({ title: L("Action", "执行动作"), groups: list.fun, value: rows[i].action, kind: "action" });
    if (v == null || !entered) return;
    await commit(rows.map((r, n) => (n === i ? { ...r, action: v } : r)));
  }
  async function del(i) {
    if (i >= rows.length) { draft = false; render(); return; }
    if (!(await confirmBox(L("Delete this shortcut command?", "确定要删除此快捷指令吗")))) return;
    await commit(rows.filter((_, n) => n !== i), { deleted: true });
  }
  async function delAll() {
    if (!table) return;
    if (!(await confirmBox(L("Delete all shortcut commands?", "确定删除所有快捷指令?")))) return;
    draft = false;
    await commit([], { deleted: true });
  }
  function add() {
    if (!table) return;
    if (rows.length >= SHORTCUT_SLOTS) { toast(L(`The table holds at most ${SHORTCUT_SLOTS} shortcuts.`, `最多 ${SHORTCUT_SLOTS} 条快捷指令`), "warn"); return; }
    if (!draft) { draft = true; render(); }
    // Like the vendor, the new row is not written until it has a trigger. We open the trigger picker at once.
    pickTrigger(rows.length);
  }
  async function move(a, b) {
    if (b < 0 || b >= rows.length) return;
    const next = rows.slice();
    [next[a], next[b]] = [next[b], next[a]];
    moving = b;
    await commit(next);
  }

  function card(r, i, isDraft) {
    // Grid: number | When and Then pickers (same width) | delete and try.
    const n = h("span", { class: "sc-num" }, `#${i + 1}`);
    const trig = pill(isDraft ? L(LABELS.triggerNone) : fnLabel(list.btn, r.trigger, LABELS.triggerNone),
      () => pickTrigger(i), { disabled: busy || !table, label: L("Trigger", "快捷指令") });
    const delBtn = h("button", { class: "ibtn flat", type: "button", disabled: busy, "aria-label": L(`Delete shortcut ${i + 1}`, `删除第 ${i + 1} 条`), title: L("Delete", "删除"), onclick: () => del(i) }, icon("trash", 20));
    const c = h("section", { class: "card sc-card" + (isDraft ? " draft" : "") + (moving === i ? " moving" : "") },
      n, h("div", { class: "sc-line" }, h("span", { class: "sc-tag" }, L("When", "当")), trig), delBtn);
    if (isDraft) {
      c.append(h("p", { class: "sc-draft-note" }, L("Not saved. Select a trigger to save this row.", "未保存。选择快捷指令后保存。")));
      return c;
    }
    c.append(h("div", { class: "sc-line" }, h("span", { class: "sc-tag" }, L("Then", "则")),
      pill(fnLabel(list.fun, r.action, LABELS.actionNone), () => pickAction(i), { disabled: busy, label: L("Action", "执行动作") })),
      h("button", { class: "ibtn flat sc-try", type: "button", disabled: busy || !r.action, "aria-label": L(`Try shortcut ${i + 1}`, `尝试第 ${i + 1} 条`), title: L("Try", "尝试"),
        onclick: () => tryAction(r.action) }, icon("play", 18)));
    if (moving === i) c.append(moveBar(i, rows.length, { onmove: move, ondone: () => { moving = -1; render(); }, disabled: busy }));
    longPress(c, () => { if (!busy) { moving = i; render(); } });
    return c;
  }

  function render() {
    clear(el);
    const ready = !!table && linkState() === "ok";
    const hasFun = list.fun.length > 0;
    el.append(h("section", { class: "card tbl-toolbar" },
      hasFun ? h("button", { class: "btn small danger", type: "button", disabled: !ready || busy || !rows.length, onclick: delAll }, L("Delete all", "删除全部")) : h("span"),
      h("div", { class: "tools" },
        helpButton("help_BTN", { en: "Shortcut commands", zh: "快捷指令" }),
        hasFun ? h("button", { class: "btn small primary", type: "button", disabled: !ready || busy || draft, onclick: add }, icon("plus", 18), h("span", null, L("Add", "添加"))) : null)));

    const st = linkState();
    if (st !== "ok") { el.append(h("section", { class: "card" }, h("p", { class: "empty" }, linkStateText(st)))); return; }
    if (loading && !table) { el.append(h("section", { class: "card" }, h("p", { class: "empty" }, L("Reading the shortcut table…", "正在读取快捷指令…")))); return; }
    if (!table) {
      el.append(h("section", { class: "card" }, h("p", { class: "empty" }, failed
        ? L("The module did not send the shortcut table.", "未读取到快捷指令数据") : L("No data yet.", "暂无数据")),
      h("div", { class: "tbl-center" }, btn({ en: "Read again", zh: "重新读取" }, load, { kind: "small" }))));
      return;
    }
    if (!rows.length && !draft) el.append(h("section", { class: "card tbl-empty" }, L("The shortcut list is empty", "快捷指令列表为空")));
    rows.forEach((r, i) => el.append(card(r, i, false)));
    if (draft) el.append(card({ trigger: 0, action: 0 }, rows.length, true));
    if (busy) el.append(h("p", { class: "foot tbl-busy" }, L("Writing to the module…", "正在写入…")));
    if (rows.length) el.append(h("p", { class: "foot" }, L(
      "The module runs every row whose trigger matches, in list order. Long-press a card to move it.",
      "触发条件相同的所有行都会按顺序执行。长按卡片可移动顺序。")));
  }

  render();
  return {
    el,
    title: { en: "Shortcut commands", zh: "快捷指令设置" },
    enter() {
      if (entered) return;
      entered = true;
      offs.push(onBus("status", () => { if (!table && !loading && linkState() === "ok") load(); }));
      offs.push(onBus("conn", st => { if (!st.connected) { table = null; rows = []; draft = false; moving = -1; busy = false; loading = false; } render(); }));
      funlist().then(l => { list = { btn: l.btn || [], fun: l.fun || [] }; render(); load(); });
    },
    leave() { entered = false; offs.splice(0).forEach(f => f()); },
  };
});
