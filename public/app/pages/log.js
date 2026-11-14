// Log and capture: every frame in and out, plus a capture file for car tests.
import { h, L, section, btn, toast, clear, download, fmtTime } from "../ui.js";
import { S, definePage, onBus } from "../app.js";
import { decodeStatus, decodeSettings, hex } from "../../lib/tsl6-settings.js";
import { APP_BUILD } from "./me.js";

definePage("log", () => {
  const pre = h("pre", { class: "log" });
  let paused = false;

  function draw() {
    if (paused) return;
    clear(pre);
    // The screen log hides the BLE password too, so a copied or shared screenshot does not show it.
    for (const l of S.logLines.slice(-600)) pre.append(h("span", { class: l.cls }, `${fmtTime(l.t)} ${redactLine(l.msg)}\n`));
    pre.scrollTop = pre.scrollHeight;
  }
  // The capture hides the BLE password: status bytes 36-39, the A8 key, the A9 old/new keys and A3 bytes 36-39.
  const mask = (toks, from, n) => { for (let i = from; i < from + n && i < toks.length; i++) toks[i] = "**"; };
  function redactLine(msg) {
    let m = msg.match(/^(tx )(55 7F ([0-9A-F]{2}) .*)$/);
    if (m) {
      const t = m[2].split(" "), type = m[3];
      if (type === "A8") mask(t, 5, 4);
      if (type === "A9") mask(t, 5 + 18, 8);
      if (type === "A3" || type === "A0") mask(t, 5 + 36, 4);
      return m[1] + t.join(" ");
    }
    m = msg.match(/^(rx (A0|A1|A3) \(\d+\) )(.*)$/);
    if (m) { const t = m[3].split(" "); mask(t, 36, 4); return m[1] + t.join(" "); }
    return msg;
  }
  function capture() {
    const st = S.status ? Uint8Array.from(S.status) : null;
    if (st && st.length >= 40) st.fill(0x2a, 36, 40);
    return JSON.stringify({
      app: "tsl6-web-app", build: APP_BUILD, time: new Date().toISOString(), mock: S.mock, hwType: S.hwType,
      device: S.link ? S.link.name : null,
      note: "BLE password bytes are masked (** / 0x2A).",
      status: st ? { length: st.length, hex: hex(st, " "), decoded: { ...decodeStatus(st), uid14: undefined, blePassword: undefined }, settings: decodeSettings(st) } : null,
      log: S.logLines.map(l => `${l.t.toISOString()} ${redactLine(l.msg)}`),
    }, null, 1);
  }
  const el = h("div", { class: "page" },
    section(null,
      h("div", { class: "toolbar" },
        h("span", { class: "row-note" }, L("Frames in (rx) and out (tx).", "收发数据帧。")),
        h("div", { class: "tools" },
          btn({ en: "Pause", zh: "暂停" }, e => { paused = !paused; e.target.textContent = paused ? L("Resume", "继续") : L("Pause", "暂停"); draw(); }, { kind: "small" }),
          btn({ en: "Clear", zh: "清空" }, () => { S.logLines.length = 0; draw(); }, { kind: "small" }))),
      pre),
    section({ en: "Capture", zh: "抓包" }, h("div", { class: "form" },
      h("p", { style: { margin: 0 } }, L(
        "A capture holds the last status and this log. It contains your module ID and VIN. Do not post it in public.",
        "抓包包含最新状态与日志，其中有模块ID与车架号，请勿公开发布。")),
      h("div", { class: "tools wrap" },
        btn({ en: "Copy capture", zh: "复制抓包" }, async () => {
          try { await navigator.clipboard.writeText(capture()); toast(L("Copied", "已复制"), "ok"); }
          catch { toast(L("Clipboard blocked. Use Download.", "无法复制，请下载"), "warn"); }
        }, { kind: "primary" }),
        btn({ en: "Download", zh: "下载" }, () => download(`tsl6-capture-${Date.now()}.json`, capture()))))));

  const offs = [];
  return {
    el,
    title: { en: "Log and capture", zh: "日志与抓包" },
    enter() { draw(); offs.push(onBus("log", draw)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
