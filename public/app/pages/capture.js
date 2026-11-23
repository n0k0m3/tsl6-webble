// Capture page: the BLE board records Vehicle CAN and the phone keeps the frames (board firmware 0.4.0, TWAI boards).
// The board stays in Listen-Only while a capture runs: it sends no frame, and Scroll Ack makes no tick.
// The step list marks the time of each action in the file, so nobody has to write the times down.
import { h, L, toast, confirmBox, clear, icon, download } from "../ui.js";
import { S, definePage, onBus, isH2 } from "../app.js";
import { CAP, idText, parseCaptureIds } from "../../lib/scrl-capture.js";

const board = () => (isH2() && S.link.connected ? S.link : null);

// The 21 actions of the capture plan. Parked first, then a drive. [en, zh]
const PARKED = [
  ["Touch nothing for 60 s", "60秒内不做任何操作"],
  ["Brake pedal: light press, release. Hard press, release", "刹车踏板：轻踩、松开；重踩、松开"],
  ["Left stalk: high beam on, off, then flash 3 times", "左拨杆：远光开、关，然后闪光3次"],
  ["Turn signal: left half, left full, right half, right full", "转向灯：左半档、左全档、右半档、右全档"],
  ["Hazard button on, then off", "双闪开，然后关"],
  ["Horn: one short press, then hold 3 s", "喇叭：短按一次，然后按住3秒"],
  ["Right wheel: press, double press. Left wheel: press", "右滚轮：按下、双击；左滚轮：按下"],
  ["Hold the brake. Right stalk: R, N, D, then the P button. Release the brake", "踩住刹车。右拨杆：R、N、D，然后按P。松开刹车"],
  ["Open and close each door, one at a time: FL, FR, RL, RR", "依次开关每个车门：左前、右前、左后、右后"],
  ["Doors closed: hold the FL handle 3 s, then the RL handle 3 s", "车门关闭：按住左前门把手3秒，然后左后门把手3秒"],
  ["Driver belt: unbuckle, buckle. Passenger belt (with a passenger): unbuckle, buckle", "主驾安全带：解开、扣上；副驾（有乘客时）：解开、扣上"],
  ["Screen: lock, then unlock", "屏幕：锁车，然后解锁"],
  ["Screen: headlights Off, Parking, On, Auto. Fog lights on, off", "屏幕：大灯 关、示宽、开、自动；雾灯 开、关"],
  ["Screen: charge port open, close", "屏幕：充电口 打开、关闭"],
  ["Screen: acceleration Chill, Standard. Stopping mode Roll, Creep, Hold. Regen setting", "屏幕：加速 舒适、标准；停车模式 滑行、蠕行、驻车；能量回收设置"],
  ["Screen: wipers Auto, then Off", "屏幕：雨刮 自动，然后关闭"],
];
const DRIVING = [
  ["Drive 2 min. Brake 2 times, then one firm stop from about 50 km/h", "行驶2分钟。刹车2次，然后从约50 km/h 一次稳定停车"],
  ["At low speed, turn the wheel more than 25 degrees (a parking lot)", "低速时方向盘转动超过25度（停车场）"],
  ["AP on (stalk down 1 time). Signal a lane change. AP off", "开启AP（拨杆下拨1次）。打灯变道。关闭AP"],
  ["AP on with stalk down 2 times (Autosteer), then off", "拨杆下拨2次开启AP（自动转向），然后关闭"],
  ["Reverse into a parking spot", "倒车入库"],
];
const STEPS = [...PARKED, ...DRIVING];
export const stepText = n => (STEPS[n - 1] ? STEPS[n - 1][0] : "");

// The last recorder lives here too: a reconnect makes a new link, and the frames must stay for the save.
let lastRec = null;
let mode = CAP.MODE_PLAN;
let listText = ""; // the typed ID list of the "ID list" mode, kept while the app runs

const n0 = v => Number(v || 0).toLocaleString("en-US");
const dur = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const stamp = d => d.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

async function save() {
  const rec = lastRec;
  if (!rec || !rec.frames) { toast(L("No frames to save yet.", "尚无可保存的数据。"), "bad", 2500); return; }
  const part = S.link && S.link.captureLive ? "-part" : "";
  await download(`scrl-capture-${stamp(rec.startedAt)}${part}.log`, rec.toText(stepText), "text/plain");
}

