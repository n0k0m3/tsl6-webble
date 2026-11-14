// CAN debug page (vendor pages/debug, 数据调试模式): CAN monitor and raw CAN send.
// Enter: C0 02 (paused). Receive tap: C0 FF FF + IDs. Receive long press: C0 01 (all IDs). Leave: C0 00.
// SEND TRANSMITS A RAW CAN FRAME ON THE CAR BUS. It needs the driving-system switch and a confirm per frame.
import { h, L, btn, pressable, toast } from "../ui.js";
import { S, definePage, onBus, send, log } from "../app.js";
import { TYPE, debugMode, DEBUG_MODE, parseDebugFilterText, parseDebugSendText, decodeDebugFrame, formatDebugLine, hex } from "../../lib/tsl6-live.js";

function loadCss(name) {
  if (document.querySelector(`link[data-page-css="${name}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href: new URL(`./${name}.css`, import.meta.url).href, "data-page-css": name }));
}
const ready = () => !!(S.link && S.link.connected && (S.link.authed || (S.status && !S.blank)));
const MAX_LINES = 999;
const MAX_ID = 0x7ff; // 11-bit CAN IDs only
const idHex = id => id.toString(16).toUpperCase().padStart(3, "0");

definePage("debug", () => {
  loadCss("debug");
  const el = h("div", { class: "page dbg" });
  let shown = false, started = false;
  let mode = "off";           // off | paused | all | filter
  let filterIds = [];
  let lines = [], n = 0, lastAt = 0, drawPending = 0;
  const offs = [];

  // ---------------------------------------------------------------- layout
  const rxInput = h("input", { class: "text mono", type: "text", placeholder: L("Data ID, e.g. 118,257", "数据ID"), autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": L("Data ID", "数据ID") });
  const rxBtn = pressable(btn({ en: "Receive", zh: "接收" }, null, { kind: "small", title: L("Tap: receive these IDs. Long press: receive all IDs.", "点击：接收所填ID；长按：接收所有ID") }),
    { ontap: receiveIds, onlong: receiveAll });
  const pauseBtn = btn({ en: "Pause", zh: "暂停" }, pause, { kind: "small dbg-pause" });
  const clearBtn = btn({ en: "Clear", zh: "清空" }, clearLog, { kind: "small dbg-clear" });
  const copyBtn = btn({ en: "Copy", zh: "复制" }, copyLog, { kind: "small" });
  const modeText = h("span", { class: "dbg-mode" });
  const countText = h("span", { class: "dbg-count" });
  const out = h("pre", { class: "dbg-log", tabindex: "0", "aria-label": L("Received CAN frames", "接收的CAN数据"), "aria-live": "off" });
  const txInput = h("input", { class: "text mono", type: "text", placeholder: L("ID and data, comma between: 123,11 22 33", "数据ID和数据用逗号隔开"), autocomplete: "off", autocapitalize: "characters", spellcheck: "false", "aria-label": L("CAN frame to send", "要发送的CAN数据") });
  const txBtn = btn({ en: "Send", zh: "发送" }, sendFrame, { kind: "small danger" });
  // No Enter-to-send: Enter, Enter must never pass the confirm.
  rxInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); receiveIds(); } });

  el.append(
    h("div", { class: "dbg-bar" }, rxInput, h("div", { class: "dbg-btns" }, rxBtn, pauseBtn, clearBtn, copyBtn)),
    h("div", { class: "dbg-state" }, modeText, countText),
    out,
    h("div", { class: "dbg-bar dbg-tx" }, txInput, txBtn),
    h("p", { class: "dbg-warn" }, L(
      "Send puts one raw CAN frame on a car bus. The bus is not known. A wrong frame can cause faults. Each frame needs a confirm.",
      "发送会在车辆总线上发出一帧原始CAN数据。总线未知。错误的数据可能导致车辆故障。每一帧都需要确认。")),
  );

  function showMode() {
    const t = !ready() ? L("Not connected", "蓝牙未连接")
      : mode === "all" ? L("Receiving all IDs", "接收所有ID数据")
      : mode === "filter" ? L("Receiving IDs: ", "接收ID：") + filterIds.map(idHex).join(", ")
      : mode === "paused" ? L("Paused", "已暂停")
      : L("Stopped", "已停止");
    modeText.textContent = t;
    modeText.className = "dbg-mode " + (mode === "all" || mode === "filter" ? "on" : "");
    countText.textContent = L(`${lines.length} lines`, `${lines.length} 行`);
  }

  // ---------------------------------------------------------------- log
  function draw() {
    drawPending = 0;
    const stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 40;
    out.textContent = lines.join("");
    if (stick) out.scrollTop = out.scrollHeight;
    showMode();
  }
  const drawSoon = () => { if (!drawPending) drawPending = requestAnimationFrame(draw); };

  function addFrame(payload) {
    const d = decodeDebugFrame(payload);
    if (d.error) { log(`debug: ${d.error}`, "warn"); return; }
    const now = Date.now();
    const gap = lastAt ? Math.min(now - lastAt, 9999) : 9999;
    lastAt = now;
    if (++n >= 99999) n = 0;                       // same wrap as the vendor
    lines.push(formatDebugLine(n, payload, gap));
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    drawSoon();
  }
  function clearLog() { lines = []; n = 0; draw(); }

  async function copyLog() {
    const text = lines.join("");
    if (!text) { toast(L("The log is empty", "没有数据"), "warn"); return; }
    try { await navigator.clipboard.writeText(text); toast(L("Copied", "已复制"), "ok"); return; } catch { /* fall back below */ }
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }, text);
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* old browser */ }
    ta.remove();
    toast(ok ? L("Copied", "已复制") : L("Copy failed. Select the text in the log.", "复制失败，请长按选择文本"), ok ? "ok" : "bad");
  }

  // ---------------------------------------------------------------- monitor control
  async function receiveIds() {
    const r = parseDebugFilterText(rxInput.value.replace(/\s+/g, ""));
    if (r.error) { toast(L(r.error.en, r.error.zh), "bad"); return; }
    if (r.ids.some(id => id > MAX_ID)) { toast(L("A CAN ID must be 000 to 7FF.", "CAN ID 必须在 000 到 7FF 之间"), "bad"); return; }
    if (await send(TYPE.DEBUG, r.payload)) { mode = "filter"; filterIds = r.ids; started = true; showMode(); }
  }
  async function receiveAll() {
    if (await send(TYPE.DEBUG, debugMode(DEBUG_MODE.ALL))) {
      mode = "all"; started = true; showMode();
      toast(L("Receiving data of all IDs", "接收所有ID数据"), "", 2000);
    }
  }
  async function pause() {
    if (await send(TYPE.DEBUG, debugMode(DEBUG_MODE.PAUSE), { read: true })) { mode = "paused"; started = true; showMode(); }
  }

  // ---------------------------------------------------------------- raw CAN send
  let sending = false;
  async function sendFrame() {
    if (sending) return;                           // one confirm at a time
    sending = true;
    try { await sendFrameOnce(); } finally { sending = false; }
  }
  async function sendFrameOnce() {
    const r = parseDebugSendText(txInput.value.trim());
    if (r.error) { toast(L(r.error.en, r.error.zh), "bad"); return; }
    if (r.id > MAX_ID) { toast(L("A CAN ID must be 000 to 7FF.", "CAN ID 必须在 000 到 7FF 之间"), "bad"); return; }
    // The confirm shows the parsed frame, which is exactly the payload that goes out.
    const idText = "0x" + idHex(r.id), dataText = hex(r.data, " "), nb = r.data.length;
    const pending = send(TYPE.DEBUG, r.payload, {
      danger: "cantx",
      confirm: {
        en: `Transmit this raw CAN frame on the car bus?\n\nID: ${idText}\nData (${nb} byte${nb > 1 ? "s" : ""}): ${dataText}\n\nThe bus is not known. A wrong frame can cause car faults. The app sends it one time.`,
        zh: `确定在车辆总线上发送这一帧原始CAN数据吗？\n\nID: ${idText}\n数据 (${nb}字节): ${dataText}\n\n总线未知。错误的数据可能导致车辆故障。仅发送一次。`,
      },
    });
    // send() opens the confirm before its first await. Put the focus on Cancel, so that a key press does not transmit.
    const top = [...document.querySelectorAll(".dlg-back")].at(-1);
    const cancel = top && top.querySelector(".dlg-btn:not(.primary)");
    if (cancel) cancel.focus();
    if (!(await pending)) return;
    log(`CAN send ${idText} ${dataText}`, "warn");
    lines.push(`>> TX ${idText},${dataText}\r\n`);
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    draw();
    toast(L("Sent", "已发送"), "ok", 1000);
  }

  // ---------------------------------------------------------------- lifecycle
  // Vendor: C0 02 when the page shows, C0 00 when it hides or closes.
  const active = () => shown && !document.hidden;
  function start() {
    if (!active() || started || !ready()) return;
    started = true;
    send(TYPE.DEBUG, debugMode(DEBUG_MODE.PAUSE), { read: true, quiet: true }).then(ok => { if (ok) mode = "paused"; else started = false; showMode(); });
  }
  function stop() {
    if (started && S.link && S.link.connected) send(TYPE.DEBUG, debugMode(DEBUG_MODE.OFF), { read: true, quiet: true });
    started = false;
    mode = "off";
    showMode();
  }
  function onVis() { if (document.hidden) stop(); else start(); }

  draw();
  return {
    el,
    title: { en: "Data debug mode", zh: "数据调试模式" },
    enter() {
      shown = true;
      offs.push(onBus("frame", fr => { if (fr.cmd === TYPE.DEBUG) addFrame(fr.payload); }));
      offs.push(onBus("status", start));
      offs.push(onBus("conn", st => { if (!st.connected) { started = false; mode = "off"; showMode(); } else start(); }));
      document.addEventListener("visibilitychange", onVis);
      start();
      showMode();
    },
    leave() {
      shown = false;
      stop();
      offs.splice(0).forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
      if (drawPending) cancelAnimationFrame(drawPending);
      drawPending = 0;
    },
    refresh() { draw(); },
  };
});
