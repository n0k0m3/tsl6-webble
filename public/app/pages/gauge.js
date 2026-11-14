// Phone gauge (vendor pages/gauge, 仪表盘). Full screen, landscape layout.
// Stream: B0 01 on enter and every 1 s (keep-alive), B0 00 on leave or hidden page. The module streams B0 frames.
// The vendor draws with page elements, icon glyphs and CSS gradients. We do the same with HTML, CSS and inline SVG.
// Positions are in em of the vendor page font. The stage font size scales with the screen.
import { h, L, clear, icon, toast, alertBox, pressable } from "../ui.js";
import { S, definePage, onBus, send, gate, go } from "../app.js";
import {
  B0, startPayload, stopPayload, KEEPALIVE_MS, DRIVE_GEAR, GAUGE_CAR_ACTIONS, CORNER_CYCLE,
  decodeGauge, formatGauge, speedText, clockText, driveTimeText, doorsOpen, lightsOn,
  iconOff, textOn, AUTOPILOT_COLOR, BLIND_SPOT_RGB, BATT_HEAT_COLOR, TIRE_LOW_BAR, BRAKE_HOT_C, powerBarPct,
  accelTestToggle, accelTestStep, promptDiag,
} from "../../lib/tsl6-gauge.js";
import { tapCommand, switchCommand } from "../../lib/tsl6-status.js";
import { decodeSettings, isPromptTime } from "../../lib/tsl6-settings.js";

// The prompt build has no altitude: in a prompt mode the altitude corner shows how many prompts it answered (modulo 16).
function promptMode() {
  try { return isPromptTime(decodeSettings(S.status).time); } catch { return false; }
}
import { loadGaugePrefs } from "./gaugemenu.js";

if (!document.querySelector('link[data-page="gauge"]')) {
  document.head.append(h("link", { rel: "stylesheet", href: new URL("./gauge.css", import.meta.url).href, "data-page": "gauge" }));
}

const STALE_MS = 2500;   // older data does not count for car actions
const P_GEAR = 1;

