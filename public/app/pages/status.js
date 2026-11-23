// Car tab (vendor pages/index): vehicle, AP assist, lights, comfort, doors, seats, scroll wheel, driving systems.
// The command logic is the same as before the redesign; only the grouping and the look changed.
import { h, L, toggle, icon, holdButton, pressable, toast, alertBox, showHelp, btn, helpButton, groupHelpButton, clear } from "../ui.js";
import { S, definePage, onBus, send, ask, gate, rereadSoon, go, log, connect, askPassword, switchTab, isH2 } from "../app.js";
import { boardName, FLAG, boardListenOnly } from "../../lib/scrl.js";
import { toolsShown } from "./tools.js";
import { H2_TYPE, H2_TSL6_TYPE, h2Has, h2HasEngine, h2ShowsRow } from "../../lib/h2-menus.js";
import { h2PromptDiag } from "../../lib/scrl-tsl6.js";
import { boardBanner } from "./board.js";
import { WebLink } from "../ble.js";
import {
  ROW_BY_ID, A7_HARD_GATED, A7_RELEASE, A2_RELEASE, decodeLiveState, switchCommand, memoryCommand, tapCommand,
  canStateText, formatC1Reply, decodeA7Reply,
} from "../../lib/tsl6-status.js";
import { decodeSettings, isPromptTime, promptDelayMs } from "../../lib/tsl6-settings.js";
import { B0, startPayload, stopPayload, KEEPALIVE_MS, decodeGauge, promptDiag, PROMPT_PHASE } from "../../lib/tsl6-gauge.js";

// Scroll interval of the prompt build (see the Firmware page), or null for a stock value or no settings.
function promptTime(p) {
  try { const t = decodeSettings(p).time; return isPromptTime(t) ? t : null; } catch { return null; }
}

// The H2 board has only the rows in H2_ROWS. A row with no type list is not for the board.
// The scroll interval value of a prompt mode, or null. The H2 board keeps the mode in its own settings: a custom
// delay has no menu value, and it is still a prompt mode.
function promptOf(p) {
  if (isH2()) { const s = S.link.board && S.link.board.settings; return s && s.mode === 0 ? 0 : null; }
  return promptTime(p);
}

const shown = r => r && (S.hwType === H2_TYPE ? h2ShowsRow(r) : (!r.types || r.types.includes(S.hwType)));
// The device type for the TSL6 rows: a board with the TSL6 engine link has the rows of type H2_TSL6_TYPE.
const tslType = () => (S.hwType === H2_TYPE && h2HasEngine() ? H2_TSL6_TYPE : S.hwType);
// Display names that say what the switch does (the codec keeps the vendor names for its tests).
const NAME = { apAutoState: { en: "AP resume", zh: "AP恢复" }, vehicleAPState: { en: "Autopilot", zh: "车辆AP" } };

