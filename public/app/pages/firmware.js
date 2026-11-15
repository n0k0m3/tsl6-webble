// Firmware: flash a runtime image on the app's own BLE link. It replaces the earlier flasher page (flash.html).
// The flash frames go straight to link.request. They never pass gate(): its "untested command" dialog
// would use up the 10 s boot window.
// The session (image, armed flash, progress) lives at module scope. A language change mounts a new page,
// and Back or a tab switch leaves it; the flash goes on and the page shows it again on return.
import { h, L, icon, clear } from "../ui.js";
import { S, definePage, onBus, connect, go, log } from "../app.js";
import { decodeStatus } from "../../lib/tsl6-settings.js";
import { formatVersion } from "../../lib/tsl6-status.js";
import {
  inRuntime, inBoot, uid14, lhex, inspectImage, origPassOk, fetchSecured, fetchPrompt, fetchStock,
  flashPages, requestRestart, reconnectFast, SAFE_CHUNK,
} from "../../lib/tsl6-flash.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ARMED_MS = 60000;
const RESCUE_MS = 180000; // rescue arm: time to power-cycle the module and pick TSL6-BOOT

// ---------------------------------------------------------------- session
const F = {
  image: null,      // {pages (null if rejected), problems, lines, sha} | {error: {en, zh}}
  confirm: false,
  modId: "",
  origPass: "",
  showAll: false,
  armed: false, armedUntil: 0,
  restarting: false, // the link dropped after the runtime 0x55; a runtime status now means the boot window passed
  busy: false,
  done: 0, total: 0,
  msg: null,        // {en, zh, cls}
};
const ev = new EventTarget();
const changed = () => ev.dispatchEvent(new Event("change"));
const say = (en, zh, cls = "") => { F.msg = { en, zh: zh || en, cls }; changed(); };
const imageError = (en, zh) => { F.image = { error: { en, zh } }; changed(); };

async function accept(buf, source) {
  F.image = null;
  try {
    const r = await inspectImage(buf, source);
    F.image = r;
    if (r.problems.length) log(`image rejected: ${r.problems.join("; ")}`, "bad");
    else log(`image loaded: ${source}, ${r.pages.length} pages, sha256 ${r.sha.slice(0, 16)}...`, "ok");
  } catch (e) {
    imageError(`error: ${e.message}`, `错误：${e.message}`);
    log(`image error: ${e.message}`, "bad");
  }
  changed();
}

async function loadSecured() {
  F.busy = true; changed();
  try { const { buf } = await fetchSecured(); await accept(buf, "runtime-nokey.bin"); }
  catch (e) { log(`secured build: ${e.message}`, "bad"); imageError(`Secured build failed: ${e.message}`, `安全版加载失败：${e.message}`); }
  F.busy = false; changed();
}
async function loadPrompt() {
  F.busy = true; changed();
  try { const { buf } = await fetchPrompt(); await accept(buf, "runtime-prompt.bin"); }
  catch (e) { log(`prompt build: ${e.message}`, "bad"); imageError(`Prompt build failed: ${e.message}`, `提示版加载失败：${e.message}`); }
  F.busy = false; changed();
}
async function loadOriginal() {
  F.busy = true; changed();
  try {
    if (!(await origPassOk(F.origPass))) throw new Error("wrong passphrase");
    const { buf, url } = await fetchStock(log);
    await accept(buf, url);
  } catch (e) { log(`original build: ${e.message}`, "bad"); imageError(`Original build not loaded: ${e.message}`, `原版未加载：${e.message}`); }
  F.busy = false; changed();
}

