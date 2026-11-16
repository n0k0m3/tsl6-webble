// Board firmware page: update of the BLE board over Bluetooth (the "scrl-ble-board" firmware, an ESP-IDF image).
// The TSL6 Firmware page is a different flasher for a different chip. It keeps its own page and links (#firmware).
//
// The page checks the file before it sends a byte: ESP image magic, chip ID, project name, board ID, size, and the
// SHA-256 at the end of the image. The chip and the board ID must match the connected board, as the firmware checks
// them: the same chip with other pins is not the same board. An image with another CAN controller (a T-2CAN can0
// image on a can1 board) is allowed, with a warning. After a good update the board restarts into the new image. The image stays in Listen-Only
// until the phone confirms it. With no confirm in 10 minutes the board goes back to the old image.
import { h, L, toast, confirmBox, clear, icon } from "../ui.js";
import { S, definePage, onBus, isH2, switchTab } from "../app.js";
import * as SC from "../../lib/scrl.js";
import { boardBanner } from "./board.js";

// The session lives at module scope: a language change mounts a new page, and an update must go on.
const U = { image: null, raw: null, checkedFor: "", fileName: "", errors: [], warnings: [], running: false, canAbort: false, abortAsked: false, sent: 0, size: 0, text: "", tone: "" };
const board = () => (isH2() && S.link.connected ? S.link.board : null);
let redraw = () => {};

// The board that the image must fit: the connected board, or null.
const target = () => { const B = board(); return B && B.info ? SC.boardOf(B.info) : null; };
const targetKey = () => { const t = target(); return t ? `${t.id}/${t.chip}/${t.can}` : ""; };

// Check the loaded file against the board that is connected now. The hash check ran once at load.
function recheck() {
  U.image = null; U.errors = []; U.warnings = [];
  if (!U.raw) return;
  const { errors, warnings, info } = SC.checkImage(U.raw.bytes, target());
  if (!U.raw.hashOk) errors.push("The SHA-256 at the end of the image is wrong. The file is damaged.");
  U.checkedFor = targetKey();
  U.warnings = warnings;
  if (errors.length) U.errors = errors;
  else U.image = { bytes: U.raw.bytes, sha: U.raw.sha, info };
}

async function loadFile(file) {
  U.raw = null; U.fileName = file.name; U.text = ""; U.tone = "";
  const bytes = new Uint8Array(await file.arrayBuffer());
  U.raw = { bytes, sha: await SC.sha256(bytes), hashOk: bytes.length > 32 && await SC.appendedHashOk(bytes) };
  recheck();
  redraw();
}

async function start() {
  const link = S.link;
  if (U.checkedFor !== targetKey()) { recheck(); redraw(); }
  const img = U.image;
  if (!img || U.running || !board()) return;
  const warn = U.warnings.length ? `\n\n${U.warnings.join("\n")}` : "";
  if (!(await confirmBox({
    en: `Send ${img.info.project} ${img.info.version} for ${img.info.board} to the board? The car must be parked. The board is in Listen-Only during the update and until you confirm the new image.${warn}`,
    zh: `将 ${img.info.project} ${img.info.version}（${img.info.board}）发送到模块吗？车辆必须已停好。更新期间以及确认新固件之前，模块处于只听模式。${warn}`,
  }, L("Board firmware", "模块固件"), L("Send", "发送"), { focusCancel: true }))) return;
  U.running = true; U.canAbort = false; U.abortAsked = false; U.sent = 0; U.size = img.bytes.length; U.tone = "";
  redraw();
  try {
    const r = await link.update(img, {
      onText: t => { U.text = t; redraw(); },
      onBegun: () => { U.canAbort = true; redraw(); },
      onProgress: (sent, size) => { U.sent = sent; U.size = size; U.text = L(`Sent ${sent} of ${size} bytes (${Math.floor(sent * 100 / size)} %).`, `已发送 ${sent} / ${size} 字节（${Math.floor(sent * 100 / size)} %）。`); redraw(); },
      onSent: () => { U.canAbort = false; redraw(); },
      aborted: () => U.abortAsked,
    });
    U.text = r.pending ? L("The new image runs. Check the Car tab, then confirm the image.", "新固件已运行。请查看车辆页，然后确认固件。")
      : L("The board is back, but it does not run a new image. It went back to the old one.", "模块已恢复，但未运行新固件，已回退到旧固件。");
    U.tone = r.pending ? "ok" : "bad";
  } catch (e) {
    const more = e.smaller ? L(` Start again: the app now writes ${e.nextChunk} bytes at a time.`, ` 请重新开始：现在每次写入 ${e.nextChunk} 字节。`) : "";
    U.text = L(`The update stopped: ${e.message.replace(/\.$/, "")}. The board keeps its old image.`, `更新已停止：${e.message.replace(/\.$/, "")}。模块保留旧固件。`) + more;
    U.tone = "bad";
    toast(L("The update stopped. See the Board firmware page.", "更新已停止，请查看模块固件页。"), "bad", 3500);
  }
  U.running = false; U.canAbort = false;
  redraw();
}

