// Car tab (vendor pages/index): vehicle, AP assist, lights, comfort, doors, seats, scroll wheel, driving systems.
// The command logic is the same as before the redesign; only the grouping and the look changed.
import { h, L, toggle, icon, holdButton, pressable, toast, alertBox, showHelp, btn, helpButton, clear } from "../ui.js";
import { S, definePage, onBus, send, ask, gate, rereadSoon, go, log, connect, askPassword, switchTab } from "../app.js";
import { WebLink } from "../ble.js";
import {
  STATUS_ROWS, ROW_BY_ID, A7_HARD_GATED, A7_RELEASE, A2_RELEASE, decodeLiveState, switchCommand, memoryCommand, tapCommand,
  canStateText, formatC1Reply, decodeA7Reply,
} from "../../lib/tsl6-status.js";

const shown = r => r && (!r.types || r.types.includes(S.hwType));

// Switch rows by section. Icons are Lucide names.
const ASSIST = [["apAutoState", "rotate-cw"], ["vehicleAPState", "navigation"]];
const LIGHTS = [["pulseHighBeam", "siren"], ["pulseFrontFog", "cloud-fog"], ["pilotFrontFog", "lamp"], ["pulseRearFog", "cloud-fog"], ["pilotRearFog", "lamp"]];
const COMFORT = [["batteryHeat", "thermometer-sun"], ["chargeDoor", "plug-zap"], ["driverMassage", "waves"], ["passengerMassage", "waves"], ["pulseHorn", "megaphone"]];
const DRIVING = [["sportMode", "zap"], ["offRearMotor", "power-off"], ["offFrontMotor", "power-off"], ["offESP", "shield-off"]];
const DOOR_ICON = { 0: "door-open", 1: "door-open", 2: "door-open", 3: "door-open", 8: "package-open", 9: "package", 10: "inbox", 11: "flip-horizontal-2", 22: "lock", 23: "lock-open" };
const DOOR_LABEL = {
  0: ["Front left", "左前门"], 1: ["Front right", "右前门"], 2: ["Rear left", "左后门"], 3: ["Rear right", "右后门"],
  8: ["Frunk", "前备箱"], 9: ["Trunk", "后备箱"], 10: ["Glovebox", "储物箱"], 11: ["Mirrors", "后视镜"], 22: ["Lock", "锁车"], 23: ["Unlock", "解锁"],
};
const ARROW = { "shangxiazuoyou-3": "chevron-left", "shangxiazuoyou-": "chevron-right", "shangxiazuoyou-2": "chevron-up", "shangxiazuoyou-1": "chevron-down", ok: "check" };
const MEM_ICON = { louying: "tent", lingzhongli: "crown" };
const MEM_LABEL = { louying: ["Camp", "露营"], lingzhongli: ["Queen", "女王"] };

