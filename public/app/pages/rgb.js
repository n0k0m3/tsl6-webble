// Ambient light page (vendor pages/rgb, "氛围灯设置"). BLE command B9.
// Two tabs: zone link (tab 0) and whole-car effect (tab 1). Each tab is one 256-byte rule table.
// Every change writes the whole table at once. There is no save button.
import { h, L, row, toggle, picker, btn, icon, toast, dialog, helpButton, pressable, clear } from "../ui.js";
import { S, definePage, onBus, ask, gate, funlist, log } from "../app.js";
import { openFnPicker, fnLabel } from "../fnpicker.js";
import {
  TYPE_RGB, TAB, TABS, TABLE_LEN, SLOT_COUNT, RULE0_NAME, optionsFor, rowsFor, canTry, rulesFromTable, encodeTable,
  buildRead, buildWrite, buildTry, buildClear, parseReply, echoMatches, newRule, moveRule, removeRule,
  rgbToHex, hexToRgb, hsvToRgb, wheelColor,
} from "../../lib/tsl6-rgb.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const QUIET_MS = 1500; // after a B9 timeout, wait this long so that a late reply cannot answer the next request

let cssLoaded = false;
function loadCss() {
  if (cssLoaded) return;
  cssLoaded = true;
  document.head.append(h("link", { rel: "stylesheet", href: new URL("./rgb.css", import.meta.url).href }));
}

// One B9 queue for every page instance (a language switch makes a new instance while the old request runs).
let chain = Promise.resolve();
let quietUntil = 0;
let pendingTab = null; // tab of the B9 request in flight (a reply is for this tab)

// Only a 256-byte table or the 1-byte FF "no module" reply answers a B9 request.
const acceptB9 = f => f.payload.length === TABLE_LEN || (f.payload.length === 1 && f.payload[0] === 0xff);

const LABEL = {
  addr: [{ en: "Ambient light", zh: "氛围灯" }, { en: "Effect", zh: "效果" }],
  effect: { en: "Effect", zh: "效果" },
  color: { en: "Colour", zh: "颜色" },
  bright: { en: "Brightness", zh: "亮度" },
  breathe: { en: "Fade speed", zh: "渐变速度" },
  blink: { en: "Blink speed", zh: "闪烁速度" },
};

// ---------------------------------------------------------------- trigger picker
// The shared grouped picker. kind "trigger" has no Try button: the vendor sends BB (run a shortcut now) from it.
const pickTrigger = (rawGroups, value) => openFnPicker({ title: { en: "Select a trigger", zh: "请选择快捷指令" }, groups: rawGroups, value, kind: "trigger" });

// ---------------------------------------------------------------- colour wheel
// Hue/saturation wheel, brightness fixed at 255 (as the vendor). A tap gives the same RGB as wheelColor().
function pickColor(start) {
  const SIZE = 240;
  let rgb = start.slice();
  const canvas = h("canvas", { width: SIZE * 2, height: SIZE * 2, "aria-label": L("Colour wheel", "颜色选择") });
  const dot = h("span", { class: "cw-dot", style: { display: "none" } });
  const prev = h("span", { class: "cw-prev" });
  const hex = h("input", { class: "text", maxlength: 7, value: rgbToHex(rgb), autocomplete: "off", spellcheck: "false", "aria-label": "Hex RRGGBB" });
  const show = () => { prev.style.background = "#" + rgbToHex(rgb); };

  // Draw: hue 0 (red) at the top, clockwise; saturation grows from the centre.
  const ctx = canvas.getContext("2d");
  const n = canvas.width, r0 = n / 2;
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x + 0.5 - r0, dy = r0 - (y + 0.5), d = Math.hypot(dx, dy);
    if (d > r0) continue;
    const hue = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    const c = hsvToRgb(hue, (d / r0) * 255, 255);
    const i = (y * n + x) * 4;
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const pick = e => {
    const b = canvas.getBoundingClientRect();
    const dx = e.clientX - b.left, dy = e.clientY - b.top;
    rgb = wheelColor(dx, dy, b.width).rgb;
    dot.style.display = "";
    dot.style.left = `${dx}px`; dot.style.top = `${dy}px`;
    hex.value = rgbToHex(rgb);
    show();
  };
  let down = false;
  canvas.addEventListener("pointerdown", e => { down = true; try { canvas.setPointerCapture(e.pointerId); } catch { /* old browser */ } pick(e); });
  canvas.addEventListener("pointermove", e => { if (down) pick(e); });
  canvas.addEventListener("pointerup", () => { down = false; });
  canvas.addEventListener("pointercancel", () => { down = false; });
  hex.addEventListener("input", () => {
    try { rgb = hexToRgb(hex.value.trim()); dot.style.display = "none"; show(); } catch { /* wait for 6 digits */ }
  });
  show();
  const body = h("div", { class: "cw" },
    h("div", { class: "cw-wrap" }, canvas, dot),
    h("div", { class: "cw-row" }, prev, h("span", { class: "mono" }, "#"), hex),
    h("p", { class: "cw-note" }, L("Set the brightness in the Brightness row.", "亮度请在「亮度」一栏设置。")));
  return dialog({
    title: L("Colour", "颜色"), body,
    buttons: [{ label: L("Cancel", "取消"), value: null }, { label: L("OK", "确定"), value: "ok", kind: "primary" }],
  }).then(v => {
    if (v !== "ok") return null;
    try { return hexToRgb(hex.value.trim()); } catch { toast(L("Enter the colour as RRGGBB.", "请输入RRGGBB格式的颜色"), "bad"); return null; }
  });
}