async function runFlash(link) {
  F.busy = true; changed();
  let lock = null;
  try { lock = await navigator.wakeLock?.request("screen"); } catch (_) { /* no wake lock */ }
  try {
    if (!inBoot(link.boot)) throw new Error("the module is not in boot mode. Read the status first");
    F.total = F.image.pages.length; F.done = 0;
    await flashPages(link, F.image.pages, uid14(F.modId), {
      onPage: (done, total, secs) => { F.done = done; say(`page ${done}/${total}  (${secs.toFixed(1)} s)`, `第 ${done}/${total} 页（${secs.toFixed(1)} 秒）`); },
    });
    say("Done. Unplug the module for 10 s and plug it in. Then connect again.", "完成。请拔下模块 10 秒后再插上，然后重新连接。", "ok");
  } catch (e) { log(e.message, "bad"); say(e.message, e.message, "bad"); }
  try { await lock?.release(); } catch (_) { /* already released */ }
  F.busy = false; changed();
}

// The bootloader answered. If a one-step flash is armed, start it on the link that saw boot mode
// (a manual Connect makes a new link while the reconnect loop may still run).
async function runArmedFlash(link) {
  if (!F.armed) return;
  if (Date.now() > F.armedUntil) { F.armed = false; log("armed flash expired", "warn"); changed(); return; }
  F.armed = false; F.restarting = false;
  log("boot mode seen: starting the flash now", "ok");
  await runFlash(link);
}

// One step: runtime 0x55 restarts into boot mode; reconnect at once; the boot status starts the armed flash.
async function startAuto() {
  const link = S.link;
  if (!link || !inRuntime(link.status) || !F.image || !F.image.pages) return;
  F.armed = true; F.armedUntil = Date.now() + ARMED_MS; F.restarting = false;
  // The earlier page disarmed on the next connect after the expiry. Here a timer does it, so the button comes back.
  setTimeout(() => { if (F.armed && Date.now() > F.armedUntil) { F.armed = false; F.restarting = false; log("armed flash expired", "warn"); changed(); } }, ARMED_MS + 100);
  F.modId = "";
  F.busy = true; changed();
  try {
    await requestRestart(link, link.status);
    say("Restarting into boot mode. Reconnecting...", "正在重启进入升级模式，正在重新连接...");
  } catch (e) { log(`enter boot mode: ${e.message}`, "bad"); }
  const ok = await reconnectFast({
    attach: async () => { await link.reconnect(); await link.readStatus(); },
    connected: () => link.connected,
    keepGoing: () => F.armed && S.link === link,
    close: () => { if (S.link === link) link.close(); }, // never close a link that a manual Connect replaced
    log, sleep,
    // As in the earlier page, only a status after the drop (a reconnect) can say that the boot window passed.
    onDropped: () => { F.restarting = F.restarting || !link.connected; F.busy = false; changed(); },
  });
  if (F.armed && !ok && S.link === link) say("Tap Connect now and pick TSL6-BOOT. The flash starts by itself.", "请立即点“连接”并选择 TSL6-BOOT，刷写会自动开始。", "warn");
  changed();
}

// Rescue: arm the flash with no runtime link. A runtime that stores boot mode 1 (safe-boot build)
// makes the bootloader wait 10 s in TSL6-BOOT at every power-on. The user power-cycles the module and
// picks TSL6-BOOT; its status starts the flash at once (runArmedFlash), inside the 10 s.
function toggleRescue() {
  if (F.armed) {
    F.armed = false; F.restarting = false;
    log("armed flash cancelled", "warn"); say("Cancelled.", "已取消。"); return;
  }
  if (!F.image || !F.image.pages || !F.confirm) return;
  F.armed = true; F.armedUntil = Date.now() + RESCUE_MS; F.restarting = false;
  setTimeout(() => { if (F.armed && Date.now() > F.armedUntil) { F.armed = false; log("armed flash expired", "warn"); changed(); } }, RESCUE_MS + 100);
  log("rescue: flash armed for 3 min", "ok");
  say("Armed for 3 min. Power-cycle the module. Then tap Connect at once and pick TSL6-BOOT. The flash starts by itself.",
    "已准备 3 分钟。请给模块断电再上电，然后立即点“连接”并选择 TSL6-BOOT，刷写会自动开始。", "warn");
}

