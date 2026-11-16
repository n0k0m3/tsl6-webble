// App core: state, router, connection, password flow and the command gate.
import { WebLink, SVC } from "./ble.js";
import { ScrlLink, GattTransport, isH2Name } from "./scrl-link.js";
import { H2_TYPE } from "../lib/h2-menus.js";
import { UUIDS as H2_UUIDS } from "../lib/scrl.js";
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
  boot: null,                // last bootloader status (module in boot mode), else null
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
// True while the link is an H2 board. The app then uses device type H2_TYPE: the pages show only what the board has.
export const isH2 = () => !!(S.link && S.link.kind === "h2");

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
  // The bootloader knows only the flash commands. Those go through the Firmware page, not through gate().
  if (link.boot) { toast(L("The module is in boot mode. Flash a runtime first (Tools > Firmware).", "模块处于升级模式，请先刷写运行固件（工具 > 固件）。"), "warn", 3000); return false; }
  if (opts.danger && !S.prefs.allowDrive) {
    await alertBox({
      en: "This control changes a driving system (motor, ESP, service mode or raw CAN). It is off by default. To use it, turn on Device > Allow driving-system controls.",
      zh: "此控制会改变驾驶相关系统（电机、ESP、维护模式或CAN发送）。默认关闭。如需使用，请在「设备」中打开「允许驾驶系统控制」。",
    }, L("Blocked", "已阻止"));
    return false;
  }
  if (opts.confirm && !(await confirmBox(opts.confirm, null, null, { focusCancel: !!opts.danger }))) return false;
  // TESTED lists the commands that the owner tested on the car with a TSL6. With the H2 board nothing is tested yet.
  const tested = TESTED.has(type) && !isH2();
  if (!tested && !READ_ONLY.has(type) && !opts.read && !S.prefs.skipUntested && !warned.has(type) && !S.mock) {
    // The H2 board gets its own commands, not the vendor bytes: say so.
    const ok = await confirmBox(isH2() ? {
      en: `${cmdName(type)} is not tested with the H2 board on a car yet. Send it?`,
      zh: `${cmdName(type)} 尚未在实车上用H2模块测试。确定发送吗？`,
    } : {
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
    S.boot = null;
    // A status read before the password has bytes 18-39 = 0 (runtime V1.0.00).
    let blank = p.length >= 40;
    for (let i = 18; i < 40 && blank; i++) if (p[i] !== 0) blank = false;
    S.blank = blank;
    bus.dispatchEvent(new CustomEvent("status", { detail: p }));
    updateChip();
    if (blank && !link.authed) askPassword("asked");
  });
  // Boot mode: the bootloader answers A0 with its own short status. Only the firmware page can use the module then.
  link.on("boot", p => {
    S.status = null;
    S.boot = p;
    bus.dispatchEvent(new CustomEvent("boot", { detail: { link, payload: p } }));
    updateChip();
    if (PAGES.firmware && !stack.some(x => x.id === "firmware")) {
      toast(L("The module is in boot mode. Flash a runtime.", "模块处于升级模式，请刷写运行固件。"), "warn", 3500);
      go("firmware");
    }
  });
  link.on("password", () => { updateChip(); askPassword("asked"); });
  link.on("auth", () => updateChip());
  // H2 board: its state for the board rows, and the pairing hint (the phone asks for the passkey, not this app).
  link.on("board", b => bus.dispatchEvent(new CustomEvent("board", { detail: b })));
  link.on("pairing", () => toast(L("Waiting for the secure link. If the phone asks for a passkey, type the 6 digits from the label on the board.",
    "等待安全连接。如手机要求配对码，请输入模块标签上的6位数字。"), "warn", 6000));
  link.on("frame", fr => bus.dispatchEvent(new CustomEvent("frame", { detail: fr })));
  link.on("state", st => {
    if (!st.connected) { S.status = null; S.boot = null; }
    // The device type follows the link: H2_TYPE for a board, else the type that the user chose for the TSL6.
    S.hwType = st.connected && link.kind === "h2" ? H2_TYPE : pref("hwType", 6);
    bus.dispatchEvent(new CustomEvent("conn", { detail: st }));
    renderTop();
  });
}