// Switch rows by section. Icons are Lucide names.
const ASSIST = [["apAutoState", "rotate-cw"], ["vehicleAPState", "steering-wheel"]];
const LIGHTS = [["pulseHighBeam", "lamp-high-strobe"], ["pulseFrontFog", "fog-front-strobe"], ["pilotFrontFog", "fog-front"], ["pulseRearFog", "fog-rear-strobe"], ["pilotRearFog", "fog-rear"], ["pulseHorn", "car-horn"]];
const COMFORT = [["batteryHeat", "thermometer-sun"], ["chargeDoor", "plug-zap"], ["driverMassage", "waves"], ["passengerMassage", "waves"]];
const DRIVING = [["sportMode", "zap"], ["offRearMotor", "power-off"], ["offFrontMotor", "power-off"], ["offESP", "shield-off"]];
const DOOR_ICON = { 0: "car-door-fl", 1: "car-door-fr", 2: "car-door-rl", 3: "car-door-rr", 8: "car-frunk", 9: "car-trunk", 10: "car-glovebox", 11: "car-mirrors", 22: "lock", 23: "lock-open" };
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
  const held = new Set();
  let timer = 0, countdown = 0;
  const refs = {};
  // Prompt build: while this tab shows and a prompt mode is set, stream B0 and show the patch state
  // (the B0 altitude bits carry it, see lib/tsl6-gauge.js promptDiag).
  let entered = false, streamOn = false, keepTimer = 0, diag = null, promptNow = null;
  const linkReady = () => !!(S.link && S.link.connected && S.link.authed && !S.blank);
  const keepAlive = () => { if (linkReady() && !document.hidden) send(B0, startPayload(), { read: true, quiet: true }); };
  function syncStream() {
    // The H2 board has no gauge stream. Its Live record carries the prompt state (see the "board" event below).
    const want = promptNow != null && entered && !document.hidden && linkReady() && !isH2();
    if (want === streamOn) return;
    streamOn = want;
    clearInterval(keepTimer); keepTimer = 0;
    if (want) { keepAlive(); keepTimer = setInterval(keepAlive, KEEPALIVE_MS); }
    else { diag = null; if (linkReady()) send(B0, stopPayload(), { read: true, quiet: true }); }
  }
  function drawPrompt() {
    if (!refs.apSub) return;
    clear(refs.apSub);
    const s = (promptDelayMs(promptNow) / 1000).toString();
    refs.apSub.append(L(`On hands-on prompt, about ${s} s after it`, `手扶提示时，约${s}秒后拨动`));
    if (!diag) return;
    const line = diag.noData
      ? [L("No hands-on data from the car yet", "尚未收到车辆手扶数据")]
      : [L(...PROMPT_PHASE[diag.phase]), " · ", L(`sent ${diag.sent}`, `已拨动 ${diag.sent} 次`),
        h("span", { class: "prompt-raw" }, L(` · hands-on ${diag.handsOn}, AP ${diag.apState}`, ` · 手扶 ${diag.handsOn}，AP ${diag.apState}`))];
    refs.apSub.append(h("div", { class: "prompt-diag", "data-id": "prompt-diag" }, line));
  }

  // H2 board: the hero line and the warnings come from the board's Live record, once per second.
  // Only text changes here. The page is not built again, so a tap is never lost.
  function drawBoard() {
    const link = S.link;
    if (!isH2() || !link.board) return;
    const B = link.board;
    diag = h2PromptDiag(B.live, B.flags);
    if (refs.apSub && B.settings) {
      const s = B.settings, secs = ms => (ms / 1000).toString();
      // "Random interval" Off (rand 0): the board uses the exact Timer interval.
      const every = h2Has("rand") && s.rand === 0 ? secs(s.interval_ms) : `${secs(s.interval_ms * 0.8)}-${secs(s.interval_ms * 1.2)}`;
      const raw = h("span", { class: "prompt-raw" }, L(` · hands-on ${diag.handsOn}, AP ${diag.apState}`, ` · 手扶 ${diag.handsOn}，AP ${diag.apState}`));
      const sent = L(`sent ${diag.sent}`, `已拨动 ${diag.sent} 次`);
      clear(refs.apSub).append(s.mode === 0
        ? L(`On hands-on prompt, about ${secs(s.delay_ms)} s after it`, `手扶提示时，约${secs(s.delay_ms)}秒后拨动`)
        : L(`Every ${every} s while AP is active`, `AP激活时，每${every}秒`));
      refs.apSub.append(h("div", { class: "prompt-diag", "data-id": "prompt-diag" }, diag.noData
        ? [L("No hands-on data from the car yet", "尚未收到车辆手扶数据")]
        : s.mode === 0 ? [L(...PROMPT_PHASE[diag.phase]), " · ", sent, raw] : [sent, raw]));
    }
    if (refs.banner) boardBanner(refs.banner);
    if (refs.op && B.status) {
      // Green only while the board really sends; amber for Listen-Only and for Active that a lock holds back.
      const active = B.status.opMode === 1 && !!(B.flags & FLAG.ACTIVE);
      const text = boardListenOnly(B.info) ? L("Listen-only build", "只听版本")
        : B.status.opMode !== 1 ? L("Listen-Only", "只听模式") : active ? L("Active", "主动模式") : L("Held in Listen-Only", "保持只听");
      refs.op.classList.toggle("on", active);
      refs.op.querySelector("span").textContent = text;
      refs.op.setAttribute("aria-label", L(`Op mode: ${text}. Open the board page`, `运行模式：${text}。打开模块页面`));
    }
  }

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
  const onVis = () => { if (document.hidden) releaseAll(); syncStream(); };

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
    if (r && [6, 7, 8, 19].includes(tslType())) {
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
    const label = NAME[id] || { en: r.en, zh: r.zh };
    const sw = toggle({ checked: null, label: L(label), onchange: v => onSwitch(r, v) });
    sw.dataset.id = `sw-${id}`;
    const tone = TONE[id] || "";
    const chip = h("span", { class: "chip " + tone }, icon(ico, 22));
    switches[id] = { sw, chip, ico, tone, name: L(label) };
    return h("div", { class: "li", "data-row": id },
      chip, nameButton(L(label), r.help),
      sw);
  }
  // The row name is a button that opens the help text of the row.
  const nameButton = (name, help) => h("button", { class: "li-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + name,
    onclick: () => showHelp(help, name) }, h("div", { class: "li-title" }, h("span", null, name)));
  // Help for a switch group: every shown row with its help text.
  const groupHelp = (en, zh, rows, extra = []) => groupHelpButton({ en, zh },
    [...extra, ...rows.map(([id]) => ROW_BY_ID[id]).filter(shown).map(r => [L(NAME[r.id] || { en: r.en, zh: r.zh }), r.help])]);
  const listCard = (items, cls = "") => h("div", { class: "card " + cls }, items.filter(Boolean));

  function emptyState() {
    const supported = S.mock || WebLink.available();
    let all = false;
    const allBox = h("input", { type: "checkbox", id: "allDev" });
    allBox.addEventListener("change", () => { all = allBox.checked; });
    el.append(
      h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip blue" }, icon("bluetooth", 24)),
        h("h2", { class: "sec-title" }, h("span", null, L("Connect to your device", "连接您的设备")), helpButton("help_ble", { en: "Bluetooth", zh: "蓝牙" })),
        h("p", null, supported
          ? L("Pick TSL6, or SCRL-xxxx for a BLE board, in the Bluetooth list that the browser shows.", "在浏览器显示的蓝牙列表中选择 TSL6，BLE模块请选择 SCRL-xxxx。")
          : L("This browser has no Web Bluetooth. Use Chrome or Edge on Android or a computer, or Bluefy on iPhone.",
            "此浏览器不支持网页蓝牙。请在安卓或电脑上使用 Chrome / Edge，iPhone 请使用 Bluefy。")),
        supported ? btn({ en: "Connect", zh: "连接" }, () => connect({ all }), { kind: "primary" }) : null,
        supported ? h("label", { class: "check" }, allBox, L("Show all devices", "显示所有设备")) : null)),
      // One note per device, so the user reads only the steps of their own device.
      sec("Before you connect", "连接前"),
      h("div", { class: "card" },
        h("div", { class: "li note-dev" }, h("span", { class: "chip" }, icon("car", 22)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("Every device", "所有设备"))),
            h("div", { class: "li-sub" }, L("Keep the car awake (climate or Camp mode on). The device takes one phone at a time.", "保持车辆唤醒（打开空调或露营模式）。设备一次只连接一部手机。")))),
        h("div", { class: "li note-dev" }, h("span", { class: "chip" }, icon("cpu", 22)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("TSL6 module", "TSL6 模块"))),
            h("div", { class: "li-sub" }, L("Pick TSL6. Close the vendor Mini App, or turn off Bluetooth on that phone. The default password is 1234.", "选择 TSL6。关闭原厂小程序，或关闭那部手机的蓝牙。默认密码为 1234。")))),
        h("div", { class: "li note-dev" }, h("span", { class: "chip" }, icon("radio", 22)),
          h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L("BLE board", "BLE模块"))),
            h("div", { class: "li-sub" }, L("NanoH2, T-2CAN, ATOM and the other hypery boards with the BLE firmware: pick SCRL-xxxx. At the first connection, type the passkey from the label on the board.", "NanoH2、T-2CAN、ATOM 及其他刷了BLE固件的 hypery 板：选择 SCRL-xxxx。首次连接时，输入模块标签上的配对码。"))))));
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

  // Connected, but the module has not sent a status yet (a blank status means "password needed").
  function waitingState() {
    el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
      h("span", { class: "chip blue" }, icon("refresh-cw", 24)),
      h("h2", null, L("Waiting for the module", "等待模块应答")),
      h("p", null, L("The module has not sent car data yet.", "模块尚未发送车辆数据。")),
      h("div", { class: "es-btns" },
        h("button", { class: "btn primary", type: "button", onclick: () => S.link.readStatus().catch(() => {}) }, L("Read again", "重新读取")),
        S.link.authed ? null : h("button", { class: "btn", type: "button", onclick: () => askPassword("manual") }, L("Enter password", "输入密码"))))));
  }

  function build() {
    clear(el);
    const link = S.link;
    const live = !!(link && link.connected && S.status && !S.blank);
    el.className = "page" + (live ? " cols" : " narrow");
    if (!link || !link.connected) return emptyState();
    if (!S.status) return waitingState();
    if (S.blank) return lockedState();

    // Cluster: the vehicle, the three CAN buses and a telltale for each function that is on.
    const vt = ROW_BY_ID.vehicleType;
    refs.vehicleName = h("div", { class: "vehicle-name" }, "—");
    refs.pills = h("div", { class: "cl-bus" });
    refs.tt = h("div", { class: "cl-tt", role: "group", "aria-label": L("Functions that are on", "已开启的功能") });
    const vcard = h("div", { class: "card cluster span", "data-row": "vehicleType" },
      h("div", { class: "cl-head vehicle" },
        h("div", { class: "cl-name" }, shown(vt) ? [refs.vehicleName, helpButton(vt.help, { en: vt.en, zh: vt.zh })]
          : h("span", { class: "vehicle-name" }, isH2() ? L(boardName(S.link.board && S.link.board.info), boardName(S.link.board && S.link.board.info, true)) : "TSL6"))),
      refs.pills, refs.tt,
      // The car readouts. A board without the engine link has none: its button opens the Board page (state,
      // counters, board actions). The op-mode telltale also opens the Board page.
      h("div", { class: "cl-btns" },
        isH2() && !h2HasEngine() ? h("button", { class: "cl-gauge", type: "button", "data-id": "open-board", onclick: () => go("board") }, icon("cpu", 18), h("span", null, L("Board", "模块")))
          : h("button", { class: "cl-gauge", type: "button", "data-id": "open-gauges", onclick: () => go("gauge") }, icon("gauge", 18), h("span", null, L("Gauges", "仪表盘"))),
        toolsShown(["battery"]).length ? h("button", { class: "cl-gauge", type: "button", "data-id": "open-battery", onclick: () => go("battery") }, icon("battery-medium", 18), h("span", null, L("Battery", "电池"))) : null));
    // H2 board: can the board send on the bus now? The telltale opens the Board page, where the op mode changes.
    refs.op = isH2() ? h("button", { class: "cl-op", type: "button", "data-id": "cl-opmode", onclick: () => go("board") }, h("i"), h("span")) : null;
    if (!isH2() || h2HasEngine()) pressable(vcard, { onlong: vehicleLongPress }); // long press: CAN1-3 state, as in the vendor app
    // Board warnings come first on the landing tab: an unconfirmed image has a 10-minute limit.
    refs.banner = isH2() ? h("div", { class: "span", "data-id": "board-banner" }) : null;
    if (refs.banner) { el.append(refs.banner); boardBanner(refs.banner); }
    el.append(vcard);

    // AP assist
    const ap = ROW_BY_ID.apAssist;
    const apSw = toggle({ checked: null, label: L(ap.en, ap.zh), onchange: v => onSwitch(ap, v) });
    apSw.dataset.id = "sw-apAssist";
    refs.apSub = h("div", { class: "hero-sub" }, "—");
    refs.apChip = h("span", { class: "chip" }, icon("hand", 28));
    switches.apAssist = { sw: apSw, chip: refs.apChip, ico: "hand", tone: "", name: L(ap.en, ap.zh) };
    promptNow = promptOf(S.status);
    const apName = L("AP assist (no-nag)", "AP辅助（免打扰）");
    if (promptNow != null) switches.apAssist.name = L("AP assist (on prompt)", "AP辅助（手扶提示时）");
    el.append(grp(sec("Driver assist", "辅助驾驶", groupHelp("Driver assist", "辅助驾驶", ASSIST, [[apName, ap.help], [L(ROW_BY_ID.countdown.en, ROW_BY_ID.countdown.zh), ROW_BY_ID.countdown.help]])),
      h("div", { class: "card lead" },
        h("div", { class: "hero", "data-row": "apAssist" }, refs.apChip,
          h("button", { class: "li-text hero-text", type: "button", "aria-haspopup": "dialog", "aria-label": L("Help", "帮助") + ": " + apName, onclick: () => showHelp(ap.help, L(ap.en, ap.zh)) },
            h("div", { class: "hero-title" }, h("span", null, apName),
              promptNow != null ? h("span", { class: "pill prompt-pill", "data-id": "prompt-pill" }, L("On prompt", "手扶提示时")) : null),
            refs.apSub),
          apSw),
        ...ASSIST.map(switchItem).filter(Boolean))));

    // A group shows only when this device type has at least one of its rows.
    const switchGroup = (en, zh, rows) => { const items = rows.map(switchItem).filter(Boolean); return items.length ? grp(sec(en, zh, groupHelp(en, zh, rows)), listCard(items)) : null; };
    const lightsGrp = switchGroup("Lights and horn", "灯光与喇叭", LIGHTS);
    const comfortGrp = switchGroup("Comfort and charging", "舒适与充电", COMFORT);

    // Doors and access
    const doorRow = ROW_BY_ID.openDoor, ctl = ROW_BY_ID.control;
    const tapBtn = (r, b) => {
      const [en, zh] = DOOR_LABEL[b.btn] || [b.en, b.info || b.en];
      return h("button", { class: "act", type: "button", "data-id": `tap-${b.btn}`, onclick: () => onTap(r, b) }, icon(DOOR_ICON[b.btn] || "circle-dot", 26), h("span", null, L(en, zh)));
    };
    const ctlButtons = ctl && shown(ctl) ? ctl.buttons.filter(b => (!b.types || b.types.includes(tslType())) && !b.vendorGate) : [];
    // One plan-view grid: doors at the four corners, frunk and trunk on the centre line (CSS places each button).
    const taps = [...(shown(doorRow) ? doorRow.buttons.map(b => tapBtn(doorRow, b)) : []), ...ctlButtons.map(b => tapBtn(ctl, b))];
    const doorHelp = groupHelpButton({ en: "Doors and access", zh: "车门与开启" }, [doorRow, ctl].filter(shown).map(r => [L(r.en, r.zh), r.help]));
    if (taps.length) el.append(grp(sec("Doors and access", "车门与开启", doorHelp),
      h("div", { class: "card" }, h("div", { class: "acts plan" }, taps))));
    // Doors come right after driver assist (the car actions people use most), then the switch groups.
    el.append(...[lightsGrp, comfortGrp].filter(Boolean));

    // Seats
    const seatBlock = (moveId, memId, en, zh) => {
      const mv = ROW_BY_ID[moveId], mem = ROW_BY_ID[memId];
      if (!shown(mv) && !shown(mem)) return null;
      return h("div", { class: "seat" },
        h("div", { class: "subhead" }, h("span", null, L(en, zh))),
        h("div", { class: "acts seatgrid" },
          shown(mv) ? mv.buttons.map(b => hold(0xa7, b.btn, A7_RELEASE, icon(ARROW[b.icon], 26), `${L(en, zh)}: ${L(b.en)}`)) : null,
          shown(mem) ? (() => {
            const memBtn = b => {
              const lab = MEM_LABEL[b.icon];
              const e = h("button", { class: "act", type: "button", "data-id": `mem-${b.btn}`, "aria-label": `${L(en, zh)}: ${L(b.en)}` },
                b.text ? h("b", null, b.text) : icon(MEM_ICON[b.icon], 20), b.text ? null : h("span", null, L(...lab)));
              return pressable(e, { ontap: () => onMemory(mem, b, false), onlong: () => onMemory(mem, b, true) });
            };
            const nums = mem.buttons.filter(b => b.text), modes = mem.buttons.filter(b => !b.text);
            return [...modes.map(memBtn), h("div", { class: "mem", role: "group", "aria-label": L("Memory", "记忆") },
              h("div", { class: "mem-seg" }, nums.map(memBtn)))];
          })() : null));
    };
    const seats = [seatBlock("driverSeat", "driverMemory", "Driver", "主驾"), seatBlock("passengerSeat", "passengerMemory", "Passenger", "副驾")].filter(Boolean);
    const seatHelp = groupHelpButton({ en: "Seats", zh: "座椅" }, [
      ...["driverSeat", "passengerSeat"].map(id => ROW_BY_ID[id]).filter(shown).map(r => [L(r.en, r.zh), r.help]),
      [L("Seat memory", "座椅记忆"), "help_sideMemory"]]);
    if (seats.length) el.append(grp(sec("Seats", "座椅", seatHelp),
      h("div", { class: "card" }, seats, h("p", { class: "card-foot" }, L("Hold an arrow to move. Tap a memory to recall it, hold it to save.",
        "按住箭头移动。点击记忆位置恢复，长按保存。")))));

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
            h("span", null, L("Motor off and ESP off are locked. To unlock, turn on ", "关闭电机和关闭ESP已锁定。如需解锁，请打开"),
              h("button", { class: "linkish", type: "button", onclick: () => switchTab("me") }, L("Device > Allow driving-system controls", "设备 > 允许驾驶系统控制")), ".")),
          drive)));
    }
    el.append(h("p", { class: "foot span" }, L("Switches show the module state after the next status read.", "开关在下次读取状态后显示模块的实际状态。")));
  }

  function update(p) {
    if (!p || S.blank) return;
    const live = decodeLiveState(p, tslType());
    for (const [id, s] of Object.entries(switches)) {
      const on = live.blank ? null : live.toggles[id];
      s.sw.set(on);
      s.chip.classList.toggle("on", on === true);
    }
    if (refs.vehicleName) {
      refs.vehicleName.textContent = L(live.vehicle.en, live.vehicle.zh);
      refs.vehicleName.classList.toggle("warn", !live.vehicle.detected); // vendor: orange when not detected
      clear(refs.pills);
      // A bus with data is a solid lit lane; a bus without data is a dashed dark lane.
      // As in the vendor app: CAN state only for types 6, 7, 8, 19; the harness warning only where the vehicle row shows.
      if ([6, 7, 8, 19].includes(tslType())) live.can.forEach((on, i) => {
        const name = on ? L(`CAN${i + 1} connected`, `CAN${i + 1} 已连接`) : L(`CAN${i + 1} not connected`, `CAN${i + 1} 未连接`);
        refs.pills.append(h("span", { class: "lane" + (on ? " on" : ""), role: "img", "aria-label": name, title: name }, `CAN${i + 1}`, h("i")));
      });
      if (live.harnessUnplugged && shown(ROW_BY_ID.vehicleType)) refs.pills.append(h("span", { class: "pill bad" }, L("Harness not plugged in", "线束未插好")));
      clear(refs.tt);
      const lit = live.blank ? [] : Object.entries(switches).filter(([id]) => live.toggles[id] === true);
      if (!lit.length) refs.tt.append(h("span", { class: "cl-none" }, L("No function is on", "没有开启的功能")));
      for (const [, s] of lit) refs.tt.append(h("span", { class: "tt " + s.tone }, icon(s.ico, 20), h("span", null, s.name)));
    }
    clearInterval(timer);
    const pt = promptOf(p);
    if (pt !== promptNow) { promptNow = pt; render(); return; } // the hero title and telltale name change
    syncStream();
    if (isH2()) {
      // One CAN lane for the one bus of the board.
      if (refs.pills) {
        const on = live.can[0];
        const name = on ? L("CAN connected", "CAN 已连接") : L("No CAN frames", "无CAN数据");
        clear(refs.pills).append(h("span", { class: "lane" + (on ? " on" : ""), role: "img", "aria-label": name, title: name }, "CAN", h("i")));
        if (refs.op) refs.pills.append(refs.op);
      }
      drawBoard();
      return;
    }
    if (promptNow != null) drawPrompt(); // the stock 2-3 s timer does not run in a prompt mode
    else if (refs.apSub) {
      countdown = live.timerMs / 1000;
      const draw = () => {
        clear(refs.apSub);
        if (live.assistActive) refs.apSub.append(L("On, next tick in ", "开启，"), h("b", null, L(`${countdown.toFixed(1)} s`, `${countdown.toFixed(1)} 秒后拨动`)));
        else refs.apSub.append("\u00a0");
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
    refresh: render, // show(true) calls it: a link change on a sub-page must not leave stale switches here
    enter() {
      entered = true;
      offs.push(onBus("status", p => { const was = !!el.querySelector('[data-row="vehicleType"]'); if (!was || S.blank) render(); else update(p); }));
      offs.push(onBus("conn", st => { if (!st.connected) releaseAll(); render(); }));
      offs.push(onBus("board", () => drawBoard()));
      offs.push(onBus("frame", fr => {
        if (fr.cmd === 0xa7) { const r = decodeA7Reply(fr.payload); if (r) toast(L(r.en, r.zh), r.ok ? "ok" : "bad"); }
        if (fr.cmd === B0 && streamOn) {
          const x = decodeGauge(fr.payload);
          if (x && x.full && (!diag || diag.raw !== x.altitudeRaw)) { diag = promptDiag(x.altitudeRaw); drawPrompt(); }
        }
      }));
      document.addEventListener("visibilitychange", onVis);
      window.addEventListener("blur", releaseAll);
      if (S.link && S.link.connected && S.link.authed) S.link.readStatus().catch(() => {});
      syncStream();
    },
    leave() {
      entered = false;
      syncStream();
      releaseAll();
      clearInterval(timer);
      offs.splice(0).forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", releaseAll);
    },
  };
});