onBus("boot", ({ link, payload }) => {
  const s = decodeStatus(payload);
  if (s.moduleId && !F.modId) F.modId = s.moduleId;
  changed();
  void runArmedFlash(link);
});
onBus("status", p => {
  if (F.armed && F.restarting && inRuntime(p)) {
    F.armed = false; F.restarting = false;
    log("the module is back in normal mode (the 10 s boot window passed). Tap \"Enter boot mode and flash\" again", "warn");
    say("The module went back to normal mode. Start again.", "模块已回到正常模式。请重新开始。", "warn");
  }
  changed();
});
// A drop after the arming is the restart (it can come later than the 3 s wait in reconnectFast).
onBus("conn", st => { if (F.armed && st && st.connected === false) F.restarting = true; changed(); });

// ---------------------------------------------------------------- page
function loadCss() {
  if (document.querySelector('link[data-page-css="firmware"]')) return;
  document.head.append(h("link", { rel: "stylesheet", href: new URL("./firmware.css", import.meta.url).href, "data-page-css": "firmware" }));
}

definePage("firmware", () => {
  loadCss();
    const note = (en, zh) => h("p", { class: "row-note fw-note" }, L(en, zh));
  const rich = html => { const p = h("p", { class: "row-note fw-note" }); p.innerHTML = html; return p; }; // constant strings only

  // Connection
  const connIcon = h("span", { class: "chip" });
  const connTitle = h("span");
  const connSub = h("div", { class: "li-sub fw-sel" });
  const connectBtn = h("button", { class: "btn primary small", type: "button", "data-id": "fw-connect", onclick: () => connect({ all: F.showAll }) }, L("Connect", "连接"));
  const allBox = h("input", { type: "checkbox", onchange: e => { F.showAll = e.target.checked; } });
  const allRow = h("label", { class: "li check-row" }, allBox,
    h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Show all devices", "显示所有设备"))),
      h("div", { class: "li-sub" }, L("Use it if the module does not appear.", "找不到模块时使用。"))));

  // Image
  const securedBtn = h("button", { class: "btn primary", type: "button", "data-id": "fw-secured", onclick: loadSecured }, L("Load secured build", "加载安全版"));
  const promptBtn = h("button", { class: "btn", type: "button", "data-id": "fw-prompt", onclick: loadPrompt }, L("Load prompt build (test)", "加载提示版（测试）"));
  const passIn = h("input", { class: "text mono", type: "password", placeholder: L("Passphrase", "口令"), autocomplete: "off", spellcheck: "false", style: { flex: "1", minWidth: "160px" },
    oninput: e => { F.origPass = e.target.value; } });
  const origBtn = h("button", { class: "btn", type: "button", onclick: loadOriginal }, L("Load original (June 2026 dump)", "加载原版（2026 年 6 月）"));
  const fileIn = h("input", { type: "file", accept: ".bin,.json,application/octet-stream,application/json",
    onchange: async e => { const f = e.target.files[0]; if (f) await accept(await f.arrayBuffer(), f.name); } });
  const imgOut = h("div", { class: "out", "data-id": "fw-image" });

  // Flash
  const confirmBox = h("input", { type: "checkbox", "data-id": "fw-confirm", onchange: e => { F.confirm = e.target.checked; changed(); } });
  const autoBtn = h("button", { class: "btn danger-fill", type: "button", "data-id": "fw-auto", onclick: startAuto }, L("Enter boot mode and flash", "进入升级模式并刷写"));
  const modePill = h("span", { class: "pill" });
  const prog = h("progress", { max: 1, value: 0 });
  const msgOut = h("div", { class: "out", "data-id": "fw-msg" });
  const modIn = h("input", { class: "text mono", type: "text", maxlength: 24, autocomplete: "off", spellcheck: "false", "data-id": "fw-modid",
    placeholder: L("filled in from the boot-mode status", "从升级模式的状态自动填入"), oninput: e => { F.modId = e.target.value; changed(); } });
  const uidOut = h("div", { class: "out" });
  const flashBtn = h("button", { class: "btn danger-fill", type: "button", "data-id": "fw-flash", onclick: () => runFlash(S.link) }, L("Flash runtime", "刷写运行固件"));
  const rescueBtn = h("button", { class: "btn", type: "button", "data-id": "fw-rescue", onclick: toggleRescue });
  const chunkVal = h("span", { class: "val" });

  const el = h("div", { class: "page narrow", "data-page": "firmware" },
    h("div", { class: "sec-label" }, L("Connection", "连接")),
    h("div", { class: "card" },
      h("div", { class: "li first" }, connIcon,
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, connTitle), connSub), connectBtn),
      allRow),
    h("p", { class: "sec-foot" }, L("Turn off Bluetooth on any phone that runs the vendor Mini App first. The module accepts one connection at a time.",
      "请先关闭运行厂家小程序的手机的蓝牙。模块同一时间只接受一个连接。")),

    h("div", { class: "sec-label" }, L("1. Firmware image", "1. 固件镜像")),
    h("div", { class: "card" },
      h("div", { class: "form" }, h("div", { class: "btns" }, securedBtn),
        rich(L("<b>Use this one.</b> The original June 2026 firmware has a <b>backdoor</b>: a fixed vendor password that opens every TSL6 module over Bluetooth, whatever password you set. The secured build is the same firmware with the backdoor removed. Only your own password opens the module.",
          "<b>请用这个。</b>2026 年 6 月的原版固件有<b>后门</b>：一个固定的厂家密码，无论你设置什么密码，都能通过蓝牙打开每一个 TSL6 模块。安全版是去掉后门的同一固件。只有你自己的密码能打开模块。"))),
      h("div", { class: "subhead" }, L("Prompt build (test)", "提示版（测试）")),
      h("div", { class: "form" }, h("div", { class: "btns" }, promptBtn),
        rich(L("The secured build plus new choices in <b>Settings → Scroll interval → On hands-on prompt</b>. With one of them, the module scrolls only when the car shows the hands-on prompt: one tick pair after the delay you pick (0.3–5 s, random ± 50 %). The gap between the two ticks is your “Up/down tick gap” ± 50 %, random. The Car tab shows the live state. All other Scroll interval choices work as in the secured build. The gauge altitude then shows the prompt count instead. If you save settings in the vendor Mini App, it changes Scroll interval back to every 2–3 s.",
          "安全版加新选项：<b>设置 → 滚轮操作时间 → 手扶提示时</b>。选其中一个后，只有车机显示手扶方向盘提示时模块才操作滚轮：在你选的延时后（0.3–5 秒，随机 ± 50 %）操作一次减加。减加之间的间隔为“加减时间间隔”± 50 % 随机。车辆页显示实时状态。其他选项与安全版相同。仪表的海拔改为显示提示次数。如果在厂家小程序里保存设置，它会把滚轮操作时间改回每 2–3 秒。"))),
      h("div", { class: "subhead" }, L("Original build", "原版")),
      h("div", { class: "form" }, h("div", { class: "btns" }, passIn, origBtn),
        rich(L("The original build <b>has the backdoor</b>. It needs a passphrase to load. If you want the passphrase for the original (backdoor) build, contact me: <a href=\"https://github.com/n0k0m3\">n0k0m3 on GitHub</a>.",
          "原版<b>有后门</b>，需要口令才能加载。如需原版（有后门）的口令，请联系我：<a href=\"https://github.com/n0k0m3\">GitHub 上的 n0k0m3</a>。"))),
      h("div", { class: "subhead" }, L("Other image", "其他镜像")),
      h("div", { class: "form" }, fileIn, imgOut)),

    h("div", { class: "sec-label" }, L("2. Flash", "2. 刷写")),
    h("div", { class: "card" },
      h("div", { class: "form" }, note("The bootloader waits only about 10 s for an update after the restart. So the page does it in one step: restart into boot mode, reconnect, start the update at once.",
        "重启后，Bootloader 只等待约 10 秒。所以本页一步完成：重启进入升级模式，重新连接，立即开始升级。")),
      h("label", { class: "row check-row" }, confirmBox,
        h("span", { class: "row-left" }, h("span", { class: "row-label" }, L("I understand that this writes flash. The car is parked and awake.", "我明白这会写入闪存。车辆已停好且已唤醒。")))),
      h("div", { class: "form" },
        h("div", { class: "btns" }, autoBtn, modePill),
        rich(L("If the page cannot reconnect by itself, tap <b>Connect</b> at once and pick <code>TSL6-BOOT</code>. The flash then starts by itself. If you miss the 10 s, the module goes back to normal. Start again.",
          "如果本页无法自动重连，请立即点<b>连接</b>并选择 <code>TSL6-BOOT</code>，刷写会自动开始。如果错过 10 秒，模块会回到正常模式。请重新开始。")),
        prog, msgOut,
        rich(L("72 pages take about 5–6 min in Bluefy at 20 bytes per write. After the update starts, the module stays in boot mode until a flash finishes. If a flash fails, connect to <code>TSL6-BOOT</code> and use the button below.",
          "在 Bluefy 中每次写 20 字节，72 页约需 5–6 分钟。升级开始后，模块会一直停在升级模式，直到刷写完成。如果刷写失败，请连接 <code>TSL6-BOOT</code> 并使用下面的按钮。"))),
      h("div", { class: "subhead" }, L("Module already in boot mode", "模块已在升级模式")),
      h("div", { class: "form" },
        h("span", { class: "row-note" }, L("Module ID (from the boot-mode status)", "模块 ID（来自升级模式的状态）")),
        modIn, uidOut, h("div", { class: "btns" }, flashBtn)),
      h("div", { class: "subhead" }, L("Rescue (safe-boot builds)", "救援（安全启动版）")),
      h("div", { class: "form" },
        rich(L("A safe-boot build keeps the module in <code>TSL6-BOOT</code> for about 10 s at every power-on, then starts the runtime. If that runtime does not work, arm the flash here, power-cycle the module, then tap <b>Connect</b> at once and pick <code>TSL6-BOOT</code>. The flash starts by itself.",
          "安全启动版在每次上电时让模块停在 <code>TSL6-BOOT</code> 约 10 秒，然后启动运行固件。如果该运行固件不工作，请在此准备刷写，给模块断电再上电，然后立即点<b>连接</b>并选择 <code>TSL6-BOOT</code>，刷写会自动开始。")),
        h("div", { class: "btns" }, rescueBtn))),

    h("div", { class: "sec-label" }, L("More", "更多")),
    h("div", { class: "card" },
      h("div", { class: "li first" }, h("span", { class: "chip" }, icon("sliders-horizontal", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Bytes per BLE write", "每次蓝牙写入字节数"))),
          h("div", { class: "li-sub" }, L(`Set on the Device tab. Drops to ${SAFE_CHUNK} by itself if large writes fail.`, `在「设备」页设置。大块写入失败时自动降到 ${SAFE_CHUNK}。`))),
        h("div", { class: "li-trail" }, chunkVal)),
      h("button", { class: "li", type: "button", onclick: () => go("log") }, h("span", { class: "chip" }, icon("file-text", 22)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Log and capture", "日志与抓包"))),
          h("div", { class: "li-sub" }, L("Every frame of the flash", "刷写的全部数据帧"))), h("span", { class: "chev" }, icon("chevron-right", 18)))));

  function drawImage() {
    clear(imgOut);
    imgOut.className = "out";
    const im = F.image;
    if (!im) return;
    if (im.error) { imgOut.textContent = L(im.error.en, im.error.zh); imgOut.className = "out bad"; return; }
    imgOut.append(im.lines.join("\n") + "\n",
      im.problems.length ? h("span", { class: "bad" }, L("REJECTED: ", "已拒绝：") + im.problems.join("; ")) : h("span", { class: "ok" }, L("Image OK", "镜像正常")));
  }

  function update() {
    const link = S.link;
    const on = !!(link && link.connected);
    const st = on ? link.status : null, boot = on ? link.boot : null;
    // connection
    clear(connIcon).append(icon(on ? "bluetooth-connected" : "bluetooth-off", 22));
    connIcon.className = "chip" + (on ? (boot ? " amber" : " green") : "");
    connTitle.textContent = !on ? L("Not connected", "未连接")
      : boot ? L(`Boot mode: ${link.name}`, `升级模式：${link.name}`) : L(`Connected: ${link.name}`, `已连接：${link.name}`);
    const s = boot ? decodeStatus(boot) : st ? decodeStatus(st) : null;
    connSub.textContent = !s ? L("Pick TSL6 or TSL6-BOOT in the browser's Bluetooth list.", "在浏览器的蓝牙列表中选择 TSL6 或 TSL6-BOOT。")
      : boot ? `Bootloader ${formatVersion(s.bootVer << 8)} · ID ${s.moduleId || "?"}`
      : L(`Bootloader ${formatVersion(s.bootVer << 8)} · runtime ${formatVersion(s.runVer << 8)}`, `Bootloader ${formatVersion(s.bootVer << 8)} · 运行固件 ${formatVersion(s.runVer << 8)}`);
    connectBtn.hidden = on;
    connectBtn.disabled = F.busy || !navigator.bluetooth && !S.mock;
    allRow.hidden = on || S.mock;
    allBox.checked = F.showAll;
    // image
    drawImage();
    securedBtn.disabled = promptBtn.disabled = origBtn.disabled = fileIn.disabled = F.busy;
    // flash
    confirmBox.checked = F.confirm;
    const pages = !!(F.image && F.image.pages);
    autoBtn.disabled = !on || F.busy || F.armed || !inRuntime(st) || !pages || !F.confirm;
    flashBtn.disabled = !on || F.busy || F.armed || !inBoot(boot) || !pages || !uid14(F.modId) || !F.confirm;
    rescueBtn.textContent = F.armed ? L("Cancel armed flash", "取消已准备的刷写") : L("Arm flash for TSL6-BOOT", "为 TSL6-BOOT 准备刷写");
    rescueBtn.disabled = F.busy || !F.armed && (!pages || !F.confirm);
    if (boot) { modePill.textContent = L("Boot mode: ready to flash", "升级模式：可以刷写"); modePill.className = "pill ok"; }
    else if (st) { modePill.textContent = L("Runtime mode: not in boot mode", "运行模式：不在升级模式"); modePill.className = "pill warn"; }
    else { modePill.textContent = L("No status yet", "尚无状态"); modePill.className = "pill"; }
    prog.max = F.total || 1; prog.value = F.done;
    msgOut.textContent = F.msg ? L(F.msg.en, F.msg.zh) : "";
    msgOut.className = "out" + (F.msg && F.msg.cls ? " " + F.msg.cls : "");
    if (document.activeElement !== modIn) modIn.value = F.modId;
    const u = uid14(F.modId);
    uidOut.textContent = u ? `UID14: ${lhex(u)}` : F.modId ? L("Need 24 hex characters.", "需要 24 个十六进制字符。") : "";
    uidOut.className = "out" + (!u && F.modId ? " bad" : "");
    chunkVal.textContent = link ? String(link.chunk) : "—";
  }

  passIn.value = F.origPass;
  const onChange = () => update();
  update();
  return {
    el,
    title: { en: "Firmware", zh: "固件刷写" },
    refresh: update,
    // The session keeps running while the page is away. The page only follows it while it shows.
    enter() { ev.addEventListener("change", onChange); update(); },
    leave() { ev.removeEventListener("change", onChange); },
  };
});