// The chooser lists the TSL6 and the H2 board. The app keeps its link until the user picked a device.
function pickDevice(all) {
  const services = [SVC, H2_UUIDS.service];
  return navigator.bluetooth.requestDevice(all ? { acceptAllDevices: true, optionalServices: services }
    : { filters: [{ services: [SVC] }, { namePrefix: "TSL" }, { namePrefix: "FFKJ" }, { services: [H2_UUIDS.service] }, { namePrefix: "SCRL-" }], optionalServices: services });
}
// A device with a name of neither kind ("Show all devices"): it is a board if it has the board service.
async function hasH2Service(device) {
  try { const server = await device.gatt.connect(); await server.getPrimaryService(H2_UUIDS.service); return true; } catch { return false; }
}

export async function connect({ all = false } = {}) {
  if (S.link && S.link.connected) return;
  // After a firmware update the board restarts, and its link connects again by itself. A second link would
  // fight with it.
  if (S.link && S.link.updating) { toast(L("The board restarts after the update. The app connects again by itself.", "模块更新后正在重启，应用会自动重新连接。"), "warn", 3500); return; }
  let link = S.link, device = null;
  try {
    if (!S.mock) {
      device = await pickDevice(all);
      const h2 = isH2Name(device.name) || (!/^(TSL|FFKJ)/.test(device.name || "") && await hasH2Service(device));
      link = h2 ? new ScrlLink(new GattTransport(device)) : new WebLink();
      if (S.link && S.link.retire) S.link.retire();
      S.link = link;
      wireLink(link);
    }
    await link.open({ all, device });
    const st = await link.readStatus();
    if (!st) {
      log("no status reply after connect: the module sent nothing back", "bad");
      toast(L("The module does not answer. See Tools > Log and capture.", "模块无应答，请查看「工具 > 日志与抓包」"), "bad", 4000);
    }
    if (S.prefs.autoGauge && S.hwType && !S.blank && !link.boot && link.kind !== "h2") go("gauge");
  } catch (e) {
    if (e && e.name === "NotFoundError") return; // user closed the chooser
    log(`connect failed: ${e.name || ""} ${e.message}`, "bad");
    if (e && e.pairing) {
      // The board dropped the link, or the pairing did not finish. The reasons need more than a toast.
      if (link && link.close) link.close();
      alertBox({
        en: `No secure link to the board (${e.message}). Check: 1. The pairing window is open: 5 minutes after power-on, or 2 minutes after a press of the board button. 2. You typed the passkey from the label on the board. 3. If this phone has an old pairing for the board, remove the board in the Bluetooth settings of the phone, then connect again.`,
        zh: `无法与模块建立安全连接（${e.message}）。请检查：1. 配对窗口已打开：上电后5分钟内，或按下模块按钮后2分钟内。2. 已输入模块标签上的配对码。3. 如手机保存了旧的配对，请在手机蓝牙设置中删除该模块后重新连接。`,
      }, L("Pairing", "配对"));
      return;
    }
    toast(L("Connect failed: ", "连接失败：") + e.message, "bad", 3500);
  }
}
export function disconnect() { if (S.link) S.link.close(); }

