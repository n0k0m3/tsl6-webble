// Small DOM toolkit for the app. All text goes in as text nodes (no innerHTML with data).

// ---------------------------------------------------------------- language
const LANG_KEY = "tsl6.lang";
let lang = (() => { try { return localStorage.getItem(LANG_KEY) || "en"; } catch { return "en"; } })();
const langListeners = new Set();
export const getLang = () => lang;
export function setLang(l) {
  lang = l;
  try { localStorage.setItem(LANG_KEY, l); } catch { /* storage blocked */ }
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  for (const f of langListeners) f(l);
}
export const onLang = f => { langListeners.add(f); return () => langListeners.delete(f); };
// L({en, zh}) or L("en", "zh"). A missing zh falls back to en.
export function L(a, b) {
  if (a == null) return "";
  if (typeof a === "string") return lang === "zh" && b ? b : a;
  return (lang === "zh" && a.zh) || a.en || a.zh || "";
}

// ---------------------------------------------------------------- DOM
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };

// ---------------------------------------------------------------- icons (inline SVG, stroke = currentColor)
const P = {
  status: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3 2.5 3h-5L12 6Zm0 12-2.5-3h5L12 18Zm-6-6 3-2.5v5L6 12Zm12 0-3 2.5v-5L18 12Z",
  ble: "M7 7l10 10-5 4V3l5 4L7 17",
  gear: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2.1-1.6Z",
  me: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c0-3.9 3.1-6 7-6s7 2.1 7 6",
  help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  back: "M15 5l-7 7 7 7",
  left: "M15 6l-6 6 6 6", right: "M9 6l6 6-6 6", up: "M6 15l6-6 6 6", down: "M6 9l6 6 6-6",
  ok: "M5 12.5l4.5 4.5L19 7",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5",
  plus: "M12 5v14M5 12h14",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  camp: "M3 19l9-14 9 14H3Zm9-14v14m-3 0 3-5 3 5",
  queen: "M4 15c3 0 4-5 8-5s4 3 8 3M6 15l-1 4M17 13l1 6M9 8a2 2 0 1 0 0-.01",
  doorFL: "M8 4h7l3 4v11a1 1 0 0 1-1 1H8V4Zm0 0L5 7v10l3 3M14 13h2",
  doorFR: "M16 4H9L6 8v11a1 1 0 0 0 1 1h9V4Zm0 0 3 3v10l-3 3M8 13h2",
  doorRL: "M8 4h9a1 1 0 0 1 1 1v15H8V4Zm0 0L5 8v8l3 4M14 12h2",
  doorRR: "M16 4H7a1 1 0 0 0-1 1v15h10V4Zm0 0 3 4v8l-3 4M8 12h2",
  frunk: "M4 15l2-6h12l2 6v3H4v-3Zm2-6 1-3h10l1 3M7 15h2m6 0h2",
  trunk: "M4 9h16v9H4V9Zm2 0 2-4h8l2 4m-8 3v3",
  glove: "M4 7h16v11H4V7Zm0 4h16M10 14h4",
  mirror: "M5 8c0-2 2-3 4-3h6c2 0 4 1 4 3v5c0 2-2 3-4 3H9c-2 0-4-1-4-3V8Zm7 8v4",
  unlock: "M7 11V8a5 5 0 0 1 9.6-2M5 11h14v9H5v-9Zm7 3v3",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5v-9Zm7 3v3",
  power: "M12 3v8M7 6a7 7 0 1 0 10 0",
  battery: "M4 8h14v8H4V8Zm14 3h2v2h-2M7 11h5",
  gauge: "M4 16a8 8 0 1 1 16 0M12 16l4-5M8 16h.01M16 16h.01",
  log: "M6 4h12v16H6V4Zm3 4h6M9 12h6M9 16h4",
  flash: "M13 3 5 14h6l-1 7 8-11h-6l1-7Z",
};
export function icon(name, size = 20) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("width", size); s.setAttribute("height", size);
  s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", P[name] || P.help);
  s.append(p);
  return s;
}

// ---------------------------------------------------------------- toast
let toastTimer = 0;
export function toast(text, kind = "", ms = 1800) {
  let t = document.getElementById("toast");
  if (!t) { t = h("div", { id: "toast", role: "status", "aria-live": "polite" }); document.body.append(t); }
  t.textContent = typeof text === "object" ? L(text) : text;
  t.className = "show " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, ms);
}