definePage("status", () => {
  const el = h("div", { class: "page", "data-page": "car" });
  const switches = {};
  const subs = {};
  const held = new Set();
  let timer = 0, countdown = 0;
  const refs = {};

  // ---- one hold button (seat A7 or wheel A2): press frame, then exactly one release frame
  function hold(type, value, releaseValue, content, label) {
    const b = h("button", { class: "act hold", type: "button", "aria-label": label, title: label, "data-id": `hold-${type.toString(16)}-${value}` }, content);
    let pressed = null;
    holdButton(b, {
      onpress: () => {
        held.add(b);
        pressed = (async () => {
          if (!(await gate(type))) return false;                // first-use warning; this press then does nothing
          if (!held.has(b)) return false;                       // released while the warning was open: no press, no release
          try { await S.link.send(type, Uint8Array.of(value)); return true; } catch (e) { log(`press failed: ${e.message}`, "bad"); return false; }
        })();
      },
      onrelease: () => {
        held.delete(b);
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
    return b;
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

  // ---- building blocks
  const sec = (en, zh, side) => h("div", { class: "sec-label" }, h("span", null, L(en, zh)), side || null);
  function switchItem([id, ico]) {
    const r = ROW_BY_ID[id];
    if (!shown(r)) return null;
    const label = { en: r.en, zh: r.zh };
    const sw = toggle({ checked: null, label: L(label), onchange: v => onSwitch(r, v) });
    sw.dataset.id = `sw-${id}`;
    const chip = h("span", { class: "chip" }, icon(ico, 18));
    const sub = h("span", { class: "li-sub" }, "—");
    switches[id] = { sw, chip, sub };
    return h("div", { class: "li", "data-row": id },
      chip,
      h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(label)), helpButton(r.help, label)), sub),
      sw);
  }
  const listCard = (items, cls = "") => h("div", { class: "card " + cls }, items.filter(Boolean));

  function emptyState() {
    const supported = S.mock || WebLink.available();
    let all = false;
    const allBox = h("input", { type: "checkbox", id: "allDev" });
    allBox.addEventListener("change", () => { all = allBox.checked; });
    el.append(
      h("h1", { class: "lg-title" }, L("Car", "车辆")),
      h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip blue" }, icon("bluetooth", 26)),
        h("h2", null, L("Connect to your TSL6", "连接您的 TSL6")),
        h("p", null, supported
          ? L("Your browser shows a list of nearby modules. Pick the one named TSL6.", "浏览器会列出附近的模块，请选择名为 TSL6 的设备。")
          : L("This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer, or Bluefy on iPhone.",
            "此浏览器不支持网页蓝牙。请在安卓或电脑上使用 Chrome / Edge，iPhone 请使用 Bluefy。")),
        supported ? btn({ en: "Connect", zh: "连接" }, () => connect({ all }), { kind: "primary" }) : null,
        supported ? h("label", { class: "row-note", style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "10px" } }, allBox, L("Show all devices", "显示所有设备")) : null)),
      sec("Before you connect", "连接前"),
      h("div", { class: "card pad" }, h("ol", { class: "steps" },
        h("li", null, L("Keep the car awake (climate or Camp mode on).", "保持车辆唤醒（打开空调或露营模式）。")),
        h("li", null, L("Close the vendor Mini App. The module takes one phone at a time.", "关闭原厂小程序，模块一次只连接一部手机。")),
        h("li", null, L("The default BLE password is 1234.", "默认蓝牙密码为 1234。")))));
    el.querySelector(".btn.primary")?.setAttribute("data-id", "connect");
  }

  function lockedState() {
    el.append(
      h("h1", { class: "lg-title" }, L("Car", "车辆")),
      h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip amber" }, icon("key-round", 26)),
        h("h2", null, L("Enter the BLE password", "请输入蓝牙密码")),
        h("p", null, L("The module sends the car data after it accepts the password.", "模块验证密码后才会发送车辆数据。")),
        h("button", { class: "btn primary", type: "button", "data-id": "enter-password", onclick: () => askPassword("manual") }, L("Enter password", "输入密码")))));
  }

  function build() {
    clear(el);
    const link = S.link;
    if (!link || !link.connected) return emptyState();
    if (!S.status || S.blank) return lockedState();

    // Vehicle
    const vt = ROW_BY_ID.vehicleType;
    refs.vehicleName = h("div", { class: "vehicle-name" }, "—");
    refs.pills = h("div", { class: "pills vehicle-sub" });
    const vcard = h("div", { class: "card", "data-row": "vehicleType" }, h("div", { class: "vehicle" },
      h("span", { class: "chip blue" }, icon("car-front", 26)),
      h("div", { class: "li-text" },
        h("div", { class: "li-title" }, refs.vehicleName, helpButton(vt.help, { en: vt.en, zh: vt.zh })),
        h("div", { class: "li-sub" }, L("Detected by the module", "模块识别的车型"))),
      h("button", { class: "ibtn", type: "button", "data-id": "open-gauges", "aria-label": L("Gauges", "仪表盘"), title: L("Gauges", "仪表盘"), onclick: () => go("gauge") }, icon("gauge", 20))),
      h("div", { class: "vehicle-foot" }, refs.pills));
    pressable(vcard, { onlong: vehicleLongPress }); // long press: CAN1-3 state, as in the vendor app
    el.append(h("h1", { class: "lg-title" }, L("Car", "车辆")), vcard);

    // AP assist
    const ap = ROW_BY_ID.apAssist;
    const apSw = toggle({ checked: null, label: L(ap.en, ap.zh), onchange: v => onSwitch(ap, v) });
    apSw.dataset.id = "sw-apAssist";
    refs.apSub = h("div", { class: "hero-sub" }, "—");
    refs.apChip = h("span", { class: "chip" }, icon("hand", 20));
    switches.apAssist = { sw: apSw, chip: refs.apChip, sub: null };
    el.append(sec("Driver assist", "辅助驾驶"),
      listCard([
        h("div", { class: "hero", "data-row": "apAssist" }, refs.apChip,
          h("div", { class: "hero-text" }, h("div", { class: "hero-title" }, h("span", null, L("AP assist (no-nag)", "AP辅助（免打扰）")), helpButton(ap.help, { en: ap.en, zh: ap.zh })), refs.apSub),
          apSw),
        ...ASSIST.map(switchItem)]));

    el.append(sec("Lights", "灯光"), listCard(LIGHTS.map(switchItem)));
    el.append(sec("Comfort and charging", "舒适与充电"), listCard(COMFORT.map(switchItem)));

    // Doors and access
    const doorRow = ROW_BY_ID.openDoor, ctl = ROW_BY_ID.control;
    const tapBtn = (r, b) => {
      const [en, zh] = DOOR_LABEL[b.btn] || [b.en, b.info || b.en];
      return h("button", { class: "act", type: "button", "data-id": `tap-${b.btn}`, onclick: () => onTap(r, b) }, icon(DOOR_ICON[b.btn] || "circle-dot", 22), h("span", null, L(en, zh)));
    };
    const ctlButtons = ctl && shown(ctl) ? ctl.buttons.filter(b => (!b.types || b.types.includes(S.hwType)) && !b.vendorGate) : [];
    el.append(sec("Doors and access", "车门与开启", helpButton(doorRow.help, { en: doorRow.en, zh: doorRow.zh })),
      h("div", { class: "card" },
        shown(doorRow) ? h("div", { class: "acts" }, doorRow.buttons.map(b => tapBtn(doorRow, b))) : null,
        h("div", { class: "acts", style: { paddingTop: 0 } }, ctlButtons.filter(b => b.btn < 12).map(b => tapBtn(ctl, b))),
        ctlButtons.some(b => b.btn >= 12) ? h("div", { class: "acts two", style: { paddingTop: 0 } }, ctlButtons.filter(b => b.btn >= 12).sort((a, b) => b.btn - a.btn).map(b => tapBtn(ctl, b))) : null));

    // Seats
    const seatBlock = (moveId, memId, en, zh) => {
      const mv = ROW_BY_ID[moveId], mem = ROW_BY_ID[memId];
      if (!shown(mv) && !shown(mem)) return null;
      return h("div", { class: "seat" },
        h("div", { class: "subhead", style: { display: "flex", alignItems: "center", gap: "2px" } }, h("span", null, L(en, zh)), shown(mv) ? helpButton(mv.help, { en: mv.en, zh: mv.zh }) : null),
        shown(mv) ? h("div", { class: "acts" }, mv.buttons.map(b => hold(0xa7, b.btn, A7_RELEASE, icon(ARROW[b.icon], 22), L(b.en)))) : null,
        shown(mem) ? h("div", { class: "acts five", style: { gridTemplateColumns: "repeat(5, minmax(0, 1fr))", paddingTop: 0 } }, mem.buttons.map(b => {
          const lab = MEM_LABEL[b.icon];
          const e = h("button", { class: "act", type: "button", "data-id": `mem-${b.btn}`, "aria-label": L(b.en) },
            b.text ? h("b", { style: { fontSize: "17px" } }, b.text) : icon(MEM_ICON[b.icon], 20), h("span", null, lab ? L(...lab) : L(`Memory ${b.text}`, `记忆 ${b.text}`)));
          return pressable(e, { ontap: () => onMemory(mem, b, false), onlong: () => onMemory(mem, b, true) });
        })) : null);
    };
    const seats = [seatBlock("driverSeat", "driverMemory", "Driver", "主驾"), seatBlock("passengerSeat", "passengerMemory", "Passenger", "副驾")].filter(Boolean);
    if (seats.length) el.append(sec("Seats", "座椅", helpButton("help_sideMemory", { en: "Seat memory", zh: "座椅记忆" })),
      h("div", { class: "card" }, seats), h("p", { class: "sec-foot" }, L("Hold an arrow to move the seat. Tap a memory to recall it; hold it to save the current position.",
        "按住箭头移动座椅。点击记忆位置恢复，长按保存当前位置。")));

    // Scroll wheel
    const wheel = ROW_BY_ID.wheel;
    if (shown(wheel)) {
      const B = Object.fromEntries(wheel.buttons.map(b => [b.btn, hold(0xa2, b.btn, A2_RELEASE, icon(ARROW[b.icon] || "check", 22), L(b.en))]));
      for (const b of Object.values(B)) b.classList.add("pad");
      const label = h("span", null, L("Scroll wheel", "模拟滚轮"));
      const head = h("div", { class: "sec-label" }, h("span", { style: { display: "flex", alignItems: "center", gap: "2px" } }, label, helpButton(wheel.help, { en: wheel.en, zh: wheel.zh })));
      pressable(label, { onlong: wheelLongPress }); // long press: C1 query, as in the vendor app
      el.append(head, h("div", { class: "card" }, h("div", { class: "dpad" }, h("span"), B[1], h("span"), B[4], B[5], B[2], h("span"), B[3], h("span"))));
    }

    // Driving systems
    const drive = DRIVING.map(switchItem).filter(Boolean);
    if (drive.length) {
      el.append(sec("Driving systems", "驾驶系统"),
        h("div", { class: "card caution" },
          S.prefs.allowDrive ? null : h("div", { class: "notice" }, icon("shield-alert", 18),
            h("span", null, L("Motor off and ESP off are locked. To unlock them, open ", "关闭电机与关闭ESP已锁定。如需解锁，请打开"),
              h("button", { class: "linkish", type: "button", onclick: () => switchTab("me") }, L("Device > Allow driving-system controls", "设备 > 允许驾驶系统控制")), ".")),
          drive));
    }
    el.append(h("p", { class: "foot" }, L("Switches show the state that the module reports.", "开关状态以模块回传为准。")));
  }

  function update(p) {
    if (!p || S.blank) return;
    const live = decodeLiveState(p, S.hwType);
    for (const [id, s] of Object.entries(switches)) {
      const on = live.blank ? null : live.toggles[id];
      s.sw.set(on);
      s.chip.classList.toggle("on", on === true);
      if (s.sub) { s.sub.textContent = on == null ? "—" : on ? L("On", "开启") : L("Off", "关闭"); s.sub.classList.toggle("on", on === true); }
    }
    if (refs.vehicleName) {
      refs.vehicleName.textContent = L(live.vehicle.en, live.vehicle.zh);
      clear(refs.pills);
      if (live.harnessUnplugged) refs.pills.append(h("span", { class: "pill bad" }, L("Harness not plugged in", "线束未插好")));
      live.can.forEach((on, i) => refs.pills.append(h("span", { class: "pill" + (on ? " ok" : "") }, `CAN${i + 1} ${on ? "✓" : "–"}`)));
    }
    clearInterval(timer);
    if (refs.apSub) {
      countdown = live.timerMs / 1000;
      const draw = () => {
        clear(refs.apSub);
        if (live.assistActive) refs.apSub.append(L("On · next tick in ", "开启 · "), h("b", null, L(`${countdown.toFixed(1)} s`, `${countdown.toFixed(1)} 秒后`)));
        else refs.apSub.append(L("Off · the module does not tick the wheel", "关闭 · 模块不操作滚轮"));
      };
      draw();
      if (live.assistActive) timer = setInterval(() => { countdown = Math.max(0, countdown - 0.1); draw(); if (!countdown) clearInterval(timer); }, 100);
    }
  }

  function render() { releaseAll(); clearInterval(timer); build(); update(S.status); }

  const offs = [];
  render();
  return {
    el,
    enter() {
      offs.push(onBus("status", p => { const was = !!el.querySelector('[data-row="vehicleType"]'); if (!was || S.blank) render(); else update(p); }));
      offs.push(onBus("conn", st => { if (!st.connected) releaseAll(); render(); }));
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