definePage("boardfw", () => {
  if (!document.querySelector('link[data-page-css="firmware"]')) {
    document.head.append(h("link", { rel: "stylesheet", href: new URL("./firmware.css", import.meta.url).href, "data-page-css": "firmware" }));
  }
  // data-page="firmware": this page uses the styles of the TSL6 Firmware page (form, buttons, output, progress).
  const el = h("div", { class: "page narrow", "data-page": "firmware", "data-board-fw": "1" });
  const banner = h("div", { "data-id": "board-banner" });
  const fileIn = h("input", { type: "file", accept: ".bin,application/octet-stream", "data-id": "bfw-file",
    onchange: e => { const f = e.target.files[0]; if (f) loadFile(f).catch(err => { U.errors = [err.message]; redraw(); }); } });
  const imgOut = h("div", { class: "out", "data-id": "bfw-image" });
  const prog = h("progress", { max: 1, value: 0 });
  const msgOut = h("div", { class: "out", "data-id": "bfw-msg" });
  const startBtn = h("button", { class: "btn danger-fill", type: "button", "data-id": "bfw-start", onclick: start }, L("Start update", "开始更新"));
  const abortBtn = h("button", { class: "btn", type: "button", "data-id": "bfw-abort", onclick: () => { U.abortAsked = true; } }, L("Abort", "中止"));
  const nowOut = h("p", { class: "row-note fw-note" });
  const chunkOut = h("p", { class: "row-note fw-note" });

  function draw() {
    const B = board();
    if (U.raw && !U.running && U.checkedFor !== targetKey()) recheck();
    boardBanner(banner);
    const pending = !!(B && (B.flags & SC.FLAG.IMAGE_PENDING));
    const t = target();
    const can = t ? SC.CAN_NAMES[t.can] || t.can : "?";
    nowOut.textContent = !B ? L("Connect to a BLE board first (Car tab).", "请先连接BLE模块（车辆页）。")
      : L(`The board is ${SC.boardName(B.info)} (${t ? t.id : "?"}, ${t ? t.chip : "?"}, CAN ${can}). It runs ${B.info && B.info.fw ? B.info.fw : "?"} (build ${B.info && B.info.build ? B.info.build : "?"}).`,
        `模块为 ${SC.boardName(B.info, true)}（${t ? t.id : "?"}，${t ? t.chip : "?"}，CAN ${can}），运行 ${B.info && B.info.fw ? B.info.fw : "?"}（构建 ${B.info && B.info.build ? B.info.build : "?"}）。`);
    chunkOut.textContent = S.link && isH2() ? L(`Bytes per write: ${S.link.chunk}. The page cannot read the link limit. After a cut write it uses the next smaller size. You can set it in Device > Bytes per BLE write.`,
      `每次写入：${S.link.chunk} 字节。页面无法读取链路上限。写入被截断后会改用更小的值。可在「设备 > 每次写入字节数」中设置。`) : "";
    imgOut.className = "out" + (U.errors.length ? " bad" : U.warnings.length ? " warn" : "");
    const ii = U.image && U.image.info;
    imgOut.textContent = U.errors.length ? U.errors.join("\n")
      : ii ? `${ii.project} ${ii.version}, ${L("built", "构建于")} ${ii.built}, ESP-IDF ${ii.idf}\n`
        + `${L("Board", "模块")} ${ii.board} (${ii.chip}, CAN ${SC.CAN_NAMES[ii.can] || ii.can})\n`
        + `${U.image.bytes.length} ${L("bytes", "字节")}, SHA-256 ${SC.hex(U.image.sha).slice(0, 16)}...`
        + (U.warnings.length ? `\n\n${U.warnings.join("\n")}` : "")
        + (!B ? `\n${L("Connect to the board: the app then checks the image against it.", "请连接模块：应用会再按该模块检查固件。")}` : "")
        : "";
    prog.hidden = !U.running;
    prog.max = U.size || 1; prog.value = U.sent;
    msgOut.className = "out " + U.tone;
    msgOut.textContent = pending && !U.running && !U.text ? L("Confirm the running image first (see the warning above).", "请先确认正在运行的固件（见上方提示）。") : U.text;
    startBtn.disabled = !B || !U.image || U.running || pending;
    abortBtn.hidden = !(U.running && U.canAbort);
    fileIn.disabled = U.running;
  }

  clear(el).append(
    banner,
    h("div", { class: "sec-label" }, L("Board firmware", "模块固件")),
    h("div", { class: "card" },
      h("div", { class: "form" }, nowOut,
        h("p", { class: "row-note fw-note" }, L("Park the car and keep it awake. After the update the board restarts. The app connects again by itself. Then confirm the new image within 10 minutes, or the board goes back to the old image.",
          "请停好车并保持唤醒。更新后模块会重启，应用会自动重新连接。请在10分钟内确认新固件，否则模块会回退到旧固件。")))),
    h("div", { class: "sec-label" }, L("1. Image file", "1. 固件文件")),
    h("div", { class: "card" }, h("div", { class: "form" }, fileIn, imgOut,
      h("p", { class: "row-note fw-note" }, L("The file is scrl-<build>.bin from build/out of the firmware build (tools/build-boards.sh), for the board that is connected. Not the -full.bin file. The app checks it before it sends a byte.", "文件为固件编译（tools/build-boards.sh）在 build/out 中生成的 scrl-<build>.bin，须与所连模块一致。不要用 -full.bin 文件。发送前应用会先检查文件。")))),
    h("div", { class: "sec-label" }, L("2. Update", "2. 更新")),
    h("div", { class: "card" }, h("div", { class: "form" }, h("div", { class: "btns" }, startBtn, abortBtn), prog, msgOut, chunkOut)),
    h("p", { class: "sec-foot" }, h("button", { class: "linkish", type: "button", onclick: () => switchTab("status") }, icon("chevron-left", 16), L("Car tab", "车辆页"))));

  const offs = [];
  redraw = draw;
  draw();
  return {
    el, title: { en: "Board firmware", zh: "模块固件" },
    refresh: draw,
    enter() { redraw = draw; offs.push(onBus("board", draw)); offs.push(onBus("conn", draw)); },
    leave() { offs.splice(0).forEach(f => f()); },
  };
});
