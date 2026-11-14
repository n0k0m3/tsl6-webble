// Function picker (vendor components/picker): a full-screen sheet with a grouped list.
// Groups fold open. The group of the current value opens first. The selected item shows its help line.
// Save resolves the chosen value. Close, Escape, browser back and a disconnect resolve null.
// Try (BB, run the action now) shows only on an ACTION picker and only when the selected item has `attemp`.
// Used by the shortcut page, the BLE button page and the ambient-light page.
import { h, L, icon, toast, confirmBox } from "./ui.js";
import { S, ask, funlist, localGroups, onBus } from "./app.js";
import { tryPayload, CMD } from "../lib/tsl6-tables.js";

const CSS = `
.fnp-back [hidden] { display: none !important; }
.fnp-back { position: fixed; inset: 0; z-index: 40; background: var(--bg); display: flex; flex-direction: column; }
.fnp-head { flex: none; height: calc(var(--top-h) + env(safe-area-inset-top)); padding-top: env(safe-area-inset-top); background: var(--mint); color: #fff;
  display: grid; grid-template-columns: 48px 1fr 48px; align-items: center; }
.fnp-head h3 { margin: 0; font-size: 18px; font-weight: 600; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fnp-x { background: none; border: 0; color: #fff; height: 44px; cursor: pointer; display: grid; place-items: center; }
.fnp-list { flex: 1 1 auto; overflow: auto; overscroll-behavior: contain; }
.fnp-inner { max-width: 720px; margin: 0 auto; padding: 10px 12px 16px; }
.fnp-note { margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; background: var(--card); border: 1px dashed var(--warn); color: var(--warn); font-size: 14px; }
.fnp-group { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin: 0 0 10px; overflow: hidden; box-shadow: var(--shadow); }
.fnp-ghead { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 14px; background: none; border: 0;
  font-size: 16px; font-weight: 600; text-align: left; cursor: pointer; color: var(--fg); }
.fnp-ghead svg { flex: none; color: var(--muted); transition: transform .15s; }
.fnp-ghead[aria-expanded="true"] svg { transform: rotate(180deg); }
.fnp-ghead .fnp-has { width: 8px; height: 8px; border-radius: 50%; background: var(--mint-d); display: inline-block; margin-left: 8px; vertical-align: middle; }
.fnp-item { display: block; width: 100%; padding: 12px 14px; border: 0; border-top: 1px solid var(--line); background: none; text-align: left; cursor: pointer;
  font-size: 16px; color: var(--fg); }
.fnp-item.on { background: var(--mint-l); }
.fnp-item .fnp-ok { color: var(--ok); font-weight: 700; margin-left: 6px; }
.fnp-help { display: block; margin-top: 6px; font-size: 13px; line-height: 1.45; color: var(--muted); white-space: pre-line; }
.fnp-empty { text-align: center; color: var(--muted); padding: 24px 12px; }
.fnp-foot { flex: none; background: var(--card); border-top: 1px solid var(--line); padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); }
.fnp-foot-in { max-width: 720px; margin: 0 auto; display: flex; align-items: center; gap: 10px; }
.fnp-foot-in .grow { flex: 1; }
.fnp-foot .btn { min-width: 84px; }
.fnp-save:not(:disabled) { color: var(--mint-d); font-weight: 600; }
`;
let cssDone = false;
function loadCss() {
  if (cssDone) return;
  cssDone = true;
  document.head.append(h("style", { id: "fnpicker-css" }, CSS));
}

const findItem = (groups, val) => {
  let found = null;
  for (const g of groups || []) for (const d of g.data || []) if (d.val === val) found = d; // last match wins (vendor)
  return found;
};

// Label for an id from raw function-list groups. 0 -> `none`. Unknown ids keep the raw number.
export function fnLabel(groups, val, none = { en: "None", zh: "无" }) {
  const it = findItem(groups, val);
  if (it) return L({ en: it.name_en, zh: it.name });
  if (!val) return L(none);
  return L(`Unknown (id ${val})`, `未知 (id ${val})`);
}

// Run one action on the car now (BB + id). The id must be a non-zero id of the action list (funlist.fun).
// Asks the user first, because this moves car parts. Returns true when the module confirmed.
export async function tryAction(val) {
  const list = await funlist();
  const it = val ? findItem(list.fun, val) : null;
  if (!it) {
    toast(L("This id is not in the action list. The app does not send it.", "此指令不在功能列表中，不发送"), "warn", 2500);
    return false;
  }
  const name = L({ en: it.name_en, zh: it.name });
  const ok = await confirmBox(
    { en: `Run "${name}" on the car now?\nThe module runs the action at once.`, zh: `确定立即执行「${it.name}」吗？\n模块会马上执行此操作。` },
    L("Try action", "尝试"), L("Run", "执行"));
  if (!ok) return false;
  const r = await ask(CMD.TRY, tryPayload(val), { reply: [CMD.TRY, CMD.FAIL], timeout: 2500 });
  if (!r) return false;
  if (r.cmd === CMD.FAIL) {
    toast(r.payload[0] ? L("Operation OK", "操作成功") : L("Operation failed", "操作失败"), r.payload[0] ? "ok" : "bad");
    return !!r.payload[0];
  }
  toast(L("Command sent", "指令已发送"), "ok", 1200);
  return true;
}

