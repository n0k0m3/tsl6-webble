// App core: state, router, connection, password flow and the command gate.
import { WebLink } from "./ble.js";
import { h, clear, L, getLang, setLang, onLang, icon, toast, dialog, alertBox, confirmBox, promptBox, fmtTime } from "./ui.js";
import { decodeStatus, hex } from "../lib/tsl6-settings.js";

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- persistent prefs
function pref(key, def) { try { const v = localStorage.getItem("tsl6." + key); return v == null ? def : JSON.parse(v); } catch { return def; } }
function setPref(key, v) { try { localStorage.setItem("tsl6." + key, JSON.stringify(v)); } catch { /* storage blocked */ } }

export const S = {
  link: null,
  mock: false,
  status: null,              // last status payload
  hwType: pref("hwType", 6), // the runtime sends 0 in byte 0; the vendor gets the type from its server
  prefs: {
    allowDrive: pref("allowDrive", false),       // motor off, ESP off, service mode, raw CAN send
    skipUntested: pref("skipUntested", false),   // no first-use warning for untested commands
    lab: pref("lab", false),                     // show lab settings rows
    autoGauge: pref("autoGauge", false),
  },
  funlist: null,
  logLines: [],
};
export function savePref(k, v) { S.prefs[k] = v; setPref(k, v); }
export function setHwType(t) { S.hwType = t; setPref("hwType", t); }

// ---------------------------------------------------------------- log
const LOG_MAX = 3000;
export function log(msg, cls = "") {
  S.logLines.push({ t: new Date(), msg, cls });
  if (S.logLines.length > LOG_MAX) S.logLines.splice(0, S.logLines.length - LOG_MAX);
  bus.dispatchEvent(new CustomEvent("log"));
}
export const bus = new EventTarget();
export const onBus = (type, fn) => { const f = e => fn(e.detail); bus.addEventListener(type, f); return () => bus.removeEventListener(type, f); };

// ---------------------------------------------------------------- function list (data/funlist.json)
export async function funlist() {
  if (!S.funlist) {
    try { S.funlist = await (await fetch(new URL("../data/funlist.json", import.meta.url))).json(); }
    catch { S.funlist = { btn: [], fun: [] }; }
  }
  return S.funlist;
}
// Group list with names in the current language: [{name, data:[{val, name, title}]}]
export function localGroups(groups) {
  return (groups || []).map(g => ({
    name: L({ en: g.name_en, zh: g.name }),
    data: g.data.map(it => ({ ...it, label: L({ en: it.name_en, zh: it.name }), help: L({ en: it.title_en, zh: it.title }) })),
  }));
}

// ---------------------------------------------------------------- command gate
// Commands that the owner tested on the car. Others get a one-time warning per session.
const TESTED = new Set([0xa0, 0xa3, 0xa8]);
const warned = new Set();
const NAMES = {
  0xa1: ["AP assist on/off (A1)", "AP辅助开关 (A1)"], 0xa2: ["Simulated wheel (A2)", "模拟滚轮 (A2)"], 0xa4: ["Restore defaults (A4)", "恢复默认 (A4)"],
  0xa5: ["Restart module (A5)", "重启模块 (A5)"], 0xa6: ["AP resume state (A6)", "AP恢复状态 (A6)"], 0xa7: ["Car control (A7)", "车辆控制 (A7)"],
  0xa9: ["Change password (A9)", "修改密码 (A9)"], 0xab: ["Shortcut table (AB)", "快捷指令 (AB)"], 0xb0: ["Gauge stream (B0)", "仪表数据 (B0)"],
  0xb9: ["Ambient light table (B9)", "氛围灯 (B9)"], 0xba: ["BLE button table (BA)", "蓝牙按钮 (BA)"], 0xbb: ["Run an action now (BB)", "执行指令 (BB)"],
  0xc0: ["CAN debug (C0)", "数据调试 (C0)"], 0xc1: ["Vehicle type query (C1)", "车型查询 (C1)"], 0xd0: ["Battery info (D0)", "电池信息 (D0)"],
  0xf0: ["BLE host pairing (F0)", "蓝牙配对 (F0)"],
};
export const cmdName = t => L(...(NAMES[t] || [`Command ${t.toString(16).toUpperCase()}`]));

// Read-only commands: no warning at all.
const READ_ONLY = new Set([0xa0, 0xc1]);