definePage("capture", () => {
  const el = h("div", { class: "page narrow", "data-page": "capture" });
  const refs = {};
  const grp = (...kids) => h("section", { class: "grp" }, kids);
  const kv = (key, en, zh) => {
    refs[key] = h("span", { class: "kv mono" }, "—");
    return h("div", { class: "li", "data-row": key }, h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))), refs[key]);
  };

  async function start() {
    const link = board();
    if (!link || link.captureLive || link.captureStarting) return;
    if (lastRec && lastRec.frames && !(await confirmBox({
      en: "Start a new capture? The frames of the last capture go away. Save them first if you need them.",
      zh: "开始新的采集吗？上次采集的数据将被清除。如需保留请先保存。",
    }, L("Capture", "采集"), L("Start", "开始"), { focusCancel: true }))) return;
    let ids = [];
    if (mode === CAP.MODE_LIST) {
      try { ids = parseCaptureIds(listText); }
      catch (e) { toast(L("ID list: ", "ID列表：") + e.message, "bad", 3500); return; }
    }
    if (refs.startBtn) refs.startBtn.disabled = true; // a second tap must not start a second capture
    try {
      await link.captureStart(mode, ids);
      lastRec = link.capture;
      toast(L("Capture runs. The board is in Listen-Only.", "采集进行中，模块处于只听模式。"), "ok");
    } catch (e) { toast(L("The board did not start: ", "模块未开始：") + e.message, "bad", 3500); }
    build();
  }
  async function stop() {
    const link = board();
    if (!link) return;
    try { await link.captureStop(); } catch (e) { toast(L("The board did not take it: ", "模块未接受：") + e.message, "bad", 3500); }
  }
  async function mark(step) {
    const link = board();
    if (!link || !link.captureLive) { toast(L("Start the capture first.", "请先开始采集。"), "bad", 2500); return; }
    try {
      await link.captureMark(step);
      toast(L(`Step ${step} marked`, `已标记第${step}步`), "ok", 1200);
    } catch (e) { toast(L("The mark did not reach the board: ", "标记未送达模块：") + e.message, "bad", 3000); }
  }

  function build() {
    clear(el);
    for (const k of Object.keys(refs)) delete refs[k];
    const link = board();
    if (!link && !lastRec) {
      el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip blue" }, icon("activity", 24)),
        h("h2", null, L("No BLE board", "未连接BLE模块")),
        h("p", null, L("Connect to a board with firmware 0.4.0 or later first.", "请先连接固件0.4.0或更新版本的模块。")))));
      return;
    }
    if (link && !link.canCapture && !lastRec) {
      el.append(h("div", { class: "card" }, h("div", { class: "empty-state" },
        h("span", { class: "chip" }, icon("activity", 24)),
        h("h2", null, L("No capture on this board", "此模块不支持采集")),
        h("p", null, L("A capture needs board firmware 0.4.0 or later, and a TWAI board (the NanoH2, the ATOM boards, the T-2CAN on CAN B). An MCP2515 board filters the IDs. Update the board on the Board firmware page.",
          "采集需要模块固件0.4.0或更新版本，并且是TWAI模块（NanoH2、ATOM、T-2CAN的CAN B）。MCP2515模块会过滤ID。请在「模块固件」页更新。")))));
      return;
    }

    el.append(grp(h("div", { class: "sec-label" }, L("Before you start", "开始之前")), h("div", { class: "card" }, h("div", { class: "form" },
      h("ul", { style: { margin: "0", paddingLeft: "18px", display: "grid", gap: "6px" } },
        h("li", null, L("Unplug the TSL6 module from its harness. Its frames have the same IDs as the car frames.", "从线束上拔下TSL6模块。它发出的帧与原车帧ID相同。")),
        h("li", null, L("While the capture runs, the board sends nothing and Scroll Ack makes no tick. Keep your hands on the wheel.", "采集期间模块不发送任何数据，滚轮辅助不工作。请手扶方向盘。")),
        h("li", null, L("Keep this page open and the screen on. A lost link stops the capture. The frames that came stay, and you can save them.", "保持本页打开且屏幕常亮。连接断开会停止采集，已收到的数据会保留，可以保存。")),
        h("li", null, L("Do the parked steps first. Do a driving step only when it is safe.", "先完成停车步骤。只在安全时进行行驶步骤。")))))));

    const live = !!(link && link.captureLive);
    refs.modeSel = h("select", { class: "text", "data-id": "cap-mode", "aria-label": L("Frames to stream", "传输的帧"), disabled: live,
      onchange: e => { mode = Number(e.target.value); refs.listRow.style.display = mode === CAP.MODE_LIST ? "grid" : "none"; } },
      h("option", { value: String(CAP.MODE_PLAN), selected: mode === CAP.MODE_PLAN }, L("Plan IDs (recommended)", "计划ID（推荐）")),
      h("option", { value: String(CAP.MODE_ALL), selected: mode === CAP.MODE_ALL }, L("All IDs (can lose frames on Bluetooth)", "全部ID（蓝牙可能丢帧）")),
      h("option", { value: String(CAP.MODE_LIST), selected: mode === CAP.MODE_LIST }, L("ID list (type the IDs)", "ID列表（输入ID）")));
    refs.listInput = h("input", { class: "text mono", type: "text", "data-id": "cap-list", value: listText, placeholder: "399, 39B",
      "aria-label": L("IDs to stream", "要传输的ID"), autocomplete: "off", autocapitalize: "characters", autocorrect: "off", spellcheck: "false",
      disabled: live, oninput: e => { listText = e.target.value; } });
    refs.listRow = h("div", { style: { display: mode === CAP.MODE_LIST ? "grid" : "none", gap: "6px" }, "data-id": "cap-list-row" }, refs.listInput,
      h("div", { class: "li-sub" }, L(`Hex IDs, split by commas or spaces. 1 to ${CAP.LIST_MAX} IDs. The file still ends with the table of every ID on the bus.`,
        `十六进制ID，用逗号或空格分隔，1到${CAP.LIST_MAX}个。文件末尾仍附总线上所有ID的表。`)));
    refs.startBtn = h("button", { class: "btn primary", type: "button", "data-id": "cap-start", disabled: !link || !link.canCapture || live, onclick: start }, L("Start", "开始"));
    refs.stopBtn = h("button", { class: "btn", type: "button", "data-id": "cap-stop", disabled: !live, onclick: stop }, L("Stop", "停止"));
    refs.saveBtn = h("button", { class: "btn", type: "button", "data-id": "cap-save", onclick: save }, L("Save file", "保存文件"));
    el.append(grp(h("div", { class: "sec-label" }, L("Capture", "采集")), h("div", { class: "card" },
      h("div", { class: "form" }, refs.modeSel, refs.listRow,
        h("div", { class: "btns" }, refs.startBtn, refs.stopBtn, refs.saveBtn)),
      kv("state", "State", "状态"), kv("frames", "Frames received", "收到的帧"), kv("ids", "IDs on the bus", "总线上的ID"),
      kv("lost", "Lost (ring / queue / packets)", "丢失（缓冲/队列/数据包）")),
    h("p", { class: "sec-foot" }, L("The file is a candump log in board time. It has a note line at each step mark and at each gap, and the ID table at the end.",
      "文件为 candump 日志格式（模块时间），每个步骤标记和每处缺口都有注释行，末尾附ID表。"))));

    const stepRow = (n, [en, zh]) => {
      refs[`mark${n}`] = h("span", { class: "kv mono" }, "");
      return h("button", { class: "li", type: "button", "data-id": `cap-step-${n}`, onclick: () => mark(n) },
        h("span", { class: "chip" }, String(n)),
        h("div", { class: "li-text" }, h("div", { class: "li-title" }, h("span", null, L(en, zh)))), refs[`mark${n}`]);
    };
    el.append(grp(h("div", { class: "sec-label" }, L("Parked: tap a step when you start it", "停车：开始某步时点按该步")),
      h("div", { class: "card" }, PARKED.map((s, i) => stepRow(i + 1, s)))));
    el.append(grp(h("div", { class: "sec-label" }, L("Driving: a passenger taps the step", "行驶：由乘客点按")),
      h("div", { class: "card" }, DRIVING.map((s, i) => stepRow(PARKED.length + i + 1, s)))));

    refs.idList = h("div", { class: "card", "data-id": "cap-ids" });
    el.append(grp(h("div", { class: "sec-label" }, L("ID table (busiest first)", "ID表（按帧数）")), refs.idList));
    draw();
  }

  function draw() {
    if (!refs.frames) return;
    const link = board();
    const rec = link && link.capture ? link.capture : lastRec;
    if (rec) lastRec = rec;
    const live = !!(link && link.captureLive);
    if (refs.startBtn) refs.startBtn.disabled = !link || !link.canCapture || live;
    if (refs.stopBtn) refs.stopBtn.disabled = !live;
    if (refs.modeSel) refs.modeSel.disabled = live;
    if (refs.listInput) refs.listInput.disabled = live;
    const set = (k, v) => { if (refs[k]) refs[k].textContent = String(v); };
    if (!rec) { set("state", L("Not started", "未开始")); return; }
    const secs = rec.seconds;
    set("state", live ? L(`Running, ${dur(secs)}`, `进行中，${dur(secs)}`) : L(`Stopped after ${dur(secs)}`, `已停止，时长 ${dur(secs)}`));
    set("frames", secs > 0 ? `${n0(rec.frames)} (${n0(Math.round(rec.frames / secs))}/s)` : n0(rec.frames));
    set("ids", rec.ids.size);
    set("lost", `${n0(rec.ringLost)} / ${n0(rec.queueLost)} / ${n0(rec.packetsMissing)}`);
    const marked = new Map(rec.marks.map(m => [m.step, m.t]));
    for (let n = 1; n <= STEPS.length; n++) set(`mark${n}`, marked.has(n) ? `✓ ${(marked.get(n) / 1000).toFixed(1)}` : "");
    clear(refs.idList);
    const top = rec.idTable().slice(0, 40);
    if (!top.length) refs.idList.append(h("div", { class: "li" }, h("div", { class: "li-text" }, L("No frame yet", "尚无数据"))));
    for (const e of top) {
      refs.idList.append(h("div", { class: "li", "data-row": `id-${idText(e.id)}` },
        h("div", { class: "li-text" }, h("div", { class: "li-title mono" }, `0x${idText(e.id)}`),
          h("div", { class: "li-sub mono" }, `${e.data || "—"}`)),
        h("span", { class: "kv mono" }, `${n0(e.frames)} · ${e.periodMs ? `${e.periodMs.toFixed(0)} ms` : "—"}`)));
    }
  }

  const offs = [];
  build();
  return {
    el, title: { en: "Capture", zh: "采集" },
    refresh: build,
    enter() { offs.push(onBus("capture", draw)); offs.push(onBus("conn", build)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