// ---------------------------------------------------------------- router
const PAGES = {};
export function definePage(id, def) { PAGES[id] = def; }
const TABS = [
  { id: "status", icon: "car", en: "Car", zh: "车辆" },
  { id: "settings", icon: "sliders-horizontal", en: "Settings", zh: "设置" },
  { id: "tools", icon: "wrench", en: "Tools", zh: "工具" },
  { id: "me", icon: "cpu", en: "Device", zh: "设备" },
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
export function switchTab(id) {
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
  renderTabs();
  renderTop();
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
// Top bar: on a tab root it holds the connection chip (the page shows its own large title);
// on a sub-page it holds a back button and the page title.
// The link chip: its text and lamp class from the current link state.
function chipState() {
  const link = S.link;
  const on = !!(link && link.connected);
  if (on && link.boot) return { text: L("Boot mode", "升级模式"), dot: "dot warn" };
  return { text: !on ? L("Not connected", "未连接") : !link.authed ? L("Password needed", "需要密码") : link.name, dot: "dot" + (on ? (link.authed ? " on" : " warn") : "") };
}
// Status and auth frames change only the chip. Rebuilding the whole bar on each frame lost focus and taps.
function updateChip() {
  const chip = document.querySelector("#top [data-id=conn-chip]");
  if (!chip) return renderTop();
  const st = chipState();
  chip.setAttribute("aria-label", st.text); chip.title = st.text;
  chip.querySelector(".dot").className = st.dot;
  chip.querySelector(".chip-name").textContent = st.text;
}
function renderTop() {
  const top = $("#top");
  if (!top) return;
  const c = current();
  const sub = stack.length > 1;
  const st = chipState();
  const chip = h("button", { class: "conn-chip" + (sub ? " compact" : ""), type: "button", "data-id": "conn-chip", "aria-label": st.text, title: st.text,
    onclick: () => { if (stack.length > 1) { alertBox(chipState().text, L("Connection", "连接")); return; } if (current().id !== "me") switchTab("me"); } },
    sub ? h("span", { class: "chip-bt", "aria-hidden": "true" }, icon("bluetooth", 22)) : null,
    h("span", { class: st.dot }), h("span", { class: "chip-name" }, st.text));
  // A tab root shows the tab name as the page title. A sub-page shows its own title and a link lamp.
  const tabDef = TABS.find(t => t.id === tab);
  top.classList.toggle("root", !sub);
  clear(top).append(...[
    sub ? h("button", { class: "top-back", "aria-label": L("Back", "返回"), onclick: () => history.back() }, icon("chevron-left", 24)) : h("span", { class: "top-spacer" }),
    h("h1", null, sub ? (c.page.title ? L(c.page.title) : "") : tabDef ? L(tabDef) : ""),
    chip,
    h("button", { class: "top-lang", onclick: () => setLang(getLang() === "zh" ? "en" : "zh"), "aria-label": "Language / 语言" }, getLang() === "zh" ? "EN" : "中"),
  ].filter(Boolean));
  document.title = (sub && c.page.title ? L(c.page.title) + " | " : "") + "TSL6";
}
window.addEventListener("scroll", () => { const t = $("#top"); if (t) t.classList.toggle("scrolled", window.scrollY > 8); }, { passive: true });
function renderTabs() {
  const bar = $("#tabs");
  clear(bar).append(...TABS.map(t => h("button", {
    class: "tab" + (t.id === tab ? " on" : ""), "aria-current": t.id === tab ? "page" : null, "data-id": `tab-${t.id}`,
    onclick: () => { if (t.id !== tab || stack.length > 1) switchTab(t.id); },
  }, icon(t.icon, 22), h("span", null, L(t)))),
  // Desktop sidebar brand. It is the last child, so the tab order (nth-child) does not change; CSS puts it first.
  h("div", { class: "side-brand" }, "TSL6"));
}

onLang(() => { rerender(); });

export async function start({ mock = false, MockLink, MockH2Transport } = {}) {
  setLang(getLang());
  if (mock && MockH2Transport) {
    S.mock = true;
    S.link = new ScrlLink(new MockH2Transport());
    wireLink(S.link);
    document.body.classList.add("is-mock");
  } else if (mock && MockLink) {
    S.mock = true;
    S.link = new MockLink();
    wireLink(S.link);
    document.body.classList.add("is-mock");
  }
  if (!S.mock && !WebLink.available()) log("Web Bluetooth is not available in this browser", "warn");
  // #firmware opens the firmware page over Tools (tsl6-recovery.surge.sh redirects to it). #flash is the older recovery link.
  if ((location.hash === "#firmware" || location.hash === "#flash") && PAGES.firmware) { switchTab("tools"); go("firmware"); return; }
  switchTab({ "#settings": "settings", "#tools": "tools", "#me": "me", "#device": "me" }[location.hash] || "status");
}

// Small helpers for pages.
export const statusInfo = () => (S.status ? decodeStatus(S.status) : null);
export const hexs = hex;
export { fmtTime };