// ---------------------------------------------------------------- page
definePage("rgb", () => {
  loadCss();
  const el = h("div", { class: "page rgb" });
  const st = {
    tab: TAB.ZONE,
    rules: null,       // rules of the shown tab (codec objects), null until the module answers
    base: null,        // last 256-byte table of the shown tab (keeps the 4 tail bytes)
    mode: "offline",   // offline | locked | loading | ready | noModule | noReply
    moving: -1,        // rule index in move mode, or -1
  };
  let groups = [];     // raw trigger groups (funlist "btn")
  let gone = false;
  let busy = 0;        // writes in flight; edits wait until they end
  let jobs = 0;        // B9 jobs queued or in flight
  const offs = [];

  // One B9 request at a time. The reply does not name the tab, so requests must not overlap.
  function job(fn) {
    jobs++;
    const p = chain.then(fn).finally(() => { jobs--; });
    chain = p.catch(e => log(`rgb: ${e.message}`, "bad"));
    return p;
  }
  // Send one B9 payload and wait for the table or FF. Call only inside job().
  async function b9(tab, payload, { read = false, timeout = 3000, quiet = true } = {}) {
    const wait = quietUntil - Date.now();
    if (wait > 0) await sleep(wait);
    pendingTab = tab;
    const r = await ask(TYPE_RGB, payload, { read, quiet: true, timeout, accept: acceptB9 });
    pendingTab = null;
    if (!r) { if (quiet) quietUntil = Date.now() + QUIET_MS; return null; }
    return parseReply(r.payload);
  }

  const ready = () => S.link && S.link.connected && S.status && !S.blank;

  function apply(table) {
    st.base = table;
    st.rules = rulesFromTable(table);
    st.mode = "ready";
    if (st.moving >= st.rules.length) st.moving = -1;
  }
  function setNoModule() {
    st.mode = "noModule"; st.rules = null; st.base = null; st.moving = -1;
    toast(L("Install the ambient light module first.", "请先安装\n氛围灯模块"), "warn", 2500);
  }

  function read(tab = st.tab) {
    return job(async () => {
      if (gone || tab !== st.tab) return;
      if (!ready()) { st.mode = S.link && S.link.connected ? "locked" : "offline"; render(); return; }
      const r = await b9(tab, buildRead(tab), { read: true });
      if (gone) return;
      if (tab !== st.tab) { log(`rgb: reply for tab ${tab} ignored (tab ${st.tab} is shown)`); return; }
      if (!r) st.mode = "noReply";
      else if (r.kind === "noModule") setNoModule();
      else apply(r.table);
      render();
    });
  }

  function selectTab(t) {
    if (t === st.tab) return;
    st.tab = t; st.rules = null; st.base = null; st.moving = -1;
    st.mode = ready() ? "loading" : (S.link && S.link.connected ? "locked" : "offline");
    render();
    if (ready()) read(t);
  }

  // Write the whole table of the shown tab. Echo check; at most one resend of the full "01 tab" frame.
  async function commit(rules, { confirm, done } = {}) {
    if (st.mode !== "ready" || busy) { render(); return false; } // reset a control that changed while busy
    const tab = st.tab;
    let table;
    try { table = encodeTable(rules, st.base); } catch (e) { toast(e.message, "bad", 3000); render(); return false; }
    // One gate per user action: the untested warning and the vendor confirm, before any frame.
    if (!(await gate(TYPE_RGB, confirm ? { confirm } : {}))) { render(); return false; }
    if (gone || tab !== st.tab || st.mode !== "ready") return false;
    st.rules = rules; // show the change now; the reply corrects it
    busy++; render();
    let ok = false;
    await job(async () => {
      const payload = buildWrite(tab, table);
      let last = null;
      for (let a = 1; a <= 2 && !ok; a++) {
        const r = await b9(tab, payload);
        if (r) last = r;
        if (!r) log(`rgb: no reply to the write (try ${a}/2)`, "warn");
        else if (r.kind === "noModule") break;
        else if (r.kind === "table") { ok = echoMatches(table, r.table); if (!ok) log(`rgb: echo differs from the written table (try ${a}/2)`, "warn"); }
      }
      busy--;
      if (gone) return;
      if (tab !== st.tab) { log(`rgb: write reply for tab ${tab} ignored (tab ${st.tab} is shown)`); render(); return; }
      if (last && last.kind === "noModule") { setNoModule(); render(); return; }
      if (ok) { apply(last.table); toast(done || L("Saved", "保存成功"), "ok", 1200); render(); return; }
      toast(L("The module did not confirm the change. The page now shows the table that the module has.", "模块未确认此修改，页面显示模块当前的设置。"), "bad", 4000);
      if (last && last.kind === "table") { apply(last.table); render(); } else { st.mode = "loading"; render(); read(tab); }
    });
    return ok;
  }

  const setField = (i, field, v) => commit(st.rules.map((r, k) => (k === i ? { ...r, [field]: v } : r)));

  async function addRule() {
    if (st.mode !== "ready" || busy) return;
    if (st.rules.length >= SLOT_COUNT) { toast(L(`The module holds at most ${SLOT_COUNT} rules.`, `最多${SLOT_COUNT}条`), "warn", 2500); return; }
    // Vendor: "+" adds a rule with the placeholder trigger 1 and no write. Here the trigger comes first,
    // so a placeholder trigger never goes to the module.
    const val = await pickTrigger(groups, null);
    if (val == null || gone || st.mode !== "ready") return;
    const rules = [...st.rules, { ...newRule(st.tab), cmd: val }];
    if (await commit(rules)) setTimeout(() => { const c = el.querySelectorAll(".rgb-rule"); if (c.length) c[c.length - 1].scrollIntoView({ behavior: "smooth", block: "start" }); }, 50);
  }

  async function changeTrigger(i) {
    if (busy) return;
    const val = await pickTrigger(groups, st.rules[i].cmd);
    if (val == null || gone || !st.rules || i >= st.rules.length || val === st.rules[i].cmd) return;
    setField(i, "cmd", val);
  }

  function deleteRule(i) {
    commit(removeRule(st.rules, i), { confirm: { en: "Delete this rule?", zh: "确定要删除此指令吗" }, done: L("Deleted", "删除成功") });
  }

  async function deleteAll() {
    if (st.mode !== "ready" || busy) return;
    const tab = st.tab;
    if (!(await gate(TYPE_RGB, { confirm: { en: "Delete all rules on this tab? This cannot be undone.", zh: "确定删除所有指令?" } }))) return;
    if (gone || tab !== st.tab) return;
    busy++; render();
    await job(async () => {
      const r = await b9(tab, buildClear(tab));
      busy--;
      if (gone) return;
      if (tab !== st.tab) { render(); return; }
      if (r && r.kind === "noModule") setNoModule();
      else if (r && r.kind === "table") { apply(r.table); toast(L("Deleted", "删除成功"), "ok"); }
      else { toast(L("No reply from the module.", "模块无应答"), "warn"); st.mode = "loading"; read(tab); }
      render();
    });
  }

  async function tryRule(i) {
    if (st.mode !== "ready" || busy) return;
    const tab = st.tab;
    if (!(await gate(TYPE_RGB))) return;
    await job(async () => {
      // The vendor page waits for no reply here. Take a table or FF if one comes soon, so it cannot answer a later request.
      if (!gone) toast(L("Sent", "指令已发送"), "ok", 1000);
      const r = await b9(tab, buildTry(tab, i), { timeout: 800, quiet: false });
      if (gone || tab !== st.tab) return;
      if (r && r.kind === "noModule") { setNoModule(); render(); }
    });
  }

  async function changeColor(i) {
    if (busy) return;
    const c = await pickColor(st.rules[i].color);
    if (!c || gone || !st.rules || i >= st.rules.length) return;
    setField(i, "color", c);
  }

  async function move(i, d) {
    const to = i + d;
    if (to < 1 || to >= st.rules.length) return;
    if (await commit(moveRule(st.rules, i, to))) st.moving = to;
    render();
  }

  // ---------------------------------------------------------------- render
  const opts = (field, tab, i) => optionsFor(field, tab, i).map(([v, en, zh]) => [v, L(en, zh)]);
  function trigLabel(tab, i, cmd) {
    if (i === 0) { const n = RULE0_NAME[tab]; return L(n.label, n.zh); }
    return fnLabel(groups, cmd);
  }

  function ruleCard(tab, i, r) {
    const moving = st.moving === i;
    const name = i === 0
      ? h("span", { class: "rgb-name" }, h("span", null, trigLabel(tab, i, r.cmd)))
      : h("button", { type: "button", class: "rgb-name", title: L("Change the trigger", "选择快捷指令") },
        h("span", null, trigLabel(tab, i, r.cmd)), icon("down", 16));
    const moveMode = () => { st.moving = moving ? -1 : i; render(); };
    if (i >= 1) pressable(name, { ontap: () => changeTrigger(i), onlong: moveMode });
    const right = h("div", { class: "rgb-head-r" },
      toggle({ checked: !!r.run, label: L("Enable", "启用"), onchange: v => setField(i, "run", v ? 1 : 0) }));
    if (i >= 1) {
      if (moving) {
        right.append(
          h("button", { type: "button", class: "rgb-mini", "aria-label": L("Move up", "上移"), disabled: i <= 1, onclick: () => move(i, -1) }, icon("up", 20)),
          h("button", { type: "button", class: "rgb-mini", "aria-label": L("Move down", "下移"), disabled: i >= st.rules.length - 1, onclick: () => move(i, 1) }, icon("down", 20)),
          h("button", { type: "button", class: "rgb-mini on", "aria-label": L("Done", "完成"), onclick: () => { st.moving = -1; render(); } }, icon("ok", 20)));
      } else {
        right.append(
          pressable(h("span", { class: "rgb-num", title: L("Long press to move", "长按可移动") }, String(i)), { onlong: moveMode }),
          h("button", { type: "button", class: "rgb-mini", "aria-label": L("Delete this rule", "删除此指令"), onclick: () => deleteRule(i) }, icon("trash", 20)));
      }
    }
    const head = h("div", { class: "rgb-rule-head" }, name, right);

    const rows = [];
    for (const k of rowsFor(tab, i, r)) {
      if (k === "header") continue;
      if (k === "color") {
        const hx = rgbToHex(r.color);
        rows.push(row(LABEL.color, {}, h("button", { type: "button", class: "rgb-swatch", style: { background: "#" + hx },
          "aria-label": L("Colour", "颜色") + " #" + hx, title: "#" + hx, onclick: () => changeColor(i) })));
        continue;
      }
      const label = k === "addr" ? LABEL.addr[tab] : LABEL[k];
      const sel = picker({ value: r[k], options: opts(k, tab, i), label: L(label), onchange: v => setField(i, k, v) });
      // The effect picker: tab 0 = bit 15 (effect), tab 1 = addr. Both have help and the Try button.
      const isEffect = (tab === TAB.ZONE && k === "effect") || (tab === TAB.CAR && k === "addr");
      if (isEffect) {
        const tryBtn = canTry(tab, i) ? btn({ en: "Try", zh: "尝试" }, () => tryRule(i), { kind: "small green rgb-try" }) : null;
        rows.push(row(label, { help: "help_RGBEffect", helpTitle: label }, tryBtn, sel));
      } else {
        rows.push(row(label, { note: tab === TAB.CAR && k === "breathe" ? L("(new Model 3/Y)", "(焕新3Y)") : null }, sel));
      }
    }
    return h("section", { class: "card rgb-rule" + (moving ? " moving" : ""), dataset: { index: String(i) } }, head, rows);
  }

  function stateCard(text, retry) {
    return h("section", { class: "card" }, h("div", { class: "rgb-state" },
      h("p", { class: "empty" }, text),
      retry ? btn({ en: "Read again", zh: "重新读取" }, () => { st.mode = "loading"; render(); read(); }, { kind: "small" }) : null));
  }

  function render() {
    if (gone) return;
    clear(el);
    el.classList.toggle("busy", busy > 0);
    const canEdit = st.mode === "ready" && !busy;
    const tabInfo = TABS[st.tab];
    el.append(h("div", { class: "rgb-head" },
      h("div", { class: "rgb-bar" },
        h("span"),
        h("div", { class: "seg", role: "tablist" }, TABS.map(t => h("button", {
          type: "button", role: "tab", class: t.id === st.tab ? "on" : null, "aria-selected": String(t.id === st.tab),
          onclick: () => selectTab(t.id),
        }, L(t.label, t.zh)))),
        h("button", { type: "button", class: "rgb-ib add", "aria-label": L("Add a rule", "添加"), disabled: !canEdit || st.rules.length >= SLOT_COUNT, onclick: addRule }, icon("plus", 22))),
      h("div", { class: "rgb-sub" },
        helpButton("help_RGB", { en: "Ambient light", zh: "氛围灯" }),
        h("p", { class: "sub-note" }, L(tabInfo.note, tabInfo.noteZh)),
        h("button", { type: "button", class: "rgb-ib danger", "aria-label": L("Delete all rules", "删除所有指令"), disabled: !canEdit, onclick: deleteAll }, icon("trash", 24)))));

    const list = h("div", { class: "rgb-list" });
    el.append(list);
    switch (st.mode) {
      case "offline": list.append(stateCard(L("Connect to the module first.", "请先连接蓝牙"))); return;
      case "locked": list.append(stateCard(L("Enter the BLE password first.", "请先输入蓝牙密码"))); return;
      case "loading": list.append(stateCard(L("Reading…", "读取中…"))); return;
      case "noReply": list.append(stateCard(L("No reply from the module.", "模块无应答"), true)); return;
      case "noModule": list.append(stateCard(L("Install the ambient light module first.", "请先安装氛围灯模块"), true)); return;
    }
    st.rules.forEach((r, i) => list.append(ruleCard(st.tab, i, r)));
    el.append(h("p", { class: "foot" }, L(
      "Each change is written to the module at once. Long press a rule name to move the rule.",
      "每次修改会立即写入模块。长按指令名称可移动顺序。")));
  }

  return {
    el,
    title: { en: "Ambient light", zh: "氛围灯设置" },
    enter() {
      gone = false;
      offs.push(onBus("conn", s => {
        if (s.connected) return;
        st.rules = null; st.base = null; st.mode = "offline"; st.moving = -1;
        render();
      }));
      // Read after the password: only when nothing is shown and nothing is in flight (do not overwrite edits).
      offs.push(onBus("status", () => {
        if (!ready() || jobs || st.rules) return;
        if (st.mode === "offline" || st.mode === "locked") { st.mode = "loading"; render(); read(); }
      }));
      // A B9 frame with no request in flight (for example a late reply after a tab switch) is not shown.
      offs.push(onBus("frame", fr => {
        if (fr.cmd === TYPE_RGB && pendingTab == null) log(`rgb: B9 frame (${fr.payload.length} bytes) with no request in flight, ignored`, "warn");
      }));
      funlist().then(f => { groups = (f && f.btn) || []; if (!gone) render(); }).catch(() => {});
      st.mode = ready() ? "loading" : (S.link && S.link.connected ? "locked" : "offline");
      render();
      if (ready()) read();
    },
    leave() {
      gone = true;
      while (offs.length) offs.pop()();
    },
  };
});