// ---------------------------------------------------------------- dialogs
// Returns a promise. buttons: [{label, value, kind}]. Content: string, {en, zh} or Node.
export function dialog({ title, body, buttons, wide = false, focusCancel = false }) {
  return new Promise(resolve => {
    const prev = document.activeElement;
    const close = v => { back.remove(); document.removeEventListener("keydown", onKey); if (prev && prev.focus) prev.focus(); resolve(v); };
    const onKey = e => { if (e.key === "Escape") close(null); };
    const content = typeof body === "function" ? body(close)
      : body instanceof Node ? body : h("p", { class: "dlg-text" }, typeof body === "object" ? L(body) : body);
    const btns = (buttons || [{ label: L("OK", "确定"), value: true, kind: "primary" }]).map(b =>
      h("button", { class: "dlg-btn " + (b.kind || ""), onclick: () => close(b.value) }, b.label));
    const box = h("div", { class: "dlg" + (wide ? " wide" : ""), role: "dialog", "aria-modal": "true" },
      title ? h("h3", null, typeof title === "object" ? L(title) : title) : null,
      h("div", { class: "dlg-body" }, content),
      h("div", { class: "dlg-btns" }, btns));
    // Close on a backdrop tap only if the press also started on the backdrop. A long press can open a dialog
    // while the finger is still down; the click from that finger must not close it at once.
    let downOnBack = false;
    const back = h("div", { class: "dlg-back", onclick: e => { if (e.target === back && downOnBack) close(null); downOnBack = false; } }, box);
    back.addEventListener("pointerdown", e => { downOnBack = e.target === back; });
    document.body.append(back);
    document.addEventListener("keydown", onKey);
    ((!focusCancel && box.querySelector(".dlg-btn.primary")) || btns[0]).focus();
  });
}
export const alertBox = (body, title) => dialog({ title: title || L("Notice", "提示"), body });
export const confirmBox = (body, title, okLabel, { focusCancel = false } = {}) => dialog({
  title: title || L("Notice", "提示"), body, focusCancel,
  buttons: [{ label: L("Cancel", "取消"), value: false }, { label: okLabel || L("OK", "确定"), value: true, kind: "primary" }],
}).then(v => v === true);