// Gate and send one frame. opts:
//   danger: "drive" | "service" | "cantx" -> needs prefs.allowDrive
//   confirm: {en, zh} text, asked first (vendor dialog)
//   read: true -> a read request (AB 02 etc.); skips the untested warning
//   quiet: true -> no toast on errors
// Returns true if the frame went out.
export async function gate(type, opts = {}) {
  const link = S.link;
  if (!link || !link.connected) { toast(L("Connect to the module first.", "请先连接蓝牙")); return false; }
  if (opts.danger && !S.prefs.allowDrive) {
    await alertBox({
      en: "This control changes a driving system (motor, ESP, service mode or raw CAN). It is off by default. To use it, open Me > Advanced and turn on \"Allow driving-system controls\".",
      zh: "此控制会改变驾驶相关系统（电机、ESP、维护模式或CAN发送）。默认关闭。如需使用，请在「我的 > 高级」中打开「允许驾驶系统控制」。",
    }, L("Blocked", "已阻止"));
    return false;
  }
  if (opts.confirm && !(await confirmBox(opts.confirm, null, null, { focusCancel: !!opts.danger }))) return false;
  if (!TESTED.has(type) && !READ_ONLY.has(type) && !opts.read && !S.prefs.skipUntested && !warned.has(type) && !S.mock) {
    const ok = await confirmBox({
      en: `${cmdName(type)} is not tested on a car yet. The app sends the same bytes as the vendor app. Send it?`,
      zh: `${cmdName(type)} 尚未在实车上测试。本应用发送与原厂小程序相同的数据。确定发送吗？`,
    }, L("Untested command", "未测试的指令"), L("Send", "发送"));
    if (!ok) return false;
    warned.add(type);
  }
  return true;
}

export async function send(type, payload = new Uint8Array(0), opts = {}) {
  if (!(await gate(type, opts))) return false;
  try { await S.link.send(type, payload); return true; }
  catch (e) { if (!opts.quiet) toast(L("Send failed: ", "发送失败：") + e.message, "bad", 3000); log(`send failed: ${e.message}`, "bad"); return false; }
}
// Gate, send, wait for a reply. Returns the reply frame or null.
export async function ask(type, payload = new Uint8Array(0), opts = {}) {
  if (!(await gate(type, opts))) return null;
  try {
    const r = await S.link.request(type, payload, { timeout: opts.timeout || 2500, tries: opts.tries || 1, reply: opts.reply || [type], accept: opts.accept });
    if (!r && !opts.quiet) toast(L("No reply from the module.", "模块无应答"), "warn", 2500);
    return r;
  } catch (e) { if (!opts.quiet) toast(L("Send failed: ", "发送失败：") + e.message, "bad", 3000); return null; }
}

// Re-read the status shortly after a command that changes it.
let rereadTimer = 0;
export function rereadSoon(ms = 400) {
  clearTimeout(rereadTimer);
  rereadTimer = setTimeout(() => { if (S.link && S.link.connected) S.link.readStatus().catch(() => {}); }, ms);
}

