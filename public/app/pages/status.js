// Status tab (vendor pages/index): live switches, seats, doors, controls, simulated wheel.
import { h, L, row, section, toggle, icon, iconBtn, holdButton, pressable, toast, alertBox, showHelp, btn } from "../ui.js";
import { S, definePage, onBus, send, ask, gate, rereadSoon, go, savePref, log } from "../app.js";
import {
  STATUS_ROWS, A7_HARD_GATED, A7_RELEASE, A2_RELEASE, decodeLiveState, switchCommand, memoryCommand, tapCommand,
  canStateText, formatC1Reply, decodeA7Reply,
} from "../../lib/tsl6-status.js";

const ICON = {
  louying: "camp", lingzhongli: "queen", zhujiashichemen: "doorFL", fujiashichemen: "doorFR", zuocehoupaichemen: "doorRL",
  youcehoupaichemen: "doorRR", yinqinggai: "frunk", houbeixiang: "trunk", jichuxinxi: "glove", diandongzhediehoushijing: "mirror",
  jiesuo: "unlock", suoding: "lock", guanbi2: "power",
  "shangxiazuoyou-3": "left", "shangxiazuoyou-": "right", "shangxiazuoyou-2": "up", "shangxiazuoyou-1": "down", ok: "ok",
};
const shown = r => !r.types || r.types.includes(S.hwType);