// Prompt with one text input. Resolves the string or null.
export function promptBox({ title, label, value = "", placeholder = "", maxlength, type = "text" }) {
  // iPhone keyboards may capitalise or autocorrect a short word. Turn both off (a password must go out as typed).
  const inp = h("input", { class: "dlg-input", type, value, placeholder, maxlength, autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false" });
  const body = h("div", null, label ? h("p", { class: "dlg-text" }, label) : null, inp);
  const p = dialog({ title, body, buttons: [{ label: L("Cancel", "取消"), value: null }, { label: L("OK", "确定"), value: "ok", kind: "primary" }] });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") inp.closest(".dlg").querySelector(".dlg-btn.primary").click(); });
  setTimeout(() => inp.focus(), 30);
  return p.then(v => (v === "ok" ? inp.value : null));
}

// ---------------------------------------------------------------- help texts (data/help.json)
let helpData = null;
async function loadHelp() {
  if (!helpData) {
    try { helpData = await (await fetch(new URL("../data/help.json", import.meta.url))).json(); }
    catch { helpData = {}; }
  }
  return helpData;
}
const STYLE = { g: "hl-g", o: "hl-o", r: "hl-r", b: "hl-b" };
export function helpNode(entry) {
  const paras = (entry && (lang === "zh" ? entry.zh : entry.en || entry.zh)) || [];
  return h("div", { class: "help" }, paras.map(p =>
    h("div", { class: "help-p" }, p.map(line =>
      h("p", null, line.length ? line.map(([st, tx]) => (st ? h("span", { class: STYLE[st] || "" }, tx) : tx)) : " ")))));
}
export async function showHelp(id, title) {
  const d = await loadHelp();
  const e = d[id];
  return dialog({ title, wide: true, body: e ? helpNode(e) : h("p", { class: "dlg-text" }, L("No help text for this item.", "此项暂无帮助说明。")) });
}
export function helpButton(id, title) {
  return h("button", { class: "help-btn", type: "button", "aria-label": L("Help", "帮助") + ": " + (typeof title === "object" ? L(title) : title),
    onclick: e => { e.stopPropagation(); showHelp(id, typeof title === "object" ? L(title) : title); } }, "?");
}

// ---------------------------------------------------------------- list building blocks
export function section(title, ...rows) {
  return h("section", { class: "card" }, title ? h("h2", { class: "card-head" }, typeof title === "object" ? L(title) : title) : null, rows);
}
// Row: label (+ help) on the left, controls on the right.
export function row(label, { help, helpTitle, note, cls, onlabel } = {}, ...controls) {
  const lab = h("span", { class: "row-label" }, typeof label === "object" ? L(label) : label);
  if (onlabel) lab.addEventListener("click", onlabel);
  return h("div", { class: "row " + (cls || "") },
    h("div", { class: "row-left" }, lab, help ? helpButton(help, helpTitle || label) : null,
      note ? h("span", { class: "row-note" }, note) : null),
    h("div", { class: "row-right" }, controls));
}

// Switch. state: true/false/null (unknown). onchange(newValue) returns a promise; the switch shows "busy" until it settles.
export function toggle({ checked, disabled, label, onchange }) {
  const b = h("button", { class: "switch", role: "switch", type: "button", "aria-checked": String(!!checked), "aria-label": label, disabled });
  if (checked == null) b.classList.add("unknown");
  b.addEventListener("click", async () => {
    if (b.classList.contains("busy")) return;
    const want = b.getAttribute("aria-checked") !== "true";
    b.classList.add("busy");
    try { await onchange(want); } finally { b.classList.remove("busy"); }
  });
  b.set = v => { b.setAttribute("aria-checked", String(!!v)); b.classList.toggle("unknown", v == null); };
  return b;
}

// Option sheet, as in the vendor app: a button shows the value; a tap opens a list titled with the row name.
// (A native <select> kept focus on iPhone while the page rebuilt, and the save stalled until the next tap.)
// options: [[value, label]]. text: fixed button text (for the "..." sub picker). Returns the button; .value is a string.
export function chooseOption({ title, options, value }) {
  return dialog({
    title, wide: false,
    buttons: [{ label: L("Cancel", "取消"), value: null }],
    body: close => {
      const list = h("div", { class: "opt-list", role: "listbox" }, options.map(([v, t]) => {
        const on = String(v) === String(value);
        return h("button", { class: "opt" + (on ? " on" : ""), type: "button", role: "option", "data-v": String(v), "aria-selected": String(on), onclick: () => close(v) },
          h("span", null, t), h("span", { class: "opt-ok", "aria-hidden": "true" }, on ? "✓" : ""));
      }));
      setTimeout(() => { const c = list.querySelector(".opt.on"); if (c) c.scrollIntoView({ block: "center" }); }, 0);
      return list;
    },
  });
}
export function picker({ value, options, onchange, disabled, label, text }) {
  let cur = value;
  const b = h("button", { class: "picker", type: "button", disabled, "aria-label": label, "aria-haspopup": "dialog", title: label });
  const draw = () => {
    if (text != null) { b.textContent = text; return; }
    const o = options.find(([v]) => String(v) === String(cur));
    b.textContent = o ? o[1] : cur == null ? "—" : `? (${cur})`;
  };
  Object.defineProperty(b, "value", { get: () => String(cur), set: v => { cur = v; draw(); } });
  draw();
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    const v = await chooseOption({ title: label, options, value: cur });
    if (v == null || String(v) === String(cur)) return;
    cur = v; draw();
    setTimeout(() => onchange(Number(v), b), 0); // run the save after the sheet is gone
  });
  return b;
}

export function btn(label, onclick, { kind = "", disabled, title, color } = {}) {
  return h("button", { class: "btn " + kind, type: "button", onclick, disabled, title, style: color ? { color } : null },
    typeof label === "object" && !(label instanceof Node) ? L(label) : label);
}
export function iconBtn(name, onclick, { label, disabled, text } = {}) {
  return h("button", { class: "ibtn", type: "button", onclick, disabled, "aria-label": label, title: label }, text != null ? h("b", null, text) : icon(name, 22));
}

// Long press on an element. Calls onlong after ms, else ontap on release.
// iPhone can send pointercancel at about 500 ms when it starts its own touch-and-hold handling, so a cancel does
// not stop the timer. A move of more than 10 px, a page scroll or a release does. skip: presses that start on
// these elements (for example the "?" button) are ignored.
export function pressable(el, { ontap, onlong, ms = 400, skip = "button, .help-btn" }) {
  let t = 0, long = false, x0 = 0, y0 = 0;
  const end = () => { clearTimeout(t); t = 0; window.removeEventListener("scroll", end, true); };
  el.addEventListener("pointerdown", e => {
    if (skip && e.target.closest && e.target.closest(skip) && e.target.closest(skip) !== el) return;
    long = false; end(); x0 = e.clientX; y0 = e.clientY;
    window.addEventListener("scroll", end, true);
    t = setTimeout(() => { t = 0; long = true; window.removeEventListener("scroll", end, true); onlong && onlong(); }, ms);
  });
  el.addEventListener("pointermove", e => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) end(); });
  el.addEventListener("pointerup", end);
  el.addEventListener("click", e => { if (long) { e.preventDefault(); e.stopImmediatePropagation(); long = false; return; } ontap && ontap(e); });
  el.addEventListener("contextmenu", e => e.preventDefault());
  return el;
}