// ---------------------------------------------------------------- connection
let pwPrompting = false;
export async function askPassword(reason = "manual") {
  if (pwPrompting || !S.link) return;
  pwPrompting = true;
  try {
    const saved = S.link.savedPassword();
    if (saved && reason === "asked") {
      log("sending the saved BLE password");
      if (await S.link.sendPassword(saved)) { await afterAuth(); return; }
      S.link.forgetPassword();
    }
    for (;;) {
      const key = await promptBox({
        title: L("BLE password", "蓝牙密码"),
        label: L("Enter the BLE password (default: 1234).", "请输入蓝牙密码(默认:1234)"),
        maxlength: 4, placeholder: "1234",
      });
      if (key == null) return;
      if (!/^[\x20-\x7e]{4}$/.test(key)) { toast(L("The password must have 4 characters.", "密码必须是4位字符"), "bad"); continue; }
      if (await S.link.sendPassword(key)) { toast(L("Password OK", "蓝牙密码正确"), "ok"); await afterAuth(); return; }
      const codes = Array.from(key, c => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")).join(" ");
      if (S.link.lastPasswordResult === "timeout") {
        await alertBox(L(`No reply from the module to the password. Sent: "${key}" (${codes}).`, `模块未应答密码。已发送："${key}"（${codes}）`));
      } else {
        await alertBox(L(`Wrong BLE password. The module rejected "${key}" (${codes}). Check upper and lower case.`,
          `蓝牙密码错误。模块拒绝了 "${key}"（${codes}），请检查大小写。`));
      }
    }
  } finally { pwPrompting = false; }
}
async function afterAuth() { await sleep(150); try { await S.link.readStatus(); } catch { /* shown by the link */ } }

function wireLink(link) {
  link.on("log", d => log(d.msg, d.cls));
  link.on("status", p => {
    S.status = p;
    // A status read before the password has bytes 18-39 = 0 (runtime V1.0.00).
    let blank = p.length >= 40;
    for (let i = 18; i < 40 && blank; i++) if (p[i] !== 0) blank = false;
    S.blank = blank;
    bus.dispatchEvent(new CustomEvent("status", { detail: p }));
    if (blank && !link.authed) askPassword("asked");
  });
  link.on("password", () => askPassword("asked"));
  link.on("frame", fr => bus.dispatchEvent(new CustomEvent("frame", { detail: fr })));
  link.on("state", st => {
    if (!st.connected) { S.status = null; }
    bus.dispatchEvent(new CustomEvent("conn", { detail: st }));
    renderTop();
  });
}

export async function connect({ all = false } = {}) {
  if (S.link && S.link.connected) return;
  const link = S.mock ? S.link : new WebLink();
  if (!S.mock) { S.link = link; wireLink(link); }
  try {
    await link.open({ all });
    const st = await link.readStatus();
    if (!st) {
      log("no status reply after connect: the module sent nothing back", "bad");
      toast(L("The module does not answer. See Me > Log and capture.", "模块无应答，请查看「我的 > 日志与抓包」"), "bad", 4000);
    }
    if (S.prefs.autoGauge && S.hwType && !S.blank) go("gauge");
  } catch (e) {
    if (e && e.name === "NotFoundError") return; // user closed the chooser
    log(`connect failed: ${e.name || ""} ${e.message}`, "bad");
    toast(L("Connect failed: ", "连接失败：") + e.message, "bad", 3500);
  }
}
export function disconnect() { if (S.link) S.link.close(); }

// ---------------------------------------------------------------- router
const PAGES = {};
export function definePage(id, def) { PAGES[id] = def; }
const TABS = [
  { id: "status", icon: "status", en: "Status", zh: "状态" },
  { id: "connect", icon: "ble", en: "Bluetooth", zh: "蓝牙" },
  { id: "settings", icon: "gear", en: "Settings", zh: "设置" },
  { id: "me", icon: "me", en: "Me", zh: "我的" },
];
let stack = [];      // [{id, page}]
let tab = "status";

function current() { return stack[stack.length - 1]; }

function mount(id, params) {
  const def = PAGES[id];
  if (!def) throw new Error("no page " + id);
  const page = def(params || {});
  page.id = id;
  return page;
}
function leaveTop() { const c = current(); if (c && c.page.leave) try { c.page.leave(); } catch (e) { log(`leave ${c.id}: ${e.message}`, "bad"); } }

export function go(id, params) {
  leaveTop();
  stack.push({ id, params, page: mount(id, params) });
  show();
  history.pushState({ depth: stack.length }, "");
}
export function back() {
  if (stack.length <= 1) return;
  leaveTop();
  stack.pop();
  show(true);
}
function switchTab(id) {
  leaveTop();
  tab = id;
  stack = [{ id, page: mount(id) }];
  show();
}
function show(reuse = false) {
  const c = current();
  if (reuse && c.page.refresh) c.page.refresh();
  const main = $("#page");
  clear(main).append(c.page.el);
  if (c.page.enter) try { c.page.enter(); } catch (e) { log(`enter ${c.id}: ${e.message}`, "bad"); }
  main.scrollTop = 0; window.scrollTo(0, 0);
  renderTop();
  renderTabs();
}
// Rebuild the current page (language change or a big state change).
export function rerender() {
  const c = current();
  if (!c) return;
  leaveTop();
  c.page = mount(c.id, c.params);
  show();
}
window.addEventListener("popstate", () => { if (stack.length > 1) back(); });

// ---------------------------------------------------------------- chrome
function renderTop() {
  const top = $("#top");
  if (!top) return;
  const c = current();
  const sub = stack.length > 1;
  const link = S.link;
  const state = !link || !link.connected ? L("Not connected", "蓝牙未连接") : L("BLE connected", "蓝牙已连接");
  const title = sub && c.page.title ? L(c.page.title) : (c && c.id === "me" ? L("Me", "我的") : state);
  clear(top).append(
    sub ? h("button", { class: "top-back", "aria-label": L("Back", "返回"), onclick: () => history.back() }, icon("back", 22)) : h("span", { class: "top-spacer" }),
    h("h1", null, title, link && link.connected ? null : (sub ? null : h("span", { class: "dot off", title: state }))),
    h("button", { class: "top-lang", onclick: () => setLang(getLang() === "zh" ? "en" : "zh"), "aria-label": "Language / 语言" }, getLang() === "zh" ? "EN" : "中"),
  );
  document.title = (sub && c.page.title ? L(c.page.title) + " · " : "") + "TSL6";
}
function renderTabs() {
  const bar = $("#tabs");
  clear(bar).append(...TABS.map(t => h("button", {
    class: "tab" + (t.id === tab ? " on" : ""), "aria-current": t.id === tab ? "page" : null,
    onclick: () => { if (t.id !== tab || stack.length > 1) switchTab(t.id); },
  }, icon(t.icon, 24), h("span", null, L(t)))));
}

onLang(() => { rerender(); });

export async function start({ mock = false, MockLink } = {}) {
  setLang(getLang());
  if (mock && MockLink) {
    S.mock = true;
    S.link = new MockLink();
    wireLink(S.link);
    document.body.classList.add("is-mock");
  }
  if (!S.mock && !WebLink.available()) log("Web Bluetooth is not available in this browser", "warn");
  switchTab(location.hash === "#settings" ? "settings" : location.hash === "#me" ? "me" : "status");
}

// Small helpers for pages.
export const statusInfo = () => (S.status ? decodeStatus(S.status) : null);
export const hexs = hex;
export { fmtTime };