definePage("status", () => {
  const el = h("div", { class: "page" });
  const switches = {};        // id -> switch element
  const held = new Set();     // hold buttons that are down
  let live = null, countdown = null, timer = 0, vehicleEl = null, harnessEl = null, cdRow = null, cdText = null;

  // ---- one hold button (seat A7 or wheel A2): press frame, then exactly one release frame
  function hold(type, value, releaseValue, b) {
    const label = L(b.en, b.zh || b.en);
    const el = h("button", { class: "ibtn", type: "button", "aria-label": label, title: label },
      b.text ? h("b", null, b.text) : icon(ICON[b.icon] || "ok", 22));
    let pressed = null;
    holdButton(el, {
      onpress: () => {
        held.add(el);
        pressed = (async () => {
          if (!(await gate(type))) return false;                // first-use warning; this press then does nothing
          if (!held.has(el)) return false;                      // released while the warning was open: no press, no release
          try { await S.link.send(type, Uint8Array.of(value)); return true; } catch (e) { log(`press failed: ${e.message}`, "bad"); return false; }
        })();
      },
      onrelease: () => {
        held.delete(el);
        const p = pressed; pressed = null;
        if (!p) return;
        p.then(async ok => {
          if (!ok) return;
          for (let i = 0; i < 3; i++) {                         // the release must reach the module
            try { await S.link.send(type, Uint8Array.of(releaseValue)); return; } catch (e) { log(`release failed (${i + 1}/3): ${e.message}`, "bad"); }
          }
          toast(L("Release frame failed. Check the car.", "松开指令发送失败，请检查车辆"), "bad", 4000);
        });
      },
    });
    return el;
  }
  const releaseAll = () => { for (const b of [...held]) b.release(); };
  const onVis = () => { if (document.hidden) releaseAll(); };

  async function onSwitch(r, want) {
    let c;
    try { c = switchCommand(r.id, want, { allowDangerous: true }); } catch (e) { toast(e.message, "bad"); return; }
    const value = c.payload[0];
    const danger = c.type === 0xa7 && A7_HARD_GATED.includes(value) ? "drive" : null;
    // Vendor: the help text opens when a motor/ESP switch turns on. Show it only when the control is allowed.
    if (c.help && danger && S.prefs.allowDrive) await showHelp(c.help.id, L(r.en, r.zh));
    if (!(await send(c.type, c.payload, { danger }))) return;
    rereadSoon();
  }

  async function onTap(r, b) {
    let c;
    try { c = tapCommand(r.id, b.btn, { allowDangerous: true }); } catch (e) { toast(e.message, "bad"); return; }
    const danger = A7_HARD_GATED.includes(b.btn) ? "drive" : null;
    if (await send(c.type, c.payload, { confirm: c.confirm, danger })) toast(L("Sent", "指令已发送"), "ok", 1000);
  }

  async function onMemory(r, b, longpress) {
    const c = memoryCommand(r.id, b.btn, longpress);
    if (await send(c.type, c.payload, { confirm: c.confirm })) toast(L("Sent", "指令已发送"), "ok", 1000);
  }

  async function vehicleLongPress() {
    // Vendor: read the status, then show CAN1-3 from it (types 6, 7, 8, 19).
    const r = await ask(0xa0, new Uint8Array(0), { reply: [0xa0, 0xa1, 0xa3], read: true });
    if (r && [6, 7, 8, 19].includes(S.hwType)) {
      const t = canStateText(r.payload[23] || 0);
      alertBox(L(t.en, t.zh.replace(/\r/g, "")));
    }
  }
  async function wheelLongPress() {
    const r = await ask(0xc1, new Uint8Array(0), { read: true });
    if (r && r.payload.length >= 4) { const f = formatC1Reply(r.payload); alertBox(L(`Reply: 0x${f.value.toString(16).toUpperCase().padStart(8, "0")}`, f.zh)); }
  }

  function build() {
    const rows = [];
    for (const r of STATUS_ROWS) {
      if (!shown(r)) continue;
      const label = { en: r.en, zh: r.zh };
      const helpTitle = label;
      if (r.kind === "vehicleType") {
        vehicleEl = h("span", { class: "vt" }, "—");
        harnessEl = h("span", { class: "vt-warn", hidden: true }, L("Harness not plugged in", "线束未插好"));
        const rr = row(label, { help: r.help, helpTitle }, harnessEl, vehicleEl);
        pressable(rr, { onlong: vehicleLongPress }); // whole row: the label or the vehicle text
        rows.push(rr);
      } else if (r.kind === "local") {
        const sw = toggle({ checked: S.prefs.autoGauge, label: L(label), onchange: async v => { savePref("autoGauge", v); sw.set(v); } });
        rows.push(row(label, { help: r.help, helpTitle }, btn({ en: "Gauges", zh: "仪表盘" }, () => go("gauge"), { kind: "small green" }), sw));
      } else if (r.kind === "switch") {
        const sw = toggle({ checked: null, label: L(label), onchange: v => onSwitch(r, v) });
        switches[r.id] = sw;
        rows.push(row(label, { help: r.help, helpTitle }, sw));
      } else if (r.kind === "seat") {
        rows.push(row(label, { help: r.help, helpTitle, cls: "row-btns" },
          h("div", { class: "btn-grid" }, r.buttons.map(b => hold(0xa7, b.btn, A7_RELEASE, b)))));
      } else if (r.kind === "memory") {
        rows.push(row(label, { help: r.help, helpTitle, cls: "row-btns" },
          h("div", { class: "btn-grid five" }, r.buttons.map(b => {
            const e = iconBtn(ICON[b.icon], null, { label: L(b.en), text: b.text });
            return pressable(e, { ontap: () => onMemory(r, b, false), onlong: () => onMemory(r, b, true) });
          }))));
      } else if (r.kind === "tap") {
        const visible = r.buttons.filter(b => (!b.types || b.types.includes(S.hwType)) && !b.vendorGate);
        const first = visible.filter(b => b.btn < 12), second = visible.filter(b => b.btn >= 12);
        rows.push(row(label, { help: r.help, helpTitle, cls: "row-btns" },
          h("div", { class: "btn-stack" },
            h("div", { class: "btn-grid" }, first.map(b => iconBtn(ICON[b.icon], () => onTap(r, b), { label: L(b.en, b.info || b.en) }))),
            second.length ? h("div", { class: "btn-grid end" }, second.map(b => iconBtn(ICON[b.icon], () => onTap(r, b), { label: L(b.en, b.info || b.en) }))) : null)));
      } else if (r.kind === "wheel") {
        const B = Object.fromEntries(r.buttons.map(b => [b.btn, hold(0xa2, b.btn, A2_RELEASE, b)]));
        const pad = h("div", { class: "dpad" }, h("span"), B[1], h("span"), B[4], B[5], B[2], h("span"), B[3], h("span"));
        const rr = row(label, { help: r.help, helpTitle, cls: "row-btns" }, pad);
        pressable(rr.querySelector(".row-label"), { onlong: wheelLongPress });
        rows.push(rr);
      } else if (r.kind === "countdown") {
        cdText = h("span", { class: "cd" }, "");
        cdRow = row(label, { help: r.help, helpTitle }, cdText);
        cdRow.hidden = true;
        rows.push(cdRow);
      }
    }
    el.append(section(null, rows));
    el.append(h("p", { class: "foot" }, L(
      "Hold the seat and wheel buttons. The release goes out when you lift your finger. Switches show the module state after the next status read.",
      "座椅与滚轮按钮需按住操作，松手即发送停止指令。开关状态以模块回传为准。")));
  }

  function update(p) {
    if (!p) {
      for (const sw of Object.values(switches)) sw.set(null);
      if (vehicleEl) { vehicleEl.textContent = L("Not connected", "蓝牙未连接"); vehicleEl.className = "vt"; }
      if (cdRow) cdRow.hidden = true;
      return;
    }
    live = decodeLiveState(p, S.hwType);
    for (const [id, sw] of Object.entries(switches)) sw.set(live.blank ? null : live.toggles[id]);
    if (vehicleEl) {
      vehicleEl.textContent = live.blank ? L("Enter the BLE password", "请输入蓝牙密码") : L(live.vehicle.en, live.vehicle.zh);
      vehicleEl.className = "vt " + (live.vehicle.detected ? "ok" : "warn");
    }
    if (harnessEl) harnessEl.hidden = !live.harnessUnplugged;
    clearInterval(timer);
    if (cdRow) {
      cdRow.hidden = !live.assistActive;
      countdown = live.timerMs / 1000;
      const draw = () => { cdText.textContent = L(`${countdown.toFixed(1)} s`, `${countdown.toFixed(1)} 秒后`); };
      draw();
      if (live.assistActive) timer = setInterval(() => { countdown = Math.max(0, countdown - 0.1); draw(); if (!countdown) clearInterval(timer); }, 100);
    }
  }

  build();
  const offs = [];
  return {
    el,
    enter() {
      update(S.status);
      offs.push(onBus("status", update));
      offs.push(onBus("conn", st => { if (!st.connected) { releaseAll(); update(null); } }));
      offs.push(onBus("frame", fr => {
        if (fr.cmd === 0xa7) { const r = decodeA7Reply(fr.payload); if (r) toast(L(r.en, r.zh), r.ok ? "ok" : "bad"); }
      }));
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("blur", releaseAll);
      if (S.link && S.link.connected && S.link.authed) S.link.readStatus().catch(() => {});
    },
    leave() {
      releaseAll();
      clearInterval(timer);
      offs.splice(0).forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", releaseAll);
    },
  };
});