// Hold button: onpress on pointerdown, onrelease exactly once when the press ends for any reason.
export const HOLD_MAX_MS = 15000;
export function holdButton(el, { onpress, onrelease, maxMs = HOLD_MAX_MS }) {
  let held = false, guard = 0;
  const release = () => {
    if (!held) return;
    held = false; clearTimeout(guard); el.classList.remove("held");
    onrelease();
  };
  const press = () => {
    if (held) return;
    held = true; el.classList.add("held");
    guard = setTimeout(release, maxMs); // safety: never leave a car action running if every end event is lost
    onpress();
  };
  el.addEventListener("pointerdown", e => {
    try { el.setPointerCapture(e.pointerId); } catch { /* old browser */ }
    press();
  });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, release);
  el.addEventListener("contextmenu", e => e.preventDefault());
  // iPhone: block the native long-press gestures (selection, magnifier, callout) on hold buttons.
  // iPhone also failed to send pointerup after a hold (car test 2026-11-14), so the touch events press and release too.
  el.addEventListener("touchstart", e => { if (e.cancelable) e.preventDefault(); press(); }, { passive: false });
  el.addEventListener("touchend", e => { if (e.cancelable) e.preventDefault(); release(); }, { passive: false });
  el.addEventListener("touchcancel", release);
  el.release = release;
  return el;
}

export function fmtTime(d) { return d.toTimeString().slice(0, 8); }
// iPhone browsers (Bluefy, BLE Link) ignore <a download>. There the app uses the share sheet if it can share
// files, else it shows the text with a Copy button. Restore can then paste the text back.
const IOS = typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

async function copyText(text, area) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  try { area.focus(); area.select(); area.setSelectionRange(0, text.length); return document.execCommand("copy"); } catch { return false; }
}

function textDialog(name, text) {
  const area = h("textarea", { class: "dlg-area", readonly: true, rows: 8 });
  area.value = text;
  return dialog({
    title: name, wide: true,
    body: close => h("div", null,
      h("p", { class: "dlg-text" }, L("This browser cannot save files. Copy the text and keep it, for example in Notes or Files.",
        "此浏览器无法保存文件。请复制以下文本并保存（例如备忘录或文件）。")),
      area,
      h("div", { class: "dlg-row" }, h("button", { class: "btn primary", type: "button", onclick: async () => {
        toast(await copyText(text, area) ? L("Copied", "已复制") : L("Copy failed. Select the text by hand.", "复制失败，请手动选择文本"), "ok");
      } }, L("Copy", "复制")))),
    buttons: [{ label: L("Close", "关闭"), value: null }],
  });
}

export async function download(name, text, type = "application/json") {
  if (IOS) {
    try {
      const file = new File([text], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    return textDialog(name, text);
  }
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function fileInput(accept, resolve) {
  const i = h("input", { type: "file", accept, style: { display: "none" } });
  i.addEventListener("change", async () => { const f = i.files[0]; i.remove(); resolve(f ? await f.text() : null); });
  document.body.append(i); i.click();
}

// Resolves the text of a file (or pasted text on iPhone), or null.
export function pickFile(accept = ".json,application/json") {
  if (!IOS) return new Promise(resolve => fileInput(accept, resolve));
  return new Promise(resolve => {
    const area = h("textarea", { class: "dlg-area", rows: 6, placeholder: L("Paste the backup text here", "在此粘贴备份文本") });
    dialog({
      title: L("Restore from", "恢复来源"), wide: true,
      body: close => h("div", null,
        h("div", { class: "dlg-row" }, h("button", { class: "btn", type: "button", onclick: () => {
          fileInput(accept, resolve);           // opened inside the tap: iOS allows the file picker only here
          close("file");
        } }, L("Choose file", "选择文件"))),
        h("p", { class: "dlg-text" }, L("or paste the text that you copied:", "或粘贴之前复制的文本：")),
        area),
      buttons: [{ label: L("Cancel", "取消"), value: null }, { label: L("Use pasted text", "使用粘贴的文本"), value: "paste", kind: "primary" }],
    }).then(v => {
      if (v === "paste") resolve(area.value.trim() || null);
      else if (v !== "file") resolve(null);
    });
  });
}