// Open the picker. Resolves the chosen value (a number) or null.
//   title: string or {en, zh}
//   groups: raw function-list groups (funlist().btn or funlist().fun)
//   value: the current id
//   kind: "action" (Try allowed) or "trigger" (no Try)
export function openFnPicker({ title, groups, value, kind = "action" }) {
  loadCss();
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const local = localGroups(groups);
    // Action 0 = no action (vendor default "无操作(默认)"). The server list has no entry for it, so a slot could not be cleared.
    if (kind === "action") local.unshift({ name: L("No action", "无操作"), data: [{ val: 0, label: L("No action (default)", "无操作(默认)"), help: "" }] });
    let sel = null;            // selected item (local)
    let selEl = null;
    const offs = [];

    const saveBtn = h("button", { class: "btn fnp-save", type: "button", disabled: true }, L("Save", "保存"));
    const tryBtn = h("button", { class: "btn", type: "button", hidden: true }, L("Try", "尝试"));
    const closeBtn = h("button", { class: "btn", type: "button" }, L("Cancel", "取消"));

    function updateFoot() {
      saveBtn.disabled = !sel || sel.val === value;
      tryBtn.hidden = !(kind === "action" && sel && sel.attemp && sel.val);
    }

    function itemEl(it) {
      const help = it.help ? h("span", { class: "fnp-help" }, it.help) : null;
      const ok = h("span", { class: "fnp-ok", "aria-hidden": "true" }, "✓");
      const b = h("button", { class: "fnp-item", type: "button", "aria-pressed": "false" }, h("span", null, it.label), ok, help);
      const set = on => {
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
        ok.hidden = !on; if (help) help.hidden = !on;
      };
      set(false);
      b.addEventListener("click", () => {
        if (selEl) selEl.set(false);
        sel = it; selEl = { set }; set(true);
        updateFoot();
      });
      if (it.val === value) { sel = it; selEl = { set }; set(true); }
      return b;
    }

    const inner = h("div", { class: "fnp-inner" });
    if (value && !findItem(groups, value)) {
      inner.append(h("p", { class: "fnp-note" }, L(`The current id ${value} is not in the list. It stays as it is until you save another item.`,
        `当前值 id ${value} 不在列表中。保存其他项之前保持不变。`)));
    }
    if (!local.length) inner.append(h("p", { class: "fnp-empty" }, L("The function list is empty.", "功能列表为空")));
    for (const g of local) {
      const hasCur = g.data.some(d => d.val === value);
      const items = h("div", { hidden: !hasCur }, g.data.map(itemEl));
      const head = h("button", { class: "fnp-ghead", type: "button", "aria-expanded": String(hasCur) },
        h("span", null, g.name, hasCur ? h("span", { class: "fnp-has", title: L("Current value", "当前值") }) : null), icon("down", 20));
      head.addEventListener("click", () => {
        const open = items.hidden;
        items.hidden = !open; head.setAttribute("aria-expanded", String(open));
      });
      inner.append(h("section", { class: "fnp-group" }, head, items));
    }

    const list = h("div", { class: "fnp-list" }, inner);
    const back = h("div", { class: "fnp-back", role: "dialog", "aria-modal": "true", "aria-label": typeof title === "object" ? L(title) : title },
      h("header", { class: "fnp-head" },
        h("button", { class: "fnp-x", type: "button", "aria-label": L("Close", "关闭"), onclick: () => close(null) }, icon("back", 22)),
        h("h3", null, typeof title === "object" ? L(title) : title),
        h("span")),
      list,
      h("footer", { class: "fnp-foot" }, h("div", { class: "fnp-foot-in" }, closeBtn, h("span", { class: "grow" }), tryBtn, saveBtn)));

    let done = false;
    function close(v) {
      if (done) return;
      done = true;
      offs.splice(0).forEach(f => f());
      back.remove();
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
      resolve(v);
    }
    closeBtn.addEventListener("click", () => close(null));
    saveBtn.addEventListener("click", () => { if (sel && sel.val !== value) close(sel.val); });
    tryBtn.addEventListener("click", () => { if (kind === "action" && sel && sel.attemp) tryAction(sel.val); });

    const onKey = e => { if (e.key === "Escape" && !document.querySelector(".dlg-back")) close(null); };
    const onPop = () => close(null);
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    offs.push(() => document.removeEventListener("keydown", onKey), () => window.removeEventListener("popstate", onPop));
    offs.push(onBus("conn", st => { if (!st.connected) close(null); }));

    updateFoot();
    document.body.append(back);
    const cur = inner.querySelector(".fnp-item.on");
    if (cur) { cur.scrollIntoView({ block: "center" }); cur.focus({ preventScroll: true }); }
    else (inner.querySelector(".fnp-ghead") || closeBtn).focus();
    if (!S.link || !S.link.connected) tryBtn.title = L("Connect to the module first.", "请先连接蓝牙");
  });
}
