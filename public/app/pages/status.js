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
const LIGHTS = [["pulseHighBeam", "lamp-high"], ["pulseFrontFog", "fog-front"], ["pilotFrontFog", "fog-front"], ["pulseRearFog", "fog-rear"], ["pilotRearFog", "fog-rear"]];
const COMFORT = [["batteryHeat", "thermometer-sun"], ["chargeDoor", "plug-zap"], ["driverMassage", "waves"], ["passengerMassage", "waves"], ["pulseHorn", "megaphone"]];
const DRIVING = [["sportMode", "zap"], ["offRearMotor", "power-off"], ["offFrontMotor", "power-off"], ["offESP", "shield-off"]];
const DOOR_ICON = { 0: "door-open", 1: "door-open", 2: "door-open", 3: "door-open", 8: "package", 9: "package", 10: "inbox", 11: "flip-horizontal-2", 22: "lock", 23: "lock-open" };
const DOOR_LABEL = {
  0: ["Front left", "左前门"], 1: ["Front right", "右前门"], 2: ["Rear left", "左后门"], 3: ["Rear right", "右后门"],
  8: ["Frunk", "前备箱"], 9: ["Trunk", "后备箱"], 10: ["Glovebox", "储物箱"], 11: ["Mirrors", "后视镜"], 22: ["Lock", "锁车"], 23: ["Unlock", "解锁"],
};
const ARROW = { "shangxiazuoyou-3": "chevron-left", "shangxiazuoyou-": "chevron-right", "shangxiazuoyou-2": "chevron-up", "shangxiazuoyou-1": "chevron-down", ok: "check" };
const MEM_ICON = { louying: "tent", lingzhongli: "crown" };
const MEM_LABEL = { louying: ["Camp", "露营"], lingzhongli: ["Queen", "女王"] };
// Telltale colour, as on the instrument cluster: green = active, blue = high beam, amber = a driving system is changed.
const TONE = { pulseHighBeam: "t-blue", sportMode: "t-amber", offRearMotor: "t-amber", offFrontMotor: "t-amber", offESP: "t-amber" };

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
  const sec = (en, zh, help) => h("div", { class: "sec-label" }, h("span", { class: "sec-title" }, h("span", null, L(en, zh)), help || null));
  const grp = (...kids) => h("section", { class: "grp" }, kids);
  function switchItem([id, ico]) {
    const r = ROW_BY_ID[id];
    if (!shown(r)) return null;
    const label = { en: r.en, zh: r.zh };
    const sw = toggle({ checked: null, label: L(label), onchange: v => onSwitch(r, v) });
    sw.dataset.id = `sw-${id}`;
    const tone = TONE[id] || "";
    const chip = h("span", { class: "chip " + tone }, icon(ico, 22));
    switches[id] = { sw, chip, sub: null, ico, tone, name: L(label) };
    return h("div", { class: "li", "data-row": id },
      chip, nameButton(L(label), r.help),
      sw);
  }
  // The row name is a button that opens the help text of the row.
  const nameButton = (name, help, sub) => h("button", { class: "li-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + name,
    onclick: () => showHelp(help, name) }, h("div", { class: "li-title" }, h("span", null, name)), sub || null);
  const listCard = (items, cls = "") => h("div", { class: "card " + cls }, items.filter(Boolean));

  function emptyState() {
    const supported = S.mock || WebLink.available();
    let all = false;
    const allBox = h("input", { type: "checkbox", id: "allDev" });
    allBox.addEventListener("change", () => { all = allBox.checked; });
    el.append(
      h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip blue" }, icon("bluetooth", 24)),
        h("h2", null, L("Connect to your TSL6", "连接您的 TSL6")),
        h("p", null, supported
          ? L("Pick TSL6 in the Bluetooth list that the browser shows.", "在浏览器显示的蓝牙列表中选择 TSL6。")
          : L("This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer, or Bluefy on iPhone.",
            "此浏览器不支持网页蓝牙。请在安卓或电脑上使用 Chrome / Edge，iPhone 请使用 Bluefy。")),
        supported ? btn({ en: "Connect", zh: "连接" }, () => connect({ all }), { kind: "primary" }) : null,
        supported ? h("label", { class: "check" }, allBox, L("Show all devices", "显示所有设备")) : null)),
      sec("Before you connect", "连接前"),
      h("div", { class: "card pad" }, h("ol", { class: "steps" },
        h("li", null, L("Keep the car awake (climate or Camp mode on).", "保持车辆唤醒（打开空调或露营模式）。")),
        h("li", null, L("Close the vendor Mini App. The module takes one phone at a time.", "关闭原厂小程序，模块一次只连接一部手机。")),
        h("li", null, L("The default BLE password is 1234.", "默认蓝牙密码为 1234。")))));
    el.querySelector(".btn.primary")?.setAttribute("data-id", "connect");
  }

  function lockedState() {
    el.append(
      h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip amber" }, icon("key-round", 24)),
        h("h2", null, L("Enter the BLE password", "请输入蓝牙密码")),
        h("p", null, L("The module sends car data after the password.", "验证密码后模块才发送车辆数据。")),
        h("button", { class: "btn primary", type: "button", "data-id": "enter-password", onclick: () => askPassword("manual") }, L("Enter password", "输入密码")))));
  }

  function build() {
    clear(el);
    const link = S.link;
    const live = !!(link && link.connected && S.status && !S.blank);
    el.className = "page" + (live ? " cols" : " narrow");
    if (!link || !link.connected) return emptyState();
    if (!S.status || S.blank) return lockedState();

    // Cluster: the vehicle, the three CAN buses and a telltale for each function that is on.
    const vt = ROW_BY_ID.vehicleType;
    refs.vehicleName = h("div", { class: "vehicle-name" }, "—");
    refs.pills = h("div", { class: "cl-bus" });
    refs.tt = h("div", { class: "cl-tt", role: "group", "aria-label": L("Functions that are on", "已开启的功能") });
    const vcard = h("div", { class: "card cluster span", "data-row": "vehicleType" },
      h("div", { class: "cl-head vehicle" },
        h("div", { class: "cl-name" }, refs.vehicleName, helpButton(vt.help, { en: vt.en, zh: vt.zh })),
        h("button", { class: "cl-gauge", type: "button", "data-id": "open-gauges", onclick: () => go("gauge") }, icon("gauge", 18), h("span", null, L("Gauges", "仪表盘")))),
      refs.pills, refs.tt);
    pressable(vcard, { onlong: vehicleLongPress }); // long press: CAN1-3 state, as in the vendor app
    el.append(vcard);

    // AP assist
    const ap = ROW_BY_ID.apAssist;
    const apSw = toggle({ checked: null, label: L(ap.en, ap.zh), onchange: v => onSwitch(ap, v) });
    apSw.dataset.id = "sw-apAssist";
    refs.apSub = h("div", { class: "hero-sub" }, "—");
    refs.apChip = h("span", { class: "chip" }, icon("hand", 28));
    switches.apAssist = { sw: apSw, chip: refs.apChip, sub: null, ico: "hand", tone: "", name: L(ap.en, ap.zh) };
    const apName = L("AP assist (no-nag)", "AP辅助（免打扰）");
    el.append(grp(sec("Driver assist", "辅助驾驶"),
      h("div", { class: "card lead" },
        h("div", { class: "hero", "data-row": "apAssist" }, refs.apChip,
          h("button", { class: "li-text hero-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + apName, onclick: () => showHelp(ap.help, L(ap.en, ap.zh)) },
            h("div", { class: "hero-title" }, h("span", null, apName)), refs.apSub),
          apSw)),
      listCard(ASSIST.map(switchItem)),
      h("p", { class: "sec-foot" }, L("Tap a name to see what it does.", "点击名称查看说明。"))));

    el.append(grp(sec("Lights", "灯光"), listCard(LIGHTS.map(switchItem))));
    el.append(grp(sec("Comfort and charging", "舒适与充电"), listCard(COMFORT.map(switchItem))));

    // Doors and access
    const doorRow = ROW_BY_ID.openDoor, ctl = ROW_BY_ID.control;
    const tapBtn = (r, b) => {
      const [en, zh] = DOOR_LABEL[b.btn] || [b.en, b.info || b.en];
      return h("button", { class: "act", type: "button", "data-id": `tap-${b.btn}`, onclick: () => onTap(r, b) }, icon(DOOR_ICON[b.btn] || "circle-dot", 22), h("span", null, L(en, zh)));
    };
    const ctlButtons = ctl && shown(ctl) ? ctl.buttons.filter(b => (!b.types || b.types.includes(S.hwType)) && !b.vendorGate) : [];
    // One plan-view grid: doors at the four corners, frunk and trunk on the centre line (CSS places each button).
    const taps = [...(shown(doorRow) ? doorRow.buttons.map(b => tapBtn(doorRow, b)) : []), ...ctlButtons.map(b => tapBtn(ctl, b))];
    if (taps.length) el.append(grp(sec("Doors and access", "车门与开启", helpButton(doorRow.help, { en: doorRow.en, zh: doorRow.zh })),
      h("div", { class: "card" }, h("div", { class: "acts plan" }, taps))));

    // Seats
    const seatBlock = (moveId, memId, en, zh) => {
      const mv = ROW_BY_ID[moveId], mem = ROW_BY_ID[memId];
      if (!shown(mv) && !shown(mem)) return null;
      return h("div", { class: "seat" },
        h("div", { class: "subhead" }, h("span", null, L(en, zh)), shown(mv) ? helpButton(mv.help, { en: mv.en, zh: mv.zh }) : null),
        shown(mv) ? h("div", { class: "acts arrows" }, mv.buttons.map(b => hold(0xa7, b.btn, A7_RELEASE, icon(ARROW[b.icon], 22), L(b.en)))) : null,
        shown(mem) ? h("div", { class: "acts five" }, mem.buttons.map(b => {
          const lab = MEM_LABEL[b.icon];
          const e = h("button", { class: "act", type: "button", "data-id": `mem-${b.btn}`, "aria-label": L(b.en) },
            b.text ? h("b", null, b.text) : icon(MEM_ICON[b.icon], 20), h("span", null, lab ? L(...lab) : L("Memory", "记忆")));
          return pressable(e, { ontap: () => onMemory(mem, b, false), onlong: () => onMemory(mem, b, true) });
        })) : null);
    };
    const seats = [seatBlock("driverSeat", "driverMemory", "Driver", "主驾"), seatBlock("passengerSeat", "passengerMemory", "Passenger", "副驾")].filter(Boolean);
    if (seats.length) el.append(grp(sec("Seats", "座椅", helpButton("help_sideMemory", { en: "Seat memory", zh: "座椅记忆" })),
      h("div", { class: "card" }, seats), h("p", { class: "sec-foot" }, L("Hold an arrow to move. Tap a memory to recall it, hold it to save.",
        "按住箭头移动。点击记忆位置恢复，长按保存。"))));

    // Scroll wheel
    const wheel = ROW_BY_ID.wheel;
    if (shown(wheel)) {
      const B = Object.fromEntries(wheel.buttons.map(b => [b.btn, hold(0xa2, b.btn, A2_RELEASE, icon(ARROW[b.icon] || "check", 22), L(b.en))]));
      for (const b of Object.values(B)) b.classList.add("pad");
      const label = h("span", null, L("Scroll wheel", "模拟滚轮"));
      const head = h("div", { class: "sec-label" }, h("span", { class: "sec-title" }, label, helpButton(wheel.help, { en: wheel.en, zh: wheel.zh })));
      pressable(label, { onlong: wheelLongPress }); // long press: C1 query, as in the vendor app
      el.append(grp(head, h("div", { class: "card" }, h("div", { class: "dpad" }, h("span"), B[1], h("span"), B[4], B[5], B[2], h("span"), B[3], h("span")))));
    }

    // Driving systems
    const drive = DRIVING.map(switchItem).filter(Boolean);
    if (drive.length) {
      el.append(grp(sec("Driving systems", "驾驶系统"),
        h("div", { class: "card caution" },
          S.prefs.allowDrive ? null : h("div", { class: "notice" }, icon("shield-alert", 18),
            h("span", null, L("Locked. To unlock, turn on ", "已锁定。如需解锁，请打开"),
              h("button", { class: "linkish", type: "button", onclick: () => switchTab("me") }, L("Device > Allow driving-system controls", "设备 > 允许驾驶系统控制")), ".")),
          drive)));
    }
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
      // A bus with data is a solid lit lane; a bus without data is a dashed dark lane.
      live.can.forEach((on, i) => {
        const name = on ? L(`CAN${i + 1} connected`, `CAN${i + 1} 已连接`) : L(`CAN${i + 1} not connected`, `CAN${i + 1} 未连接`);
        refs.pills.append(h("span", { class: "lane" + (on ? " on" : ""), role: "img", "aria-label": name, title: name }, `CAN${i + 1}`, h("i")));
      });
      if (live.harnessUnplugged) refs.pills.append(h("span", { class: "pill bad" }, L("Harness not plugged in", "线束未插好")));
      clear(refs.tt);
      const lit = live.blank ? [] : Object.entries(switches).filter(([id]) => live.toggles[id] === true);
      if (!lit.length) refs.tt.append(h("span", { class: "cl-none" }, L("No function is on", "没有开启的功能")));
      for (const [, s] of lit) refs.tt.append(h("span", { class: "tt " + s.tone }, icon(s.ico, 20), h("span", null, s.name)));
    }
    clearInterval(timer);
    if (refs.apSub) {
      countdown = live.timerMs / 1000;
      const draw = () => {
        clear(refs.apSub);
        if (live.assistActive) refs.apSub.append(L("On, next tick in ", "开启，"), h("b", null, L(`${countdown.toFixed(1)} s`, `${countdown.toFixed(1)} 秒后拨动`)));
        else refs.apSub.append(L("Off", "关闭"));
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