// ---------------------------------------------------------------- glyphs (own drawings, 24 x 24)
const GLYPH = {
  back: { d: "M15 5l-7 7 7 7" },
  turnL: { d: "M2 12l9-8v4.5h11v7H11V20z", fill: true },
  turnR: { d: "M22 12l-9-8v4.5H2v7h11V20z", fill: true },
  heat: { d: "M3 7h16v11H3zM19 10.5h2v4h-2M7 15.5c1.2-1.2-.6-2.8.6-4M11 15.5c1.2-1.2-.6-2.8.6-4M15 15.5c1.2-1.2-.6-2.8.6-4" },
  frontFog: { d: "M14 5.5c4.2 0 7 2.9 7 6.5s-2.8 6.5-7 6.5zM3 8h8M3 12h8M3 16h8M7 4.5c-1.4 2.5 1.4 5 0 7.5s1.4 5 0 7.5" },
  rearFog: { d: "M10 5.5c-4.2 0-7 2.9-7 6.5s2.8 6.5 7 6.5zM13 8h8M13 12h8M13 16h8M17 4.5c-1.4 2.5 1.4 5 0 7.5s1.4 5 0 7.5" },
  position: { d: "M9.5 7.5a4.5 4.5 0 0 0 0 9zM14.5 7.5a4.5 4.5 0 0 1 0 9zM1.5 8.5l3 1.2M1.5 15.5l3-1.2M1 12h3.5M22.5 8.5l-3 1.2M22.5 15.5l-3-1.2M23 12h-3.5" },
  lowBeam: { d: "M14 5.5c4.2 0 7 2.9 7 6.5s-2.8 6.5-7 6.5zM11 8L3 10.5M11 12L3 14.5M11 16L3 18.5" },
  highBeam: { d: "M14 5.5c4.2 0 7 2.9 7 6.5s-2.8 6.5-7 6.5zM3 8h8M3 12h8M3 16h8" },
  wheel: { d: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4zM3.3 10.5H10M14 10.5h6.7M12 14v7" },
  fan: { d: "M12 12c-1-3.5 0-7.5 2.5-7.5s2.5 4-2.5 7.5zM12 12c3.5-1 7.5 0 7.5 2.5s-4 2.5-7.5-2.5zM12 12c1 3.5 0 7.5-2.5 7.5s-2.5-4 2.5-7.5zM12 12c-3.5 1-7.5 0-7.5-2.5s4-2.5 7.5 2.5z" },
};
const NS = "http://www.w3.org/2000/svg";
function glyph(name) {
  const g = GLYPH[name];
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("fill", g.fill ? "currentColor" : "none");
  s.setAttribute("stroke", g.fill ? "none" : "currentColor");
  s.setAttribute("stroke-width", "1.8"); s.setAttribute("stroke-linecap", "round"); s.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", g.d);
  s.append(p);
  return s;
}

// Gear strip letters: [margin-top em, margin-left em, font-size em] for P R N D. Size 3 = current gear.
const GEAR_POS = [
  [[.35, -2, 2], [.35, -1, 2], [.35, 0, 2], [.35, 1.15, 2]],     // no gear
  [[0, -1.45, 3], [.35, -1, 2], [.35, 0, 2], [.35, 1.15, 2]],    // P
  [[.35, -2, 2], [0, -.8, 3], [.35, 0, 2], [.35, 1.15, 2]],      // R
  [[.35, -2, 2], [.35, -1, 2], [0, -.1, 3], [.35, 1.15, 2]],     // N
  [[.35, -2, 2], [.35, -1, 2], [.35, 0, 2], [0, .65, 3]],        // D
];
// A7 values: 0 FL, 1 FR, 2 RL, 3 RR. Arrays (pressure, brake temperature) use the same order.
const DOORS = [
  { n: 0, key: "fl", icon: "doorFL", x: "left", y: "top" },
  { n: 1, key: "fr", icon: "doorFR", x: "right", y: "top" },
  { n: 2, key: "rl", icon: "doorRL", x: "left", y: "bottom" },
  { n: 3, key: "rr", icon: "doorRR", x: "right", y: "bottom" },
];
const LEFT_TOAST = [["Show odometer", "显示剩总里程"], ["Show altitude", "显示海拔高度"], ["Show clock", "显示北京时间"],
  ["Show drive time", "显示行驶时间"], ["Cycle all values", "自动循环显示"]];
const RIGHT_TOAST = [["Show battery %", "显示剩余电量"], ["Show range", "显示剩余里程"], ["Show cell voltage", "电池电芯电压"],
  ["Show battery temperature", "动力电池温度"], ["Cycle all values", "自动循环显示"]];
const ASPECT_TOAST = [["Follow the car screen", "跟随车机屏幕外观"], ["Dark", "深色外观"], ["Light", "浅色外观"]];
const zh = s => s.replace(/\r/g, "");

let battery = null;   // navigator.getBattery() result, if the browser has it
let batteryAsked = false;

definePage("gauge", () => {
  const stage = h("div", { class: "g-stage", role: "application", "aria-label": L("Gauge", "仪表盘") });
  const el = h("div", { class: "page" }, stage);

  // ---- state
  let prefs = loadGaugePrefs();
  let d = null, fmt = null, lastRx = 0, fullSeen = false;
  let lastGear = 0, dStart = 0, driveText = "00:00";
  let test = { state: 0 };
  let lbMode = 0, rbMode = 0, lbIdx = 0, rbIdx = 0, lbCount = 0, rbCount = 0, aspectMode = 0;
  let keepOn = true, wl = null, wlBusy = false;
  let active = false, timer = 0, raf = 0, split = false, built = "";
  const offs = [];
  let binds = [];

  const ZERO = decodeGauge(new Uint8Array(16));
  function applyPrefs() {
    prefs = loadGaugePrefs();
    lbMode = prefs.gaugeLeftBottom; rbMode = prefs.gaugeRightBottom;
    lbIdx = lbMode >= 4 ? 0 : lbMode; rbIdx = rbMode >= 4 ? 0 : rbMode;
    aspectMode = prefs.gaugeAspect;
  }
  applyPrefs();

  // ---- small builders. bind() registers an update for each render.
  const bind = fn => binds.push(fn);
  const txt = fn => { const n = document.createTextNode(""); bind(V => { const s = String(fn(V)); if (n.data !== s) n.data = s; }); return n; };
  const sty = (node, fn) => { bind(V => Object.assign(node.style, fn(V))); return node; };
  const vis = (node, fn) => { bind(V => { node.hidden = !fn(V); }); return node; };
  const abs = (cls, style, ...kids) => h("div", { class: "g-a " + (cls || ""), style }, ...kids);

  function topButtons(color) {
    stage.append(h("button", { class: "g-btn", type: "button", "aria-label": L("Back", "返回"),
      style: { left: 0, top: 0, margin: split ? ".4em 0 0 1.3em" : ".7em 0 0 1.5em", fontSize: "1.3em", color },
      onclick: () => history.back() }, glyph("back")));
    if (!split) stage.append(h("button", { class: "g-btn", type: "button", "aria-label": L("Gauge settings", "仪表设置"),
      style: { left: 0, top: 0, margin: ".95em 0 0 5em", fontSize: "1.1em", color },
      onclick: () => go("gaugemenu") }, icon("gear")));
    const note = h("span", { class: "g-note", style: { left: split ? "3.6em" : "7.6em", top: split ? ".6em" : "1.15em" } }, txt(V => V.note));
    stage.append(vis(note, V => !!V.note));
  }

  function overlays(light) {
    stage.append(vis(abs("g-hands " + (light ? "light" : "dark")), V => V.handsOn));
    for (const side of [0, 1]) {
      const s = h("div", { class: "g-strip", style: side ? { right: 0 } : { left: 0 } });
      sty(s, V => ({ background: `linear-gradient(to ${side ? "right" : "left"},rgba(255,255,255,0),rgba(${BLIND_SPOT_RGB[V.bs[side]] || "0,0,0"},1))` }));
      stage.append(vis(s, V => V.bs[side] !== 3 && (V.bs[side] > 0 || (!!(V.turn & (side + 1)) && prefs.gaugeTurnSignalStyle === 0))));
    }
  }

  function corners(color, leftPos, rightPos, battPos, leftSize, rightSize) {
    stage.append(abs("g-top g-tap", leftPos, h("span", { style: { fontSize: leftSize, color } }, txt(V => V.lb))));
    stage.lastChild.addEventListener("click", onLeft);
    stage.append(abs("g-top g-tap", rightPos, h("span", { style: { fontSize: rightSize, color } }, txt(V => V.rb))));
    stage.lastChild.addEventListener("click", onRight);
    const b = h("span", { style: { fontSize: "1.4em" } }, txt(V => V.phone));
    sty(b, V => ({ color: V.charging ? "#0dcd0d" : color }));
    stage.append(vis(abs("g-top", battPos, b), V => !!V.phone));
  }

  // ---- types 0 (full) and 1 (simple)
  function buildClassic(light) {
    const off = iconOff(light), on = textOn(light), full = prefs.gaugeType === 0;
    stage.append(h("div", { class: "g-bg" + (!light && !prefs.gaugeAspectBackground ? " img" : ""),
      style: { background: light ? "#fff" : prefs.gaugeAspectBackground ? "#000" : null } }));
    topButtons(light ? "#999" : "#666");
    overlays(light);

    // speed (long press: 0-100 test)
    const sp = h("span", { class: "g-font" }, txt(V => V.speedText));
    sty(sp, V => ({ fontSize: (split ? (V.bigSpeed ? 10 : 4) : (V.bigSpeed ? 11.5 : 7)) + "em",
      color: light ? (V.testOn ? "#ff2222" : "#373737") : (V.testOn ? "#FFFF22" : "#DDD") }));
    const spw = abs("g-mid g-tap", { left: 0, width: "100%", textAlign: "center", top: "50%", transform: "translateY(-50%)", lineHeight: 1 }, sp);
    stage.append(pressable(spw, { onlong: onSpeedLong }));

    // arrow turn signals
    if (prefs.gaugeTurnSignalStyle === 1) {
      for (const side of [0, 1]) {
        const a = abs("g-top g-arrow", { [side ? "right" : "left"]: split ? ".3em" : "3.5em", top: "50%", transform: "translateY(-50%)", color: light ? "#0dc00d" : "#22FF60" },
          h("span", { style: { display: "block", fontSize: split ? "5em" : "6em" } }, glyph(side ? "turnR" : "turnL")));
        stage.append(vis(a, V => !!(V.turn & (side + 1))));
      }
    }

    // doors with tire pressure and brake temperature
    for (const D of DOORS) {
      const right = D.x === "right";
      const ic = sty(h("span", { style: { display: "block", fontSize: split ? "2.6em" : "3em" } }, icon(D.icon)),
        V => ({ color: V.doors[D.key] ? "#ff2222" : "#999" }));
      // Vendor: right-side texts at a negative left offset. With web fonts that overlaps the icon, so we anchor them to its left edge.
      const pr = h("span", { class: "g-a g-nowrap", style: { ...(right ? { right: "100%" } : { left: "1.85em" }), bottom: split ? ".7em" : ".8em", fontSize: "1.5em" } },
        txt(V => V.f.Pressure[D.n]));
      sty(vis(pr, V => V.f.Pressure[D.n] != 0), V => ({ color: V.f.Pressure[D.n] <= TIRE_LOW_BAR ? "#F16A6A" : "#999" }));
      const bt = h("span", { class: "g-a g-nowrap", style: { ...(right ? { right: "100%" } : { left: "2.25em" }), bottom: "-.1em", fontSize: "1.2em" } },
        txt(V => V.f.brakeTemp[D.n] + "℃"));
      sty(vis(bt, V => V.f.brakeTemp[D.n] !== -40), V => ({ color: V.f.brakeTemp[D.n] >= BRAKE_HOT_C ? "#F16A6A" : "#999" }));
      const a = GAUGE_CAR_ACTIONS.find(x => x.a7 === D.n);
      const door = h("div", { class: "g-a g-top g-tap", role: "button", "aria-label": L(a.label, a.zh),
        style: { [D.x]: split ? "1.4em" : "5em", [D.y]: split ? "3em" : "4em" }, onclick: () => onBody(D.n) }, ic, pr, bt);
      stage.append(door);
    }

    // icon row at the top centre
    const row = h("div", { class: "g-light g-top", style: { top: split ? ".05em" : ".5em" } });
    const lamp = (name, mt, ml, fs, color, attrs) => {
      const s = h("span", { class: "g-c", style: { margin: `${mt}em 0 0 ${ml}em`, fontSize: fs + "em" }, ...attrs }, glyph(name));
      row.append(sty(s, V => ({ color: color(V) })));
      return s;
    };
    const apColor = V => AUTOPILOT_COLOR[V.f.autoPilot] || off;
    if (!split) {
      const heat = lamp("heat", .2, -5.7, 1.5, V => (V.f.battHeat === 0 ? off : BATT_HEAT_COLOR[V.f.battHeat] || ""),
        { role: "button", "aria-label": L("Battery preheat", "电池预热") });
      heat.classList.add("g-tap");
      heat.addEventListener("click", onHeat);
      lamp("frontFog", .1, -4, 1.7, V => (V.lights.frontFog ? "#22FF60" : off));
      lamp("rearFog", .1, -2.75, 1.7, V => (V.lights.rearFog ? "#F0C050" : off));
      lamp("position", -.11, -1.1, 2.3, V => (V.lights.position ? "#22FF60" : off));
      lamp("lowBeam", 0, .05, 2, V => (V.lights.lowBeam ? "#22FF60" : off));
      lamp("highBeam", 0, 1.2, 2, V => (V.lights.highBeam ? "#1B66FF" : off));
      lamp("wheel", .16, 2.9, 1.6, apColor);
      const lim = h("span", null, txt(V => V.f.fusedSpeedLimit));
      sty(lim, V => ({ fontSize: V.f.fusedSpeedLimit > 99 ? "1.1em" : "1.3em" }));
      row.append(vis(h("div", { class: "g-limit" }, lim), V => V.f.fusedSpeedLimit > 0));
    } else {
      lamp("position", -.11, -2.1, 2.3, V => (V.lights.position ? "#22FF60" : off));
      lamp("lowBeam", 0, -1.2, 2, V => (V.lights.lowBeam ? "#22FF60" : off));
      lamp("highBeam", 0, -.2, 2, V => (V.lights.highBeam ? "#1B66FF" : off));
      lamp("wheel", .16, 1.05, 1.6, apColor);
    }
    stage.append(row);

    if (split) corners(on, { left: ".3em", bottom: ".6em" }, { right: "1.2em", bottom: ".5em" }, { right: "3.8em", top: ".5em" }, "1.2em", "1.4em");
    else corners(on, { left: "3.5em", bottom: ".7em" }, { right: "5em", bottom: ".7em" }, { right: "7.6em", top: ".55em" }, "1.4em", "1.4em");

    // gear strip (long press: appearance) with the brake light
    const strip = abs("g-gears g-tap", { left: 0, bottom: 0, width: "100%", height: "4em" });
    bind(V => { strip.className = "g-a g-gears g-tap" + (V.brakeOn ? " g-brake " + (light ? "light" : "dark") : ""); });
    const letters = ["P", "R", "N", "D"].map(c => { const s = h("span", { class: "g-c" }, c); strip.append(s); return s; });
    bind(V => {
      const pos = GEAR_POS[V.gear >= 1 && V.gear <= 4 ? V.gear : 0];
      letters.forEach((s, i) => {
        const [mt, ml, fs] = pos[i];
        Object.assign(s.style, { margin: `${mt}em 0 0 ${ml}em`, fontSize: fs + "em", color: fs === 3 ? on : off });
      });
    });
    stage.append(pressable(strip, { onlong: onAspectLong }));

    if (full) {
      // frunk and trunk: shown only at a fresh speed of 0
      const body = (a7, icn, pos) => {
        const b = h("span", { class: "g-a g-top g-tap", role: "button", "aria-label": L(a7 === 8 ? "Frunk" : "Trunk", a7 === 8 ? "前备箱" : "后备箱"),
          style: pos, onclick: () => onBody(a7) }, icon(icn));
        stage.append(sty(vis(b, V => V.bodyShown), V => ({ color: (a7 === 8 ? V.f.frunkIsOpen : V.f.trunkIsOpen) ? "#ff2222" : "#999" })));
      };
      body(8, "frunk", split ? { left: "3.55em", bottom: "1.8em", fontSize: "1.9em" } : { left: "5.6em", bottom: "2em", fontSize: "2.2em" });
      body(9, "trunk", split ? { right: "3.45em", bottom: "1.75em", fontSize: "1.9em" } : { right: "5.5em", bottom: "1.95em", fontSize: "2.2em" });
      // The vendor text starts with a line break, so the value sits one line lower in its box.
      const ped = h("span", { class: "g-font", style: { display: "block", fontSize: "2.1em", marginTop: "1.2em" } }, txt(V => V.f.accelPedalPos + "%"));
      sty(ped, V => ({ color: !V.f.sport ? "#0dcd0d" : light ? "#555" : "#ccc" }));
      stage.append(abs("g-pedal", { left: 0, width: "100%", height: "4em", bottom: "4.4em", textAlign: "center" }, ped));
      const pw = h("span", { class: "g-font", style: { display: "block", fontSize: "2.1em", marginTop: "1.2em", color: light ? "#555" : "#ccc" } },
        txt(V => `${V.f.frontInverterPower}kw   ${V.f.rearInverterPower}kw`));
      stage.append(abs("g-power", { left: 0, width: "100%", height: "4em", top: split ? ".3em" : "1.1em", textAlign: "center" }, pw));
    }

    if (prefs.gaugeAir === 0) {
      for (const side of [0, 1]) {
        const x = side ? "right" : "left";
        const box = abs("g-air", { [x]: split ? ".3em" : side ? "5em" : "4.5em", color: "#888", top: "50%", transform: "translateY(-50%)" });
        const a = side ? V => V.f.tempAmbientRaw + "℃" : V => V.f.hvacBlowerSpeedRPM + " RPM";
        const b = side ? V => V.f.hvacCabinTempEst + "℃" : V => V.f.wattsDemandEvap + " W";
        if (split) {
          box.append(h("span", { class: "g-a g-nowrap", style: { [x]: 0, bottom: ".1em" } }, txt(a)),
            h("span", { class: "g-a g-nowrap", style: { [x]: 0, top: ".1em" } }, txt(b)));
        } else {
          box.append(h("span", { style: { display: "block", fontSize: "2em" } }, glyph("fan")),
            h("span", { class: "g-a g-nowrap", style: { [x]: "2.6em", bottom: "1em" } }, txt(a)),
            h("span", { class: "g-a g-nowrap", style: { [x]: "2.6em", bottom: "-.3em" } }, txt(b)));
        }
        stage.append(vis(box, V => !(prefs.gaugeTurnSignalStyle === 1 && (V.turn & (side + 1)))));
      }
    }
  }

  // ---- type 2 (round dial)
  function buildDial() {
    stage.append(h("div", { class: "g-bg", style: { background: "#000" } }));
    topButtons("#666");
    overlays(false);

    const card = h("div", { class: "g-card" });
    const cell = (pos, title, titleLeft, v1, v2, l1, l2, l2style) => card.append(h("div", { class: "g-cell", style: pos },
      h("span", { style: { top: 0, left: titleLeft } }, title),
      h("span", { class: "v", style: { top: "1.5em", left: ".1em" } }, txt(v1)),
      h("span", { class: "v", style: { top: "1.5em", left: "4.5em" } }, txt(v2)),
      h("span", { style: { top: "2.8em", left: ".1em" } }, l1),
      h("span", { style: { top: "2.8em", left: "4.5em", ...l2style } }, l2)));
    cell({ top: ".6em", left: "1.5em", width: "8em" }, L("Motor power kW", "电机功率 KW"), ".1em",
      V => V.f.frontInverterPower, V => V.f.rearInverterPower, L("Front", "前"), L("Rear", "后"));
    if (prefs.gaugeAir === 0) {
      cell({ bottom: ".4em", left: "1.3em", width: "10em" }, L("A/C", "空调"), ".1em",
        V => V.f.wattsDemandEvap, V => V.f.hvacBlowerSpeedRPM, L("Watts", "功率W"), L("Fan RPM", "转速RPM"), { top: "3.2em", fontSize: ".9em" });
    } else {
      cell({ bottom: ".4em", left: "1.3em", width: "10em" }, L("HV battery", "动力电池"), ".1em",
        V => V.f.RightBottom[2], V => V.f.RightBottom[3], L("Cell", "单体"), L("Temp", "温度"));
    }
    cell({ top: ".6em", right: ".4em", width: "8em" }, L("Remaining", "剩余"), 0,
      V => V.f.RightBottom[1], V => V.f.RightBottom[0], L("Range", "里程"), L("Charge", "电量"));
    cell({ bottom: ".4em", right: ".4em", width: "8em" }, L("Temp ℃", "温度 ℃"), 0,
      V => V.f.tempAmbientRaw, V => V.f.hvacCabinTempEst, L("Outside", "车外"), L("Inside", "车内"));
    card.append(h("div", { class: "g-rule", style: { left: "1em" } }), h("div", { class: "g-rule", style: { right: "1em" } }));

    const dial = h("div", { class: "g-dial g-tap" });
    sty(dial, V => ({ borderColor: V.ap12 ? "#4176FA" : V.overLimit ? "#ff2222" : !V.f.sport ? "#78BE5E" : "#F6931F" }));
    if (prefs.gaugeRainbow === 1) dial.append(vis(h("div", { class: "g-rainbow" }), V => V.ap12));
    if (prefs.gaugeTurnSignalStyle === 1) {
      for (const side of [0, 1]) {
        dial.append(vis(abs("g-arrow", { [side ? "right" : "left"]: ".15em", top: "50%", transform: "translateY(-50%)", color: "#0dc00d", fontSize: "2.3em" },
          glyph(side ? "turnR" : "turnL")), V => !!(V.turn & (side + 1))));
      }
    }
    const prnd = ["P", "R", "N", "D"].map((c, i) => sty(h("span", null, c), V => ({ color: V.gear === i + 1 ? "#FFF" : "#333" })));
    dial.append(abs("g-nowrap", { left: "50%", top: 0, fontSize: "1.3em", marginTop: "1.6em", transform: "translateX(-43%)", letterSpacing: ".5em" }, prnd));
    const sp = h("div", { style: { position: "relative", display: "flex", justifyContent: "center", alignItems: "center", height: "100%", width: "100%", lineHeight: 1 } },
      txt(V => V.speedText));
    dial.append(sty(sp, V => ({ fontSize: (V.bigSpeed ? 5.4 : 3.4) + "em", color: V.testOn ? "#ff2222" : "#FFF" })));
    dial.append(abs("", { left: "50%", top: "100%", marginTop: "-2.6em", transform: "translateX(-50%)", color: "#333", fontSize: "1.3em" },
      txt(V => (V.f.speedUnits ? "KMH" : "MPH"))));
    card.append(pressable(dial, { onlong: onSpeedLong }));
    stage.append(card);

    const fill = h("div");
    sty(fill, V => {
      const neg = V.f.frontInverterPower + V.f.rearInverterPower < 0;
      return { transform: neg ? "translateX(-100%)" : "none", background: neg ? "#78BE5E" : "#DDD",
        width: powerBarPct(V.f.frontInverterPower, V.f.rearInverterPower) / 2 + "%" };
    });
    stage.append(h("div", { class: "g-bar" }, fill));

    const row = h("div", { class: "g-light g-top", style: { top: ".5em" } });
    const heat = h("div", { class: "g-circle g-tap", role: "button", "aria-label": L("Battery preheat", "电池预热"), style: { marginLeft: "-4em" }, onclick: onHeat },
      h("span", { style: { fontSize: "1.4em" } }, glyph("heat")));
    row.append(sty(heat, V => ({ background: ["#333", "#78BE5E", "#F6931F"][V.f.battHeat] || "none" })));
    const ap = h("div", { class: "g-circle" }, h("span", { style: { fontSize: "1.9em" } }, glyph("wheel")));
    row.append(sty(ap, V => ({ background: ["#333", "#4176FA", "#78BE5E", "#777"][V.f.autoPilot] })));
    const lim = sty(h("span", null, txt(V => V.f.fusedSpeedLimit)), V => ({ fontSize: V.f.fusedSpeedLimit > 99 ? "1.1em" : "1.3em" }));
    row.append(h("div", { class: "g-limit", style: { margin: "-.15em 0 0 4em", transform: "translateX(-50%)" } }, lim));
    stage.append(row);

    corners("#DDD", { left: "3.5em", bottom: ".7em" }, { right: "3.5em", bottom: ".7em" }, { right: "7.6em", top: ".55em" }, "1.4em", "1.4em");
    const brake = abs("g-gears", { left: 0, bottom: 0, width: "100%", height: "1em" });
    bind(V => { brake.className = "g-a g-gears" + (V.brakeOn ? " g-brake dark" : ""); });
    stage.append(brake);
  }

  // ---- view model and render
  function lightNow() {
    if (aspectMode === 2) return true;
    if (aspectMode === 1) return false;
    return !!(d && d.carLightTheme);
  }
  function viewModel(light) {
    const now = new Date();
    const f = fmt || formatGauge(ZERO, now);
    const dd = d || ZERO;
    const link = S.link;
    const fresh = !!d && Date.now() - lastRx < STALE_MS;
    const lb = [...f.LeftBottom];
    lb[2] = clockText(now);
    lb[3] = driveText;
    const note = !link || !link.connected ? L("Not connected", "蓝牙未连接")
      : !link.authed ? L("Enter the BLE password", "请输入蓝牙密码")
      : !fresh ? L("Waiting for gauge data…", "等待仪表数据…") : "";
    return {
      f, light, note,
      speedText: d ? speedText(d, now) : clockText(now),
      bigSpeed: !!d && f.bigSpeed,
      testOn: test.state !== 0,
      gear: f.gear || 0, turn: f.turn || 0,
      doors: doorsOpen(dd), lights: lightsOn(dd),
      ap12: f.autoPilot === 1 || f.autoPilot === 2,
      overLimit: !!d && f.bigSpeed && dd.speed > f.fusedSpeedLimit + 10,
      brakeOn: !!(f.light & 32) && prefs.gaugeBrakeLight === 0,
      handsOn: !!f.handsOn && prefs.gaugeHandsOn === 0,
      bs: f.blindSpotRear,
      lb: lb[lbIdx], rb: f.RightBottom[rbIdx],
      bodyShown: fresh && dd.speed === 0,
      phone: battery ? Math.round(battery.level * 100) + "%" : "",
      charging: !!(battery && battery.charging),
    };
  }
  function render() {
    if (!active) return;
    const light = prefs.gaugeType === 2 ? false : lightNow();
    const key = `${prefs.gaugeType}|${split}|${light}|${JSON.stringify(prefs)}`;
    if (key !== built) {
      built = key;
      binds = [];
      clear(stage);
      stage.style.color = light ? "#373737" : "#ddd";
      if (prefs.gaugeType === 2) buildDial(); else buildClassic(light);
    }
    const V = viewModel(light);
    for (const fn of binds) fn(V);
  }
  const soon = () => { if (!raf && active) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

  // Size the stage. A portrait screen gets the landscape gauge turned by 90 degrees.
  function geometry() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const turn = vw / vh < 0.8;
    const W = turn ? vh : vw, H = turn ? vw : vh;
    const r = W / H;
    split = r >= 0.8 && r <= 1.4;
    const base = Math.max(9, Math.min(H / 24.4, W / 40));
    Object.assign(stage.style, {
      width: W + "px", height: H + "px", left: turn ? vw + "px" : "0", top: "0",
      transform: turn ? "rotate(90deg)" : "none", fontSize: base + "px",
    });
    stage.style.setProperty("--px", base / 16 + "px");
  }
  const onResize = () => { geometry(); render(); };

  // ---- stream
  const linkReady = () => !!(S.link && S.link.connected && S.link.authed);
  function keepAlive() {
    if (!active || document.hidden || !linkReady()) return;
    send(B0, startPayload(), { read: true, quiet: true });
  }
  function stopStream() {
    if (linkReady()) send(B0, stopPayload(), { read: true, quiet: true });
  }
  function onFrame(fr) {
    if (fr.cmd !== B0) return;
    const x = decodeGauge(fr.payload);
    if (!x) return;
    const now = new Date();
    fmt = formatGauge(x, now, d ? fmt : undefined);
    if (x.full && promptMode()) fmt.LeftBottom[1] = L(`ack ${promptDiag(x.altitudeRaw).sent}`, `拨动${promptDiag(x.altitudeRaw).sent}`);
    if (x.full) fullSeen = true;
    if (x.gear !== lastGear) { lastGear = x.gear; if (x.gear === DRIVE_GEAR) dStart = Date.now(); }
    d = x;
    lastRx = Date.now();
    keepOn = x.allowScreenSleep === 0;
    const nt = accelTestStep(test, x.speed, Date.now());
    if (nt !== test) {
      test = nt;
      if (nt.event === "start") toast(L("Test started", "测试开始"), "", 1500);
      else if (nt.event === "result") {
        const unit = fmt.speedUnits ? "km/h" : "mph";
        alertBox(L(`0-100 ${unit}: ${nt.seconds} s`, `百公里加速\n本次成绩 ${nt.seconds} 秒`), L("0-100 test", "百公里加速"));
      } else if (nt.event === "tooSlow") toast(L("Too slow. The test ended.", "成绩太次\n退出测试"), "warn", 2500);
    }
    soon();
  }

  function tick() {
    keepAlive();
    if (lastGear === DRIVE_GEAR) driveText = driveTimeText(Date.now() - dStart);
    if (++lbCount >= CORNER_CYCLE) { lbCount = 0; if (lbMode >= 4) lbIdx = (lbIdx + 1) % 4; }
    if (++rbCount >= CORNER_CYCLE) { rbCount = 0; if (rbMode >= 4) rbIdx = (rbIdx + 1) % 4; }
    wake();
    render();
  }

  // Screen wake lock: the vendor keeps the screen on unless the frame allows sleep.
  function wake() {
    const want = active && keepOn && !document.hidden;
    if (want && !wl && !wlBusy && navigator.wakeLock) {
      wlBusy = true;
      navigator.wakeLock.request("screen").then(l => {
        wlBusy = false;
        if (!active) { l.release().catch(() => {}); return; }
        wl = l;
        l.addEventListener("release", () => { if (wl === l) wl = null; });
      }).catch(() => { wlBusy = false; });
    } else if (!want && wl) {
      const l = wl; wl = null;
      l.release().catch(() => {});
    }
  }
  const onVis = () => {
    if (document.hidden) stopStream(); else keepAlive();
    wake();
  };

  // ---- taps
  function onLeft() {
    lbMode = (lbMode + 1) % 5;
    if (lbMode <= 3) lbIdx = lbMode;
    toast(L(...LEFT_TOAST[lbMode]), "", 2000);
    render();
  }
  function onRight() {
    rbMode = (rbMode + 1) % 5;
    if (rbMode <= 3) rbIdx = rbMode;
    toast(L(...RIGHT_TOAST[rbMode]), "", 2000);
    render();
  }
  function onAspectLong() {
    aspectMode = (aspectMode + 1) % 3;
    toast(L(...ASPECT_TOAST[aspectMode]), "", 1500);
    render();
  }
  function onSpeedLong() {
    const r = accelTestToggle(test.state, d);
    test = { state: r.state };
    toast(L(r.label, zh(r.zh)), "", 3000);
    render();
  }

  // Doors, frunk and trunk move car parts. The vendor sends at once and checks only "speed > 0",
  // which passes when the big text shows the clock. We fail closed: fresh data, gear P, speed 0, and a confirm.
  function moveBlocker() {
    if (!S.link || !S.link.connected) return { en: "Connect to the module first.", zh: "请先连接蓝牙" };
    if (!d || Date.now() - lastRx >= STALE_MS) return { en: "No live data from the car. The app cannot check the gear.", zh: "无车辆实时数据，无法确认档位" };
    if (d.gear !== P_GEAR) return { en: "Shift to P first.", zh: "请先挂入 P 档" };
    if (d.speed !== 0) return { en: "The car must be stopped.", zh: "车速必须为0\n才能开门" };
    return null;
  }
  async function onBody(a7) {
    let why = moveBlocker();
    if (why) { toast(L(why), "warn", 2500); return; }
    const c = a7 < 4 ? tapCommand("openDoor", a7) : tapCommand("control", a7);
    if (!(await gate(c.type, { confirm: c.confirm }))) return;
    why = moveBlocker();   // the gear can change while the dialog is open
    if (why) { toast(L(why), "warn", 2500); return; }
    if (await send(c.type, c.payload)) {
      const a = GAUGE_CAR_ACTIONS.find(x => x.a7 === a7);
      toast(a7 < 4 ? L(a.label, a.zh) : L("Sent", "指令已发送"), "ok", 1500);
    }
  }
  async function onHeat() {
    // The direction comes from the last full frame, so it must be fresh.
    if (!fullSeen || !d || Date.now() - lastRx >= STALE_MS) { toast(L("No battery heat state from the car yet.", "尚未收到电池加热状态"), "warn", 2500); return; }
    const on = !fmt.battHeat;   // vendor: state 0 sends A7 05 (on), else A7 04 (off)
    const c = switchCommand("batteryHeat", on);
    const confirm = on ? { en: "Turn on battery preheat?", zh: "确定打开电池预热?" } : { en: "Turn off battery preheat?", zh: "确定关闭电池预热?" };
    if (await send(c.type, c.payload, { confirm })) toast(L("Sent", "指令已发送"), "ok", 1000);
  }

  return {
    el,
    title: { en: "Gauges", zh: "仪表盘" },
    refresh() { applyPrefs(); built = ""; },
    enter() {
      if (active) return;
      active = true;
      document.body.classList.add("gauge-full");
      if (!batteryAsked && navigator.getBattery) { batteryAsked = true; navigator.getBattery().then(b => { battery = b; }).catch(() => {}); }
      offs.push(onBus("frame", onFrame), onBus("status", keepAlive), onBus("conn", soon));
      window.addEventListener("resize", onResize);
      document.addEventListener("visibilitychange", onVis);
      geometry();
      built = "";
      render();
      clearInterval(timer);
      timer = setInterval(tick, KEEPALIVE_MS);
      keepAlive();
      wake();
    },
    leave() {
      if (!active) return;
      active = false;
      clearInterval(timer); timer = 0;
      cancelAnimationFrame(raf); raf = 0;
      offs.splice(0).forEach(f => f());
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      document.body.classList.remove("gauge-full");
      stopStream();
      wake();
      test = { state: 0 };
    },
  };
});
